// ── Chargement et validation des tâches de codage versionnées ──────────────────
//
// Lit `<tasksDir>/<id>/task.json` pour chaque sous-dossier et valide le contrat.
// Une tâche invalide fait ÉCHOUER le chargement (jamais d'ignorance silencieuse :
// une tâche de benchmark non chargée fausserait les scores).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodingTask, TaskCategory } from "./types";

const CATEGORIES: readonly TaskCategory[] = [
  "bugfix", "localize", "feature", "preserve", "write-tests",
  "fix-test", "refactor", "large-repo", "terminal", "multi-cycle",
];

/** Charge et valide une tâche depuis son `task.json`. */
export async function loadTask(taskFile: string): Promise<CodingTask> {
  const raw = JSON.parse(await readFile(taskFile, "utf8")) as unknown;
  return validateTask(raw, taskFile);
}

/** Charge toutes les tâches d'un dossier (`<tasksDir>/<id>/task.json`). */
export async function loadTasks(tasksDir: string): Promise<CodingTask[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const tasks: CodingTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      tasks.push(await loadTask(join(tasksDir, entry.name, "task.json")));
    } catch (e) {
      throw new Error(
        `tâche invalide « ${entry.name} » : ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Valide le contrat d'une tâche ; lève avec un message précis si invalide. */
export function validateTask(raw: unknown, origin: string): CodingTask {
  const need = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`${origin} : ${msg}`);
  };
  need(raw != null && typeof raw === "object", "objet JSON attendu");
  const t = raw as Record<string, unknown>;
  const criteria = t.criteria as Record<string, unknown> | undefined;

  const id = t.id;
  const title = t.title;
  const instruction = t.instruction;
  const testCommand = t.testCommand;
  const kind = t.kind;
  const agentTimeoutMs = t.agentTimeoutMs;
  const testTimeoutMs = t.testTimeoutMs;

  need(typeof id === "string" && id.trim() !== "", "« id » manquant");
  need(typeof title === "string" && title.trim() !== "", "« title » manquant");
  need(typeof instruction === "string" && instruction.trim() !== "", "« instruction » manquante");
  need(typeof testCommand === "string" && testCommand.trim() !== "", "« testCommand » manquant");
  need(typeof kind === "string" && CATEGORIES.includes(kind as TaskCategory), `« kind » invalide : ${String(kind)}`);
  need(typeof agentTimeoutMs === "number" && agentTimeoutMs > 0, "« agentTimeoutMs » invalide");
  need(typeof testTimeoutMs === "number" && testTimeoutMs > 0, "« testTimeoutMs » invalide");
  need(criteria != null && typeof criteria === "object", "« criteria » manquant");
  need(Array.isArray(criteria?.failToPass) && criteria.failToPass.length > 0,
    "« criteria.failToPass » doit être un tableau non vide");
  need(Array.isArray(criteria?.passToPass), "« criteria.passToPass » doit être un tableau");

  return {
    id: id as string,
    title: title as string,
    kind: kind as TaskCategory,
    instruction: instruction as string,
    testCommand: testCommand as string,
    criteria: {
      failToPass: [...(criteria?.failToPass as string[])],
      passToPass: [...(criteria?.passToPass as string[])],
    },
    agentTimeoutMs: agentTimeoutMs as number,
    testTimeoutMs: testTimeoutMs as number,
    tokenBudget: typeof t.tokenBudget === "number" ? t.tokenBudget : undefined,
  };
}
