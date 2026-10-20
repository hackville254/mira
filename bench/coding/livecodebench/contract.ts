// ── LiveCodeBench — contrat de sortie de CHAQUE problème ─────────────────────
//
// POURQUOI CE MODULE
// ------------------
// LiveCodeBench contient DEUX conventions de sortie incompatibles :
//
//   1. `functional` (LeetCode, …)
//      Le `starter_code` déclare `class Solution` ; les cas de test sont des
//      arguments sérialisés. On appelle `Solution().<method>(*args)` et on
//      compare la valeur de retour.
//
//   2. `stdin` (AtCoder, Codeforces, …)
//      Le `starter_code` est VIDE (ou ne déclare aucune classe) ; les cas sont
//      du texte brut. Le protocole officiel attend un PROGRAMME COMPLET qui lit
//      `sys.stdin` et écrit sur `sys.stdout`, comparé ligne à ligne.
//
// L'ancien évaluateur imposait `Solution().<method>()` à TOUS les problèmes.
// Résultat : les 6 AtCoder échouaient sur `import: cannot import name 'Solution'`
// — un ÉCHEC DE FORMAT comptabilisé à tort comme un échec du modèle. C'est
// exactement ce que la mission interdit (« les erreurs de format peuvent masquer
// les capacités réelles »).
//
// Ce module ne devine RIEN : il s'appuie sur des faits observables du problème
// (`platform`, présence de `class Solution` / d'une signature `def` dans le
// `starter_code`) et, en dernier recours seulement, sur la forme des cas.
//
// CAS INTERACTIF : `abc337_e` (AtCoder) est un problème INTERACTIF (le juge
// répond au programme). Il n'est pas évaluable avec des cas hors ligne : on le
// déclare explicitement `interactive` pour l'EXCLURE de façon visible plutôt que
// de le compter comme un échec du modèle.

import type { LcbInstance, LcbTestCase } from "./instance";

/** Contrat de sortie attendu par un problème LiveCodeBench. */
export type LcbContract =
  /** Appeler `Solution().<method>(*args)` et comparer la valeur de retour. */
  | "functional"
  /** Exécuter un programme complet : stdin brut → stdout comparé ligne à ligne. */
  | "stdin"
  /** Problème interactif : non évaluable hors ligne, exclu explicitement. */
  | "interactive";

/** Détecte si un énoncé décrit un problème interactif. */
export function isInteractive(inst: LcbInstance): boolean {
  const text = `${inst.question_title}\n${inst.question_content}`.toLowerCase();
  return /interactive problem|this is an interactive|interact with the judge|adaptive judge/.test(text);
}

/**
 * Détermine le contrat d'un problème à partir de faits observables.
 * Priorité : interactif > classe `Solution` déclarée > starter vide ⇒ stdin >
 * heuristique sur la forme des cas.
 */
export function detectContract(inst: LcbInstance): LcbContract {
  if (isInteractive(inst)) return "interactive";

  const starter = inst.starter_code ?? "";
  // Une classe `Solution` explicite ⇒ contrat fonctionnel (LeetCode).
  if (/class\s+Solution\b/.test(starter)) return "functional";

  // AtCoder/Codeforces : starter vide ⇒ programme complet sur stdin.
  const platform = (inst.platform ?? "").toLowerCase();
  if (platform === "atcoder" || platform === "codeforces") {
    return starter.trim() === "" ? "stdin" : "stdin";
  }

  // Starter non vide mais sans `class Solution` : s'il déclare une fonction
  // unique, le protocole officiel l'invoque en fonctionnel.
  if (starter.trim() !== "" && /^\s*def\s+\w+/m.test(starter)) return "functional";

  // Dernier recours : si aucun cas ne ressemble à un littéral Python (donc
  // plutôt du texte brut multi-lignes), on considère stdin.
  if (looksLikeRawText(inst.cases)) return "stdin";

  return "functional";
}

/** Vrai si l'entrée ne ressemble PAS à des arguments littéraux Python. */
function looksLikeRawText(cases: LcbTestCase[]): boolean {
  if (cases.length === 0) return false;
  for (const c of cases.slice(0, 3)) {
    const lines = c.input.split("\n").filter(l => l.trim() !== "");
    if (lines.length === 0) return false;
    // Des mots nus (`hello2023`, `U`, `R`) ne sont pas des littéraux Python.
    const allLiterals = lines.every(l => {
      const t = l.trim();
      try {
        // eslint-disable-next-line no-new-func
        JSON.parse(t);
        return true;
      } catch {
        return /^[+-]?\d+(\.\d+)?$/.test(t) || /^[[({].*[\]})]$/.test(t);
      }
    });
    if (!allLiterals) return true;
  }
  return false;
}

/**
 * Normalise une sortie pour comparaison ligne à ligne à la manière des juges :
 * on ignore les espaces superflics en fin de ligne et les lignes vides finales.
 * C'est la convention usuelle des juges de type AtCoder.
 */
export function normalizeJudgeOutput(s: string): string {
  const lines = s.replace(/\r\n/g, "\n").split("\n").map(l => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Vrai si la sortie observée est acceptée par le juge pour la sortie attendue. */
export function judgeEqual(got: string, want: string): boolean {
  return normalizeJudgeOutput(got) === normalizeJudgeOutput(want);
}
