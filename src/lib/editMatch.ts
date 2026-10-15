/**
 * Moteur de matching texte pour l'édition de fichiers par l'agent.
 *
 * Porté depuis le SDK Cline (`extensions/tools/executors/apply-patch-parser.ts`),
 * dont la force est de faire correspondre un bloc `old_text` émis par un modèle
 * — souvent imparfait — au contenu réel du fichier, plutôt que d'échouer ou de
 * modifier la mauvaise occurrence.
 *
 * Stratégie de correspondance, du plus strict au plus permissif :
 *   1. exact                (fuzz 0)
 *   2. trimEnd par ligne    (fuzz 1)
 *   3. trim complet         (fuzz 100)
 *   4. similarité ≥ 0.66    (fuzz 1000, avec score remonté)
 *
 * Pourquoi : les modèles produisent régulièrement des espaces en fin de ligne,
 * une indentation légèrement différente, ou des « smart quotes » / tirets
 * typographiques. Sans cette tolérance, chaque édition approximative échoue et
 * l'agent boucle. Le `fuzz` remonté permet de signaler à l'utilisateur (et au
 * modèle) que la correspondance n'était PAS exacte — donc potentiellement
 * risquée à l'endroit d'un vrai fichier.
 *
 * Ce module est pur (aucun I/O) et donc directement testable.
 */

/** Résultat d'une tentative de correspondance. */
export interface TextMatch {
  /** Index du début de la correspondance dans le contenu (en unités UTF-16). */
  index: number;
  /** Longueur du texte réellement remplacé (peut différer de la longueur de `needle`). */
  length: number;
  /**
   * Facteur de tolérance : 0 = exact. Plus il est élevé, plus la
   * correspondance s'éloigne du texte recherché. > 0 ⇒ prévenir l'utilisateur.
   */
  fuzz: number;
  /** Score de similarité [0, 1] pour les correspondances approximatives. */
  similarity: number;
}

export type MatchOutcome =
  | { kind: "match"; match: TextMatch }
  | { kind: "not_found"; bestSimilarity: number }
  | { kind: "ambiguous"; occurrences: number };

/**
 * Table de normalisation des caractères « typographiques » que les modèles
 * émettent à la place des caractères ASCII. Sans elle, un simple tiret
 * em-dash (`—`) ou un guillemet courbe casse toute correspondance exacte.
 * Reprise de la `punctuationMap` de Cline.
 */
const PUNCTUATION_MAP: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u00AB": '"',
  "\u00BB": '"',
  "\u2018": "'",
  "\u2019": "'",
  "\u201B": "'",
  "\u00A0": " ",
  "\u202F": " ",
};

/**
 * Normalise un texte pour comparaison : NFC, ponctuation typographique → ASCII,
 * échappements de backticks/guillemets retirés.
 */
export function canonicalize(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[\s\S]/gu, (char) => PUNCTUATION_MAP[char] ?? char)
    .replace(/\\`/g, "`")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

/** Distance de Levenshtein classique (itératif, O(n·m) mémoire linéaire). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Similarité [0, 1] basée sur la distance de Levenshtein. */
export function similarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  return (longer.length - levenshteinDistance(shorter, longer)) / longer.length;
}

/** Seuil en dessous duquel on refuse d'appliquer une correspondance approximative. */
export const SIMILARITY_THRESHOLD = 0.66;

/**
 * Trouve toutes les positions exactes d'un `needle` non vide dans `haystack`.
 * (Petit utilitaire local ; on évite `split` pour rester linéaire.)
 */
function findAllIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + Math.max(1, needle.length);
  }
  return out;
}

/**
 * Cherche `needle` dans `haystack` en appliquant la stratégie à 4 niveaux.
 *
 * Règles d'ambiguïté : si `needle` correspond plusieurs fois au niveau 1, on
 * refuse (`ambiguous`) — appliquer une édition à une occurrence arbitraire est
 * pire que d'échouer. Les niveaux flous ne s'appliquent que si le niveau 1 n'a
 * trouvé AUCUNE correspondance.
 */
export function findTextMatch(haystack: string, needle: string): MatchOutcome {
  if (needle.length === 0) {
    return { kind: "not_found", bestSimilarity: 0 };
  }

  // ── Niveau 1 : exact ──────────────────────────────────────────────────────
  const exact = findAllIndexes(haystack, needle);
  if (exact.length === 1) {
    return { kind: "match", match: { index: exact[0], length: needle.length, fuzz: 0, similarity: 1 } };
  }
  if (exact.length > 1) {
    return { kind: "ambiguous", occurrences: exact.length };
  }

  const canonNeedle = canonicalize(needle);

  // ── Niveau 2 : exact après canonicalisation ──────────────────────────────
  if (canonNeedle !== needle) {
    const canonHit = findCanonicalMatch(haystack, canonNeedle, (s) => s);
    if (canonHit) {
      return { kind: "match", match: { ...canonHit, fuzz: canonHit.fuzz + 1 } };
    }
  }

  // ── Niveau 3 : trimEnd par ligne ─────────────────────────────────────────
  const trimmedEndNeedle = canonicalize(needle.split("\n").map((l) => l.trimEnd()).join("\n"));
  const trimEndHit = findLinewiseMatch(haystack, trimmedEndNeedle, (l) => l.trimEnd());
  if (trimEndHit) {
    return { kind: "match", match: { ...trimEndHit, fuzz: 100 } };
  }

  // ── Niveau 4 : trim complet par ligne ────────────────────────────────────
  const trimmedNeedle = canonicalize(needle.split("\n").map((l) => l.trim()).join("\n"));
  const trimHit = findLinewiseMatch(haystack, trimmedNeedle, (l) => l.trim());
  if (trimHit) {
    return { kind: "match", match: { ...trimHit, fuzz: 1000 } };
  }

  // ── Niveau 5 : similarité Levenshtein sur fenêtres glissantes ────────────
  const fuzzy = findFuzzyMatch(haystack, needle);
  if (fuzzy) {
    return { kind: "match", match: fuzzy };
  }

  return { kind: "not_found", bestSimilarity: fuzzy === null ? bestWindowSimilarity(haystack, needle) : 0 };
}

/** Correspondance canonique directe (mêmes bornes que le texte original). */
function findCanonicalMatch(
  haystack: string,
  canonNeedle: string,
  _t: (s: string) => string,
): { index: number; length: number; fuzz: number; similarity: number } | null {
  // On ne peut pas indexer sur la version canonicalisée sans casser les offsets
  // (les remplacements Unicode changent parfois la longueur en unités UTF-16).
  // Stratégie pragmatique : on balaie ligne par ligne en comparant les formes
  // canonicalisées, puis on reconstruit l'offset réel.
  const hayLines = splitLinesWithOffsets(haystack);
  const needleLines = canonNeedle.split("\n");
  return matchLines(hayLines, needleLines, (l) => canonicalize(l));
}

interface LineWithOffset {
  text: string;
  start: number;
}

/** Découpe en lignes en conservant l'offset absolu de chaque ligne. */
function splitLinesWithOffsets(text: string): LineWithOffset[] {
  const out: LineWithOffset[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  out.push({ text: text.slice(start), start });
  return out;
}

/**
 * Cherche une séquence de lignes correspondant à `needleLines` après
 * application de `normalize` à chaque ligne. Refuse les correspondances
 * multiples (ambiguïté).
 */
function matchLines(
  hayLines: LineWithOffset[],
  needleLines: string[],
  normalize: (line: string) => string,
): { index: number; length: number; fuzz: number; similarity: number } | null {
  const normalizedNeedle = needleLines.map(normalize).join("\n");
  const hits: number[] = [];

  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    const window = hayLines
      .slice(i, i + needleLines.length)
      .map((l) => normalize(l.text))
      .join("\n");
    if (window === normalizedNeedle) hits.push(i);
    if (hits.length > 1) return null; // ambigu ⇒ on refuse ce niveau
  }
  if (hits.length !== 1) return null;

  const startLine = hits[0];
  const first = hayLines[startLine];
  const last = hayLines[startLine + needleLines.length - 1];
  const index = first.start;
  const length = last.start + last.text.length - index;
  return { index, length, fuzz: 0, similarity: 1 };
}

/** Comme `matchLines`, mais en normalisant aussi le `needle` en amont. */
function findLinewiseMatch(
  haystack: string,
  normalizedNeedle: string,
  normalize: (line: string) => string,
): { index: number; length: number; fuzz: number; similarity: number } | null {
  const hit = matchLines(splitLinesWithOffsets(haystack), normalizedNeedle.split("\n"), (l) =>
    canonicalize(normalize(l)),
  );
  if (hit) return hit;
  return null;
}

/** Meilleure similarité atteignable (pour le message d'échec). */
function bestWindowSimilarity(haystack: string, needle: string): number {
  const hayLines = splitLinesWithOffsets(haystack);
  const needleLines = needle.split("\n");
  const canonNeedle = canonicalize(needleLines.join("\n"));
  let best = 0;
  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    const window = canonicalize(
      hayLines.slice(i, i + needleLines.length).map((l) => l.text).join("\n"),
    );
    const s = similarity(window, canonNeedle);
    if (s > best) best = s;
  }
  return best;
}

/** Dernier recours : meilleure fenêtre au-dessus du seuil de similarité. */
function findFuzzyMatch(haystack: string, needle: string): TextMatch | null {
  const hayLines = splitLinesWithOffsets(haystack);
  const needleLines = needle.split("\n");
  const canonNeedle = canonicalize(needleLines.join("\n"));

  let best: { index: number; length: number; similarity: number } | null = null;

  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    const windowLines = hayLines.slice(i, i + needleLines.length);
    const window = canonicalize(windowLines.map((l) => l.text).join("\n"));
    const s = similarity(window, canonNeedle);
    if (s >= SIMILARITY_THRESHOLD && (best === null || s > best.similarity)) {
      const first = windowLines[0];
      const last = windowLines[windowLines.length - 1];
      best = {
        index: first.start,
        length: last.start + last.text.length - first.start,
        similarity: s,
      };
    }
  }

  if (!best) return null;
  return { index: best.index, length: best.length, fuzz: 1000, similarity: best.similarity };
}

/**
 * Applique une édition : remplace la zone trouvée par `replacement`.
 * Retourne le nouveau contenu + les métadonnées de correspondance, ou une
 * raison d'échec exploitable par l'appelant (qui produira un message
 * actionnable pour le modèle).
 */
export function replaceText(
  haystack: string,
  needle: string,
  replacement: string,
): { ok: true; content: string; fuzz: number; similarity: number } | { ok: false; outcome: Exclude<MatchOutcome, { kind: "match" }> } {
  const outcome = findTextMatch(haystack, needle);
  if (outcome.kind !== "match") return { ok: false, outcome };

  const { index, length, fuzz, similarity: sim } = outcome.match;
  const content = haystack.slice(0, index) + replacement + haystack.slice(index + length);
  return { ok: true, content, fuzz, similarity: sim };
}
