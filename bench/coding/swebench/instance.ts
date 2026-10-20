// ── SWE-bench réel — chargement des instances et conversion en tâche ──────────
//
// Ce module relie le format OFFICIEL d'une instance SWE-bench au contrat de
// tâche du harnais (`CodingTask`). Il ne réécrit AUCUN champ : le dépôt, le
// commit de base, le `test_patch` et les listes FAIL_TO_PASS / PASS_TO_PASS sont
// repris tels quels depuis la source (dataset `princeton-nlp/SWE-bench_Lite`).
//
// ATTENTION — HONNÊTETÉ DU SCORE
// ------------------------------
// Un score produit avec ce module n'est PAS un score « SWE-bench Verified
// officiel » : le protocole officiel utilise une image Docker par instance.
// Ici, l'environnement est préparé une fois en local (venv Python). Cela reste
// comparable ENTRE MODELES sur le même mini-set, au même commit, avec les mêmes
// tests. Toute publication doit préciser l'échantillon et l'environnement.

import type { CodingTask, TaskCategory } from "../types";

/**
 * Une instance SWE-bench, telle qu'extraite du dataset (champs officiels,
 * aucun renommage). Voir `swebench/instances/<instance_id>.json`.
 */
export interface SweBenchInstance {
  instance_id: string;
  /** Dépôt GitHub, ex. `astropy/astropy`. */
  repo: string;
  /** Commit sur lequel l'agent travaille (état initial). */
  base_commit: string;
  environment_setup_commit?: string;
  version?: string;
  /** Texte de l'issue GitHub donné à l'agent (instruction). */
  problem_statement: string;
  /** Patch de référence (oracle) — JAMAIS montré à l'agent. */
  patch: string;
  /** Patch des tests appliqué avant l'évaluation — JAMAIS montré à l'agent. */
  test_patch: string;
  /** Tests qui doivent échouer avant et réussir après. */
  FAIL_TO_PASS: string[];
  /** Tests qui doivent réussir avant et après. */
  PASS_TO_PASS: string[];
  created_at?: string;
}

/** Valide une instance ; lève avec un message précis si un champ manque. */
export function validateInstance(raw: unknown, origin: string): SweBenchInstance {
  const need = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`${origin} : ${msg}`);
  };
  need(raw != null && typeof raw === "object", "objet JSON attendu");
  const r = raw as Record<string, unknown>;
  need(typeof r.instance_id === "string" && r.instance_id.trim() !== "", "« instance_id » manquant");
  need(typeof r.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(r.repo), "« repo » invalide");
  need(typeof r.base_commit === "string" && /^[0-9a-f]{7,40}$/.test(r.base_commit), "« base_commit » invalide");
  need(typeof r.problem_statement === "string" && r.problem_statement.trim() !== "", "« problem_statement » manquant");
  need(typeof r.test_patch === "string", "« test_patch » manquant");
  need(Array.isArray(r.FAIL_TO_PASS) && (r.FAIL_TO_PASS as unknown[]).length > 0, "« FAIL_TO_PASS » vide");
  need(Array.isArray(r.PASS_TO_PASS), "« PASS_TO_PASS » doit être un tableau");

  return {
    instance_id: r.instance_id as string,
    repo: r.repo as string,
    base_commit: r.base_commit as string,
    environment_setup_commit: typeof r.environment_setup_commit === "string" ? r.environment_setup_commit : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
    problem_statement: r.problem_statement as string,
    patch: typeof r.patch === "string" ? r.patch : "",
    test_patch: r.test_patch as string,
    FAIL_TO_PASS: [...(r.FAIL_TO_PASS as string[])],
    PASS_TO_PASS: [...(r.PASS_TO_PASS as string[])],
    created_at: typeof r.created_at === "string" ? r.created_at : undefined,
  };
}

/**
 * Convertit le nom qualifié d'un test pytest en motif utilisable par
 * `evaluateCriteria` (qui compare des noms). On conserve le nom de la méthode
 * de test sans le fichier ni les paramètres, car la sortie dépouillée de
 * pytest est ensuite parsée par le harnais.
 *
 * Ex. `astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]`
 *   → `test_separable[compound_model6-result6]`
 */
export function testNameFromQualified(qualified: string): string {
  const afterFile = qualified.includes("::") ? qualified.slice(qualified.indexOf("::") + 2) : qualified;
  return afterFile.replace(/\s+/g, " ").trim();
}

/** Catégorie déduite de la forme de l'instance (heuristique transparente). */
function categorize(inst: SweBenchInstance): TaskCategory {
  const text = inst.problem_statement.toLowerCase();
  if (/\brefactor/.test(text)) return "refactor";
  if (/\badd\b|\bimplement\b|\bfeature\b|\bsupport\b/.test(text)) return "feature";
  if (inst.FAIL_TO_PASS.length > 5) return "large-repo";
  return "bugfix";
}

/**
 * Fichiers de test à exécuter pour une instance. Les `FAIL_TO_PASS` peuvent
 * être des noms QUALIFIÉS (`chemin/test_x.py::test_y`) — cas astropy/sklearn —
 * ou de SIMPLES noms de fonction (`test_y`) — cas sympy. Dans ce second cas on
 * résout le fichier via le `test_patch` officiel (source de vérité du harness).
 */
export function testFilesFor(inst: SweBenchInstance): string[] {
  const fromQualified = inst.FAIL_TO_PASS
    .filter(q => q.includes("::"))
    .map(q => q.split("::")[0]);
  if (fromQualified.length > 0) return [...new Set(fromQualified)];
  // Noms non qualifiés : on lit les en-têtes `diff --git a/... b/...` du test_patch.
  return [...new Set([...inst.test_patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(m => m[2]))];
}

/**
 * Construit la `CodingTask` d'une instance. Le `testCommand` exécute pytest sur
 * le fichier de test concerné ; l'instruction est le texte de l'issue, précédé
 * d'un rappel neutre (aucune indication de solution).
 */
export function toCodingTask(inst: SweBenchInstance): CodingTask {
  const testFiles = testFilesFor(inst);
  const testCommand = testFiles.length > 0
    ? `python -m pytest ${testFiles.map(f => `"${f}"`).join(" ")} -rA --no-header -q`
    : `python -m pytest -rA --no-header -q`;

  return {
    id: inst.instance_id,
    title: `${inst.repo}@${inst.base_commit.slice(0, 7)} — ${inst.instance_id}`,
    kind: categorize(inst),
    instruction: [
      `Dépôt : ${inst.repo} (Python). Résous le problème décrit ci-dessous en modifiant le code source du dépôt.`,
      "N'écris PAS de nouveaux tests et ne modifie PAS les fichiers de test existants : les tests qui décrivent",
      "le comportement attendu sont déjà présents. Quand tu as terminé, laisse le dépôt dans son état final.",
      "",
      "── Issue ──",
      inst.problem_statement.trim(),
    ].join("\n"),
    testCommand,
    criteria: {
      failToPass: inst.FAIL_TO_PASS.map(testNameFromQualified),
      passToPass: inst.PASS_TO_PASS.map(testNameFromQualified),
    },
    // Budget de PILOTAGE large : les instances Verified (django, sphinx…) sont
    // plus grosses que Lite. Un dépassement n'invalide PAS le patch : les tests
    // sont exécutés et notés même après un timeout (`runOneSwe`).
    agentTimeoutMs: 30 * 60 * 1000,
    testTimeoutMs: 15 * 60 * 1000,
  };
}
