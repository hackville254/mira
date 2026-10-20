// ── Runner de tâches de codage — tentative isolée et reproductible ─────────────
//
// Pour chaque tentative :
//   1. copie la fixture de la tâche dans un dossier TEMPORAIRE frais (état
//      initial connu, jamais réutilisé entre deux tentatives) ;
//   2. lance l'AGENT (via un `AgentDriver` injectable) sur ce dossier ;
//   3. exécute les tests et applique les critères FAIL_TO_PASS / PASS_TO_PASS ;
//   4. renvoie un `AttemptResult` — le dossier temporaire est TOUJOURS nettoyé.
//
// L'agent n'est jamais codé en dur : `AgentDriver` est injecté par l'appelant.
// En production ce sera un driver qui pilote les VRAIS outils d'ORVYX (dans
// l'app Tauri) ; en test, un driver factice déterministe. C'est ce découplage
// qui permet d'exécuter le même jeu de tâches sur plusieurs « agents » sans
// toucher au moteur.

import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand, parseTestOutcomes, evaluateCriteria, criteriaSatisfied } from "./evaluator";
import type { AttemptResult, CodingTask, DriverMeta } from "./types";

/**
 * Contrat d'un agent évaluable. Reçoit un dossier de travail isolé et une
 * instruction, et le laisse dans l'état qu'il juge final. Ce qui compte n'est
 * PAS ce qu'il répond, mais l'état résultant du dépôt.
 */
export interface AgentDriver {
  /** Identifiant du modèle/agent (pour l'agrégation des résultats). */
  readonly id: string;
  /**
   * Exécute l'instruction dans `workdir`. Peut lever : l'erreur est capturée et
   * convertie en `agent-error` (jamais en échec silencieux).
   * @returns métadonnées optionnelles (tours, appels d'outils, tokens…).
   *          Peut retourner `void` : un driver qui ne mesure rien est valide.
   */
  run(input: {
    instruction: string;
    workdir: string;
    timeoutMs: number;
    tokenBudget?: number;
    /** Signal d'annulation respecté par le driver (timeout externe). */
    signal: AbortSignal;
  }): Promise<DriverMeta | void>;
}

export interface RunTaskOptions {
  /** Dossier contenant la fixture initiale `<tasksDir>/<id>/fixture`. */
  tasksDir: string;
  /** Répétition (1-based) — propagée dans le résultat. */
  run?: number;
  /** Répertoire de travail temporaire personnalisé (tests). Défaut : os.tmpdir(). */
  tmpRoot?: string;
}

/**
 * Exécute UNE tentative d'une tâche avec un driver donné.
 * Ne lève jamais : toute erreur devient un `AttemptResult` classé.
 */
export async function runTaskOnce(
  task: CodingTask,
  driver: AgentDriver,
  opts: RunTaskOptions,
): Promise<AttemptResult> {
  const run = opts.run ?? 1;
  const base: AttemptResult = {
    taskId: task.id,
    modelId: driver.id,
    run,
    outcome: "harness-error",
    agentMs: 0,
    testMs: 0,
    failToPass: [],
    passToPass: [],
  };

  const fixture = join(opts.tasksDir, task.id, "fixture");
  let workdir: string | null = null;

  try {
    // 1. Dépôt isolé frais — jamais l'état d'une tentative précédente.
    const root = opts.tmpRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "orvyx-bench-"));
    workdir = dir;
    await cp(fixture, dir, { recursive: true });

    // 2. Agent : timeout dur via AbortController.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), task.agentTimeoutMs);
    const tAgent = Date.now();
    let meta: DriverMeta = {};
    try {
      // Un driver peut légitimement ne rien retourner : on normalise.
      meta = (await driver.run({
        instruction: task.instruction,
        workdir: dir,
        timeoutMs: task.agentTimeoutMs,
        tokenBudget: task.tokenBudget,
        signal: ac.signal,
      })) ?? {};
    } catch (e) {
      base.outcome = "agent-error";
      base.agentMs = Date.now() - tAgent;
      base.error = ac.signal.aborted
        ? `agent timeout after ${task.agentTimeoutMs} ms`
        : String(e instanceof Error ? e.message : e);
      return base;
    } finally {
      clearTimeout(timer);
    }
    base.agentMs = Date.now() - tAgent;
    base.turns = meta.turns;
    base.toolCalls = meta.toolCalls;
    base.inputTokens = meta.inputTokens;
    base.outputTokens = meta.outputTokens;

    // 3. Tests + critères.
    const testRun = await runTestCommand(task, dir);
    base.testMs = testRun.durationMs;
    const parsed = parseTestOutcomes(testRun.stdout, testRun.stderr);
    base.failToPass = evaluateCriteria(task.criteria.failToPass, parsed, testRun);
    base.passToPass = evaluateCriteria(task.criteria.passToPass, parsed, testRun);

    base.outcome = criteriaSatisfied(base.failToPass) && criteriaSatisfied(base.passToPass)
      ? "resolved"
      : "unresolved";
    return base;
  } catch (e) {
    base.error = String(e instanceof Error ? e.message : e);
    base.outcome = "harness-error";
    return base;
  } finally {
    // 4. Nettoyage systématique — aucune fuite de dossier temporaire.
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Exécute une tâche `runs` fois et renvoie tous les résultats.
 * `runs > 1` quantifie la variance des tâches non déterministes.
 */
export async function runTask(
  task: CodingTask,
  driver: AgentDriver,
  opts: RunTaskOptions & { runs?: number },
): Promise<AttemptResult[]> {
  const runs = Math.max(1, opts.runs ?? 1);
  const out: AttemptResult[] = [];
  for (let r = 1; r <= runs; r++) {
    out.push(await runTaskOnce(task, driver, { ...opts, run: r }));
  }
  return out;
}
