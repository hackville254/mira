// ── LiveCodeBench — chargement, filtre de contamination et évaluation ─────────
//
// LiveCodeBench évalue la GÉNÉRATION de code sur des problèmes de concours
// (LeetCode, Codeforces, AtCoder) datés. Le protocole officiel :
//   1. l'agent produit UNE solution complète pour chacun des problèmes ;
//   2. on exécute cette solution CONTRE les tests publics ET privés ;
//   3. on ne compte « résolu » que si TOUS les cas passent.
//
// CONTRAINTES DE SÉCURITÉ (code non fiable = code généré par un LLM) :
//   - l'exécution se fait dans un conteneur ISOLÉ (réseau coupé, timeout dur,
//     limites mémoire/CPU, utilisateur non root) — JAMAIS sur l'hôte ;
//   - le code de l'agent n'a accès à AUCUN secret et n'écrit nulle part hors de
//     son dossier de travail monté en lecture-écriture ;
//   - on ne fait jamais confiance à la sortie : la notation lit uniquement le
//     code de sortie du harnais Python qui compare les résultats.
//
// Ce module est Node (charge le dataset, prépare/évalue) : il ne tourne PAS
// dans la webview. Le pilotage de l'agent, lui, se fait depuis la webview
// (cf. benchWebview.ts), car les outils de production passent par `invoke`.

import { readFile } from "node:fs/promises";

/** Un cas de test LiveCodeBench (`input` / `output` sont du texte brut, parfois JSON). */
export interface LcbTestCase {
  input: string;
  output: string;
  /** Vrai si le cas provient de `private_test_cases` (défaut : public). */
  hidden?: boolean;
}

/**
 * Un problème LiveCodeBench normalisé. Le payload brut du dataset est conservé
 * tel quel pour la traçabilité ; `cases` est la vue agrégée publique+privée
 * réellement utilisée par l'évaluateur.
 */
export interface LcbInstance {
  question_id: string;
  question_title: string;
  question_content: string;
  platform: string;
  contest_id: string;
  /** Date ISO du concours — sert au filtre anti-contamination. */
  contest_date: string;
  difficulty: string;
  starter_code: string;
  /** Cas publics + privés fusionnés (les privés portent `hidden: true`). */
  cases: LcbTestCase[];
}

/** Forme brute d'une ligne de `test.jsonl` (on ne dépend que des champs utiles). */
interface RawLcbRow {
  question_id: string;
  question_title?: string;
  question_content?: string;
  platform?: string;
  contest_id?: string;
  contest_date?: string;
  difficulty?: string;
  starter_code?: string;
  public_test_cases?: string;
  private_test_cases?: string;
}

/**
 * Décode un champ de tests LiveCodeBench au format JSON.
 *
 * NOTE SÉCURITÉ IMPORTANTE : dans le dataset officiel, `private_test_cases` n'est
 * PAS du JSON direct — c'est `base64(zlib(pickle(<JSON>)))`. Décoder du `pickle`
 * en Node/agent serait DANGEREUX (exécution de code à la désérialisation), donc
 * ce module ne le fait JAMAIS : on consomme uniquement le JSON pur produit hors
 * ligne par `extract_cases.py` (cf. ce dossier), qui valide les opcodes du
 * pickle avant toute lecture.
 *
 * Cette fonction n'accepte donc QUE du JSON. Si un payload encodé arrive ici,
 * le problème est EXCLU (fail-safe : jamais compté comme réussi) — un problème
 * sans cas exploitables ne peut pas être noté.
 */
function parseCases(raw: string | undefined, hidden: boolean): LcbTestCase[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Payload non-JSON (probablement un champ encodé/compressé) : refusé sans
    // tentative de décodage risquée. `extract_cases.py` doit être utilisé.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c): c is { input: unknown; output: unknown } =>
      !!c && typeof c === "object" && "input" in c && "output" in c)
    .map(c => ({
      input: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
      output: typeof c.output === "string" ? c.output : JSON.stringify(c.output),
      hidden,
    }));
}

/** Normalise une ligne brute en `LcbInstance`. */
export function toInstance(row: RawLcbRow): LcbInstance {
  if (!row.question_id) throw new Error("ligne LiveCodeBench sans question_id");
  return {
    question_id: row.question_id,
    question_title: row.question_title ?? "",
    question_content: row.question_content ?? "",
    platform: row.platform ?? "unknown",
    contest_id: row.contest_id ?? "",
    contest_date: row.contest_date ?? "",
    difficulty: row.difficulty ?? "unknown",
    starter_code: row.starter_code ?? "",
    cases: [
      ...parseCases(row.public_test_cases, false),
      ...parseCases(row.private_test_cases, true),
    ],
  };
}

/**
 * Charge les problèmes depuis un fichier `jsonl` du dataset LiveCodeBench et
 * applique les filtres du protocole :
 *   - `since` / `until` : borne de `contest_date` (filtre ANTI-CONTAMINATION —
 *     on n'évalue que des concours POSTÉRIEURS à la coupure de connaissance du
 *     modèle visé) ;
 *   - `platforms` : restreindre à certaines plateformes ;
 *   - les problèmes sans AUCUN cas de test sont EXCLUS (non évaluables).
 */
export async function loadInstances(
  path: string,
  opts: { since?: string; until?: string; platforms?: string[]; limit?: number } = {},
): Promise<LcbInstance[]> {
  const text = await readFile(path, "utf8");
  const out: LcbInstance[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: RawLcbRow;
    try {
      row = JSON.parse(t) as RawLcbRow;
    } catch {
      continue; // ligne corrompue : on saute, jamais de crash du banc.
    }
    const inst = toInstance(row);
    if (opts.since && inst.contest_date && inst.contest_date < opts.since) continue;
    if (opts.until && inst.contest_date && inst.contest_date > opts.until) continue;
    if (opts.platforms && opts.platforms.length > 0 && !opts.platforms.includes(inst.platform)) continue;
    if (inst.cases.length === 0) continue;
    out.push(inst);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/** Valide la forme d'une instance chargée (utilisé par les tests et la CLI). */
export function validateInstance(inst: LcbInstance): void {
  if (!inst.question_id) throw new Error("question_id manquant");
  if (inst.cases.length === 0) throw new Error(`${inst.question_id} : aucun cas de test`);
}

/** Forme du JSON produit par `extract_cases.py` (cas déjà décodés, sûrs). */
export interface LcbPayload {
  generated_at?: string;
  source?: string;
  filters?: Record<string, unknown>;
  stats?: Record<string, number>;
  problems: Array<{
    question_id: string;
    question_title?: string;
    question_content?: string;
    platform?: string;
    contest_id?: string;
    contest_date?: string;
    difficulty?: string;
    starter_code?: string;
    caseCount?: number;
  }>;
  cases: Record<string, Array<{ input: string; output: string; hidden?: boolean }>>;
}

/**
 * Charge un payload LiveCodeBench DÉJÀ EXTRAIT (JSON pur produit par
 * `extract_cases.py`). C'est le chemin RECOMMANDÉ : aucune donnée encodée
 * (base64/zlib/pickle) n'est jamais décodée dans le processus Node/agent.
 */
export async function loadPayload(path: string): Promise<LcbPayload> {
  const text = await readFile(path, "utf8");
  const payload = JSON.parse(text) as LcbPayload;
  if (!payload.problems || !payload.cases) {
    throw new Error("payload LiveCodeBench invalide (problems/cases manquants)");
  }
  return payload;
}

/** Convertit une entrée `problems[]` + `cases{}` du payload en `LcbInstance`. */
export function payloadToInstance(
  problem: LcbPayload["problems"][number],
  cases: LcbPayload["cases"][string],
): LcbInstance {
  return {
    question_id: problem.question_id,
    question_title: problem.question_title ?? "",
    question_content: problem.question_content ?? "",
    platform: problem.platform ?? "unknown",
    contest_id: problem.contest_id ?? "",
    contest_date: problem.contest_date ?? "",
    difficulty: problem.difficulty ?? "unknown",
    starter_code: problem.starter_code ?? "",
    cases: (cases ?? []).map(c => ({ input: c.input, output: c.output, hidden: c.hidden === true })),
  };
}
