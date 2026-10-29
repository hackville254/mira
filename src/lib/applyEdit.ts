import { findTextMatch, replaceText, type MatchOutcome } from "./editMatch";

/** Raisons d'échec possibles d'une édition (dérivées du moteur de matching). */
export type EditFailure =
  | Exclude<MatchOutcome, { kind: "match" }>
  | { kind: "empty_original" };

/**
 * Applique une édition `original → updated` sur `fileContent`.
 *
 * Rétrocompatible : renvoie le nouveau contenu ou `null` si introuvable.
 * Utilise le moteur de correspondance tolérant de `./editMatch` (voir ce fichier
 * pour la stratégie exact / trimEnd / trim / similarité).
 *
 * ⚠️ Refuse les correspondances ambiguës (plusieurs occurrences) : renvoie
 * `null` plutôt que d'éditer une occurrence arbitraire. Pour obtenir le détail
 * (fuzz, similarité, ambiguïté), préfère `applyEditDetailed`.
 */
export function applyEdit(fileContent: string, original: string, updated: string): string | null {
  const res = replaceText(fileContent, original, updated);
  return res.ok ? res.content : null;
}

export type EditResult =
  | { ok: true; content: string; fuzz: number; similarity: number }
  | { ok: false; outcome: EditFailure };

/**
 * Variante détaillée : expose le `fuzz` (0 = correspondance exacte) et la
 * raison d'échec, pour construire un message actionnable destiné au modèle.
 */
export function applyEditDetailed(fileContent: string, original: string, updated: string): EditResult {
  if (original.length === 0) {
    return { ok: false, outcome: { kind: "empty_original" } };
  }
  return replaceText(fileContent, original, updated);
}

/** Exposé pour les tests et les appelants qui veulent le diagnostic brut. */
export { findTextMatch };

/**
 * Construit un message d'erreur ACTIONNABLE à partir du résultat d'échec.
 *
 * Porté de Cline (`editor.ts`) : un simple « not found » pousse le modèle à
 * renvoyer le MÊME appel à l'identique, créant une boucle stérile. Le message
 * doit donc expliquer pourquoi ça a échoué ET dicter la prochaine action.
 */
export function describeEditFailure(path: string, outcome: EditFailure): string {
  if (outcome.kind === "empty_original") {
    return `old_string was empty. Provide the exact text to replace, or use write_file to create the file. Do not re-send this call unchanged.`;
  }
  if (outcome.kind === "ambiguous") {
    return (
      `old_string appears ${outcome.occurrences} times in ${path}, so the edit is ambiguous and was refused. ` +
      `Extend old_string with surrounding lines so it matches exactly once, then call edit again with the longer snippet.`
    );
  }
  const pct = Math.round(outcome.bestSimilarity * 100);
  return (
    `old_string was not found in ${path} (closest match was only ${pct}% similar, below the 66% threshold). ` +
    `Read the file first, then copy the exact current text verbatim — do not paraphrase or re-indent it. ` +
    `Do not re-send this call unchanged.`
  );
}

