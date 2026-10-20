// ── Évaluateur de tâches de codage — vérification OBJECTIVE ────────────────────
//
// Lance la commande de test de la tâche dans un dépôt isolé et convertit le
// résultat en `TestOutcome[]`. Le score est calculé par comparaison aux critères
// FAIL_TO_PASS / PASS_TO_PASS — jamais par un jugement du texte produit.
//
// Le parsing est volontairement TOLÉRANT : on lit la sortie agrégée du runner de
// test (format TAP-ish : « ✓/✗ nom », « pass N », « fail N »). Si la sortie n'est
// pas reconnue, on retombe sur le CODE DE SORTIE : une commande qui sort en 0
// est considérée comme « tous les tests passent », sinon « au moins un échec ».
// C'est imparfait mais sûr : on ne peut jamais déclarer un succès sans preuve.

import { execFile } from "node:child_process";
import type { CodingTask } from "./types";
import { parseTestOutcomes, evaluateCriteria, criteriaSatisfied, type TestRunResult } from "./evaluatorCore";

// Re-export : la logique de notation PURE vit dans `evaluatorCore.ts` (partagée
// avec la webview Tauri, où `node:*` est interdit). On garde les mêmes noms pour
// ne pas casser les appelants existants.
export { parseTestOutcomes, evaluateCriteria, criteriaSatisfied };
export type { TestRunResult };

/** Lance la commande de test dans `cwd` avec un timeout dur. */
export function runTestCommand(task: CodingTask, cwd: string): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const hardKill: { id?: ReturnType<typeof setTimeout> } = {};
    // `sh -c` : la commande de test est fournie par la tâche versionnée (pas par
    // un modèle), donc de confiance. On isole par cwd et timeout.
    const child = execFile(
      "sh",
      ["-c", task.testCommand],
      { cwd, timeout: task.testTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err: Error | null, stdout: string, stderr: string) => {
        clearTimeout(hardKill.id);
        const timedOut = err != null && (err as { killed?: boolean }).killed === true;
        const code = err == null ? 0 : (err as unknown as { code?: unknown }).code;
        resolve({
          exitCode: typeof code === "number" ? code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
          durationMs: Date.now() - t0,
        });
      },
    );
    // Ceinture et bretelles : tuer si le timeout d'execFile ne suffit pas.
    hardKill.id = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, task.testTimeoutMs + 1_000);
    hardKill.id.unref?.();
  });
}

