// ── Benchmark de codage — contrat de tâche et de résultat ──────────────────────
//
// Ce module définit le format VERSIONNÉ d'une tâche de codage reproductible et
// le format de son résultat. Il est volontairement indépendant de Tauri : une
// tâche décrit un dépôt initial (fixture), une instruction, et des critères de
// réussite VÉRIFIABLES par des tests (format inspiré de SWE-bench :
// FAIL_TO_PASS = tests qui doivent ÉCHOUER avant et RÉUSSIR après ;
// PASS_TO_PASS = tests qui doivent réussir AVANT et APRÈS).
//
// ATTENTION : ce harnais n'est PAS le moteur de production. Il ne remplace
// aucun outil réel ; il fournit un environnement isolé et un exécuteur de
// commandes pour mesurer la capacité de l'agent à réaliser de vraies tâches.
// Aucun score « SWE-bench officiel » ne peut en être déduit sans respecter le
// protocole complet de SWE-bench (images Docker, harness officiel).

/** Critères de réussite objectifs — indépendants du modèle évalué. */
export interface TaskCriteria {
  /**
   * Tests qui DOIVENT échouer sur l'état initial puis réussir après la
   * modification. Le nom identifie le fichier/regex de test dans la fixture.
   */
  failToPass: string[];
  /** Tests qui doivent réussir AVANT et APRÈS (garde anti-régression). */
  passToPass: string[];
}

/** Une tâche de codage reproductible. */
export interface CodingTask {
  /** Identifiant stable, unique, utilisé comme nom de dossier de fixture. */
  id: string;
  /** Titre court lisible. */
  title: string;
  /** Catégorie (cf. liste de la mission : bugfix, refactor, feature…). */
  kind: TaskCategory;
  /** Instruction EXACTE donnée à l'agent — identique pour tous les modèles. */
  instruction: string;
  /**
   * Commande de test lancée par l'évaluateur dans le dépôt isolé. Doit sortir
   * en code 0 si et seulement si les tests passent.
   */
  testCommand: string;
  /** Critères de réussite. */
  criteria: TaskCriteria;
  /** Timeout (ms) de la tentative d'agent. */
  agentTimeoutMs: number;
  /** Timeout (ms) de la commande de test. */
  testTimeoutMs: number;
  /** Budget de tokens (facultatif — appliqué par le driver si supporté). */
  tokenBudget?: number;
}

export type TaskCategory =
  | "bugfix"          // corriger un bug existant
  | "localize"        // comprendre une base inconnue et localiser la fonction
  | "feature"         // ajouter une fonctionnalité multi-fichiers
  | "preserve"        // modifier en préservant le comportement existant
  | "write-tests"     // écrire des tests pour un bug
  | "fix-test"        // corriger un test qui échoue
  | "refactor"        // refactoring limité sans régression
  | "large-repo"      // retrouver la bonne implémentation dans un grand dépôt
  | "terminal"        // diagnostiquer/corriger via le terminal
  | "multi-cycle";    // recherche → modif → tests → correction

/** Issue d'une tentative d'agent. */
export type AttemptOutcome =
  | "resolved"        // tous les critères passent
  | "unresolved"      // l'agent a fini mais les critères ne passent pas
  | "agent-error"     // l'agent a échoué (erreur, timeout, abort)
  | "harness-error";  // erreur du harnais (setup, exécution des tests)

/** Résultat vérifiable d'un test (unitaire ou groupe). */
export interface TestOutcome {
  name: string;
  passed: boolean;
  /** Extrait de sortie utile au diagnostic (borné). */
  detail?: string;
}

/** Résultat complet d'une tentative sur une tâche. */
export interface AttemptResult {
  taskId: string;
  /** Identifiant du modèle évalué (jamais une clé API). */
  modelId: string;
  /** Numéro de répétition (1-based) pour les tâches non déterministes. */
  run: number;
  outcome: AttemptOutcome;
  /** Durée totale de la tentative d'agent (ms). */
  agentMs: number;
  /** Durée de la phase de test (ms). */
  testMs: number;
  /** Résultats FAIL_TO_PASS (état après modification de l'agent). */
  failToPass: TestOutcome[];
  /** Résultats PASS_TO_PASS (état après modification de l'agent). */
  passToPass: TestOutcome[];
  /** Nombre de tours / appels d'outils observés (si le driver les expose). */
  turns?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Message d'erreur éventuel (borné, jamais de secret). */
  error?: string;
}

/** Métadonnées optionnelles qu'un driver peut renvoyer après une tentative. */
export interface DriverMeta {
  turns?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}
