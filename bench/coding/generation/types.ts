// ── Génération de fonctions (EvalPlus) — contrat de tâche et de résultat ───────
//
// Ce module définit le format VERSIONNÉ d'une tâche HumanEval+ / MBPP+ et le
// format de son résultat. Il est volontairement indépendant de Tauri : le
// runner peut tourner en Node pur, en CI, sans UI.
//
// HONNÊTETÉ MÉTHODOLOGIQUE
// ------------------------
//  - Un score obtenu sur un SOUS-ENSEMBLE est TOUJOURS étiqueté comme tel
//    (`subset: true`, `subsetSize`, `datasetVersion`). On ne présente jamais un
//    sous-ensemble comme le score complet du benchmark.
//  - Le mode d'évaluation est explicite (`evalMode`) : `model-only` mesure le
//    MODÈLE seul (prompt + HTTP standardisés, aucun outil) ; `agent` mesure le
//    SYSTÈME ORVYX Code complet (moteur Cline, outils, vérification).
//  - Toute erreur est VENTILÉE par origine (`errorClass`). Une erreur du
//    fournisseur (HTTP/429/timeout) n'est JAMAIS classée comme une erreur du
//    modèle.
//  - Les valeurs indisponibles restent `undefined` (jamais 0, jamais inventées).

/** Les deux familles EvalPlus supportées. */
export type GenerationBenchmark = "humanevalplus" | "mbppplus";

/** Mode d'évaluation — sépare explicitement modèle et harness (Phase 3). */
export type EvalMode = "model-only" | "agent";

/**
 * Origine d'un échec. Permet de distinguer ce qui relève du MODÈLE de ce qui
 * relève du FOURNISSEUR, du HARNAIS ou de l'outillage.
 */
export type ErrorClass =
  | "model"        // le modèle a répondu mais le code est faux (échec de tests)
  | "provider"     // erreur HTTP du fournisseur (429, 5xx, réseau)
  | "timeout"      // délai dépassé côté agent ou côté notation
  | "truncated"    // réponse incomplète (finish_reason=length, streaming coupé)
  | "orchestration"// l'agent n'a pas su mener la tâche à terme (boucle, limite de tours)
  | "tool"         // un outil du harness a échoué
  | "harness"      // erreur du harnais lui-même (Docker, parsing du dataset…)
  | "no-output";   // le modèle/agent n'a produit aucun texte exploitable

/** Une tâche de génération de fonction, chargée depuis un dataset RÉEL. */
export interface GenerationTask {
  /** Identifiant stable du dataset (`HumanEval/0`, `MBPP/2`). */
  taskId: string;
  /** Famille de benchmark. */
  benchmark: GenerationBenchmark;
  /** Version explicite du dataset (jamais implicite). */
  datasetVersion: string;
  /** Énoncé donné au modèle (signature + docstring pour HumanEval). */
  prompt: string;
  /** Nom du point d'entrée attendu (HumanEval). */
  entryPoint: string;
  /**
   * Programme de test OFFICIEL EvalPlus : contient la fonction `check(candidate)`
   * et, à sa fin, `check(<entry_point>)` qui exécute les tests étendus.
   */
  test: string;
  /** Imports supplémentaires nécessaires à l'exécution (MBPP+). */
  testImports: string[];
}

/** Résultat vérifiable d'un cas de test (ici : le programme EvalPlus complet). */
export interface CaseOutcome {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Métriques observées sur un run (aucune estimation). */
export interface GenerationMetrics {
  /** Temps total du run (ms). */
  totalMs: number;
  /** Temps de génération seul (ms) — agent ou HTTP. */
  generationMs: number;
  /** Durée de la notation Docker (ms). */
  evalMs: number;
  /** Nombre d'appels/d'itérations au modèle observés. */
  modelCalls: number;
  /** Nombre d'appels d'outils observés (0 en model-only). */
  toolCalls: number;
  /** Délai jusqu'au premier token (ms), si observable. */
  ttftMs?: number;
  /** Tokens d'entrée, si le fournisseur les expose. */
  inputTokens?: number;
  /** Tokens de sortie, si le fournisseur les expose. */
  outputTokens?: number;
}

/** Résultat complet d'une tentative de génération. */
export interface GenerationAttempt {
  taskId: string;
  benchmark: GenerationBenchmark;
  datasetVersion: string;
  /** Mode : modèle seul ou système complet. */
  evalMode: EvalMode;
  /** Identifiant du modèle évalué (jamais une clé API). */
  modelId: string;
  /** Fournisseur (libellé public). */
  provider: string;
  /** Numéro de répétition (1-based). */
  run: number;
  /** Vrai si cette tentative porte sur un SOUS-ENSEMBLE du benchmark. */
  subset: boolean;
  /** Vrai si le code produit compile/passe les tests étendus EvalPlus. */
  resolved: boolean;
  /** Ventilation de l'origine de l'échec (`undefined` si résolu). */
  errorClass?: ErrorClass;
  /** Message d'erreur borné (jamais de secret). */
  error?: string;
  /** Statut HTTP du fournisseur, si pertinent. */
  httpStatus?: number;
  metrics: GenerationMetrics;
  /** Code brut produit (borné) — utile au diagnostic, jamais présenté comme score. */
  code?: string;
}

/** Format VERSIONNÉ des lignes JSONL de résultats. */
export interface GenerationResultLine {
  schemaVersion: 1;
  /** Horodatage ISO de production de la ligne. */
  recordedAt: string;
  attempt: GenerationAttempt;
}

/** Suffixe de version du schéma JSONL. */
export const GENERATION_SCHEMA_VERSION = 1;

/** Nom de fichier JSONL canonique par (benchmark, mode). */
export function resultsFileName(benchmark: GenerationBenchmark, mode: EvalMode): string {
  const b = benchmark === "humanevalplus" ? "humanevalplus" : "mbppplus";
  const m = mode === "model-only" ? "modelonly" : "agent";
  return `${b}-${m}.jsonl`;
}
