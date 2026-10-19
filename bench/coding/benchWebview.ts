/**
 * Origin — Hook de benchmark DEV-ONLY, exécuté DANS la webview Tauri.
 *
 * POURQUOI CE MODULE
 * ------------------
 * Le moteur de production (sidecar Cline) n'est pilotable QUE dans la webview :
 * `startClineHarness` → `startClineRun` → `invoke` Tauri. Hors Tauri, aucun
 * outil réel n'existe (les outils de prod appellent `invoke` de manière
 * statique : aucun point d'injection, cf. §1.3 du rapport de bench).
 *
 * Ce module fournit le seul chemin honnête pour mesurer la VRAIE boucle d'outils
 * dans une tâche de codage réelle : il copie une fixture versionnée dans un
 * dossier temporaire, lance le VRAI run (`startClineHarness`), exécute les tests
 * via une commande Tauri bornée, puis applique les critères FAIL_TO_PASS /
 * PASS_TO_PASS avec la MÊME logique pure que le harnais Node (`evaluatorCore`).
 *
 * SÉCURITÉ
 * --------
 *  - **DEV-ONLY** : enregistré uniquement quand `import.meta.env.DEV` est vrai.
 *    Jamais présent dans un bundle de production.
 *  - **Aucune clé journalisée** : la clé vient de l'UI/env, transite vers le
 *    sidecar, et n'est jamais écrite dans un résultat.
 *  - **Approbations** : `ask` est REFUSÉ par défaut (`autoApprove: false`). Un
 *    `autoApprove` explicite est possible pour un bench non interactif.
 *  - **Isolation** : chaque tâche tourne dans un dossier temporaire frais, copié
 *    depuis la fixture et supprimé à la fin.
 */

import { invoke } from "@tauri-apps/api/core";
import { startClineHarness } from "../../src/lib/agent/clineHarness";
import { resolveClineProvider } from "../../src/lib/agent/providers";
import { loadPermissionMode, savePermissionMode } from "../../src/lib/agent/permissions";
import type { AgentEvent } from "../../src/lib/agent/run";
import { buildSystemPrompt } from "../../src/lib/agent/prompts";
import { parseTestOutcomes, evaluateCriteria, criteriaSatisfied } from "./evaluatorCore";
import type { AttemptResult, CodingTask, TaskCategory } from "./types";

/** Commande Tauri `agent_bash_run` : exécution synchrone bornée (timeout 120 s). */
interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out?: boolean;
  truncated: boolean;
}

/** Config AI de dev exposée par Rust (`.env`) — contient la clé, jamais journalisée. */
interface DevAiConfig {
  provider: string | null;
  model: string | null;
  api_key: string | null;
  base_url: string | null;
  configured: boolean;
}

/** Options du hook webview (jamais de secret ici : la clé vient de l'UI/env). */
export interface WebviewBenchOptions {
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** IDs des tâches à exécuter ; par défaut toutes celles fournies. */
  taskIds?: string[];
  /** Mode d'agent Cline (`act` par défaut). */
  mode?: string;
  /** Approuve automatiquement les actions `ask`. DÉFAUT : false (refus sûr). */
  autoApprove?: boolean;
  /** Nombre de répétitions par tâche (défaut 1). */
  runs?: number;
  /** Racine du dépôt (là où vit `bench/coding/tasks`). Auto-résolue si omise. */
  repoRoot?: string;
  /** Callback de progression (id de tâche, index, total). */
  onProgress?: (info: { taskId: string; run: number; index: number; total: number }) => void;
}

/** Options résolues : tous les champs requis sont présents. */
interface ResolvedOptions {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  taskIds?: string[];
  mode: string;
  autoApprove: boolean;
  runs: number;
  repoRoot: string;
  onProgress?: WebviewBenchOptions["onProgress"];
}

/**
 * Complète les options manquantes depuis la config de dev Rust (`dev_ai_config`,
 * lue du `.env`). La clé n'est jamais renvoyée à l'appelant ni journalisée :
 * elle ne sert qu'au handshake du sidecar.
 */
async function resolveOptions(opts: WebviewBenchOptions): Promise<ResolvedOptions> {
  const dev = await invoke<DevAiConfig>("dev_ai_config");
  const providerId = opts.providerId ?? dev.provider ?? "";
  const modelId = opts.modelId ?? dev.model ?? "";
  const apiKey = opts.apiKey ?? dev.api_key ?? "";
  const baseUrl = opts.baseUrl ?? dev.base_url ?? undefined;
  if (!providerId || !modelId || !apiKey) {
    throw new Error("config AI incomplète : renseigne providerId/modelId/apiKey ou un `.env` ORVYX_AI_*");
  }
  const repoRoot = opts.repoRoot ?? (await resolveRepoRoot());
  return {
    providerId, modelId, apiKey, baseUrl,
    taskIds: opts.taskIds, mode: opts.mode ?? "act",
    autoApprove: opts.autoApprove === true, runs: Math.max(1, opts.runs ?? 1),
    repoRoot,
    onProgress: opts.onProgress,
  };
}

/**
 * Résout la racine du dépôt contenant `bench/coding/tasks`. Le cwd du process
 * Tauri en dev est `src-tauri` ; on remonte de proche en proche jusqu'à trouver
 * le dossier des tâches. Échoue explicitement si aucun ancêtre ne le contient.
 */
async function resolveRepoRoot(): Promise<string> {
  const cmd = [
    'd=$(pwd)',
    'while [ "$d" != "/" ]; do',
    '  if [ -d "$d/bench/coding/tasks" ]; then printf "%s" "$d"; exit 0; fi',
    '  d=$(dirname "$d")',
    'done',
    'exit 1',
  ].join("\n");
  const res = await invoke<BashResult>("agent_bash_run", { command: cmd, cwd: "." });
  const root = res.stdout.trim();
  if (res.exit_code !== 0 || !root) {
    throw new Error(`racine du dépôt introuvable (bench/coding/tasks absent) — sortie: ${root || "(vide)"}`);
  }
  return root;
}

/**
 * Charge les tâches versionnées depuis `bench/coding/tasks`. En build web (Vite),
 * le dossier n'est pas dans le bundle : la lecture passe par Vite (`import.meta.glob`).
 */
const TASK_MODULES = import.meta.glob("./tasks/*/task.json", { eager: true, import: "default" }) as Record<string, unknown>;

function validateTask(raw: unknown, id: string): CodingTask {
  const t = raw as Record<string, unknown>;
  const need = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`tâche « ${id} » : ${msg}`);
  };
  const criteria = t.criteria as Record<string, unknown> | undefined;
  need(typeof t.title === "string", "title manquant");
  need(typeof t.instruction === "string", "instruction manquante");
  need(typeof t.testCommand === "string", "testCommand manquant");
  need(typeof t.kind === "string", "kind manquant");
  need(typeof t.agentTimeoutMs === "number", "agentTimeoutMs invalide");
  need(typeof t.testTimeoutMs === "number", "testTimeoutMs invalide");
  need(criteria && Array.isArray(criteria.failToPass), "criteria.failToPass manquant");
  need(criteria && Array.isArray(criteria.passToPass), "criteria.passToPass manquant");
  return {
    id,
    title: t.title as string,
    kind: t.kind as TaskCategory,
    instruction: t.instruction as string,
    testCommand: t.testCommand as string,
    criteria: {
      failToPass: [...(criteria?.failToPass as string[])],
      passToPass: [...(criteria?.passToPass as string[])],
    },
    agentTimeoutMs: t.agentTimeoutMs as number,
    testTimeoutMs: t.testTimeoutMs as number,
  };
}

/** Toutes les tâches, triées par id (ordre stable du plus simple au complexe par id). */
export function loadWebviewTasks(): CodingTask[] {
  return Object.entries(TASK_MODULES)
    .map(([path, mod]) => {
      const id = path.split("/")[2];
      return validateTask(mod, id);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Copie la fixture de la tâche dans un dossier temporaire frais (via Tauri). */
async function prepareWorkdir(taskId: string, repoRoot: string): Promise<string> {
  // `mktemp -d` + `cp -R` : le cwd est validé côté Rust, la fixture est de
  // confiance (versionnée), le dossier temporaire est isolé par tâche.
  const src = `${repoRoot}/bench/coding/tasks/${taskId}/fixture`;
  const cmd = `set -e; d=$(mktemp -d "\${TMPDIR:-/tmp}/orvyx-bench-XXXXXX"); cp -R "${src}/." "$d/"; printf '%s' "$d"`;
  const res = await invoke<BashResult>("agent_bash_run", { command: cmd, cwd: repoRoot });
  const dir = res.stdout.trim();
  if (!dir) throw new Error(`copie de la fixture échouée : ${res.stderr || res.stdout}`);
  return dir;
}

/** Supprime un dossier temporaire (best-effort). */
async function cleanupWorkdir(dir: string, cwd: string): Promise<void> {
  await invoke<BashResult>("agent_bash_run", { command: `rm -rf "${dir}"`, cwd })
    .catch(() => undefined);
}

/** Exécute la commande de test de la tâche dans `workdir` (via Tauri, bornée). */
async function runTests(task: CodingTask, workdir: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const t0 = Date.now();
  const res = await invoke<BashResult>("agent_bash_run", { command: task.testCommand, cwd: workdir });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exit_code, durationMs: Date.now() - t0 };
}

/**
 * Déduplique et borne les diagnostics du sidecar pour éviter des messages
 * d'erreur obèses (chaque chunk terminal peut être long et répété).
 */
function dedupeDiagnostics(diagnostics: string[], maxLen = 2000): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const d of diagnostics) {
    const key = d.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  const joined = unique.join(" | ");
  return joined.length > maxLen ? `${joined.slice(0, maxLen)}…` : joined;
}

/**
 * Exécute UNE tentative d'une tâche avec le VRAI moteur.
 * Ne lève jamais : toute erreur devient un `AttemptResult` classé.
 */
async function runOne(
  task: CodingTask,
  opts: ResolvedOptions,
  run: number,
): Promise<AttemptResult> {
  const base: AttemptResult = {
    taskId: task.id, modelId: `cline:${opts.modelId}`, run,
    outcome: "harness-error", agentMs: 0, testMs: 0, failToPass: [], passToPass: [],
  };
  let workdir: string | null = null;
  let errorMessage: string | undefined;
  const diagnostics: string[] = [];
  try {
    workdir = await prepareWorkdir(task.id, opts.repoRoot);

    // Traduction du provider Origin → config SDK Cline (`orvyx` doit devenir
    // `openai-compatible` + baseUrl, sinon le sidecar rejette le provider).
    const clineProvider = resolveClineProvider(opts.providerId);

    // ── Agent : VRAI run via le sidecar Cline ────────────────────────────────
    let done: () => void = () => {};
    const finished = new Promise<void>((r) => { done = r; });
    let turns = 0, toolCalls = 0, inputTokens = 0, outputTokens = 0;

    const onEvent = (e: AgentEvent): void => {
      if (e.type === "approval-required") {
        if (opts.autoApprove) e.approve();
        else e.reject("bench: approbation non accordée (canal absent)");
        return;
      }
      if (e.type === "tool-call") toolCalls++;
      else if (e.type === "timing") turns++;
      else if (e.type === "finish") {
        inputTokens += e.usage?.inputTokens ?? 0;
        outputTokens += e.usage?.outputTokens ?? 0;
      } else if (e.type === "error") errorMessage = e.message;
      else if (e.type === "terminal-output") diagnostics.push(e.chunk);
      else if (e.type === "notice") diagnostics.push(`${e.kind}: ${e.detail}`);
      if (e.type === "finish" || e.type === "error") done();
    };

    const handle = await startClineHarness({
      workspace: workdir,
      providerId: clineProvider.providerId,
      baseUrl: clineProvider.baseUrl,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      systemPrompt: buildSystemPrompt("agent", true),
      mode: opts.mode ?? "act",
      onEvent,
      onBeforeWrite: () => {},
    });
    if (!handle) throw new Error("sidecar Cline indisponible (démarrage échoué)");

    const tAgent = Date.now();
    const timer = setTimeout(() => {
      errorMessage = errorMessage ?? `timeout ${task.agentTimeoutMs}ms`;
      void handle.abort().finally(done);
    }, task.agentTimeoutMs);
    try {
      await handle.send(task.instruction);
      await finished;
    } finally {
      clearTimeout(timer);
      handle.dispose();
    }
    base.agentMs = Date.now() - tAgent;
    base.turns = turns;
    base.toolCalls = toolCalls;
    base.inputTokens = inputTokens;
    base.outputTokens = outputTokens;

    // ── Tests + critères (même logique pure que le harnais Node) ─────────────
    const testRun = await runTests(task, workdir);
    base.testMs = testRun.durationMs;
    const parsed = parseTestOutcomes(testRun.stdout, testRun.stderr);
    const runShape = { exitCode: testRun.exitCode, stdout: testRun.stdout, stderr: testRun.stderr, timedOut: false, durationMs: testRun.durationMs };
    base.failToPass = evaluateCriteria(task.criteria.failToPass, parsed, runShape);
    base.passToPass = evaluateCriteria(task.criteria.passToPass, parsed, runShape);
    base.outcome = criteriaSatisfied(base.failToPass) && criteriaSatisfied(base.passToPass)
      ? "resolved" : "unresolved";
    // Un run qui n'a produit AUCUN tour mais s'est terminé sur une erreur est un
    // échec de l'agent (provider injoignable, config, etc.) : on le classe comme
    // tel, avec le diagnostic du sidecar, plutôt que « unresolved » (trompeur).
    if (base.outcome !== "resolved" && errorMessage) {
      base.outcome = "agent-error";
      base.error = errorMessage;
    }
    if (base.outcome === "agent-error" && diagnostics.length > 0) {
      base.error = `${base.error ?? ""} | sidecar: ${dedupeDiagnostics(diagnostics)}`;
    }
    return base;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    base.outcome = "agent-error";
    return base;
  } finally {
    if (workdir) await cleanupWorkdir(workdir, opts.repoRoot);
  }
}

/**
 * Exécute toutes les tâches demandées, `runs` fois chacune, du plus simple au
 * plus complexe (ordre des IDs). Les options manquantes (clé, modèle, racine)
 * sont complétées automatiquement depuis la config de dev.
 * @returns la liste complète des tentatives (jamais de throw : les erreurs sont classées).
 */
export async function runWebviewBench(opts: WebviewBenchOptions = {}): Promise<AttemptResult[]> {
  const resolved = await resolveOptions(opts);
  const all = loadWebviewTasks();
  const selected = resolved.taskIds
    ? all.filter(t => resolved.taskIds!.includes(t.id))
    : all;
  const total = selected.length * resolved.runs;

  // Un bench non interactif n'a pas d'utilisateur pour approuver les écritures :
  // en mode `manual` (défaut), chaque `editor`/`bash` déclencherait un `ask`
  // jamais résolu → timeout du sidecar (30 s) et run perdu. On force donc le
  // mode « Full Access » le temps du bench, puis on RESTAURE le mode d'origine.
  // DEV-ONLY + restauré : aucune modification persistante du comportement.
  const previousMode = loadPermissionMode();
  savePermissionMode("full");
  try {
    const results: AttemptResult[] = [];
    let index = 0;
    for (const task of selected) {
      for (let r = 1; r <= resolved.runs; r++) {
        index++;
        resolved.onProgress?.({ taskId: task.id, run: r, index, total });
        results.push(await runOne(task, resolved, r));
      }
    }
    return results;
  } finally {
    savePermissionMode(previousMode);
  }
}

/**
 * Enregistre `window.__runBench` — DEV-ONLY. Idempotent : un double appel ne
 * réinstalle pas le hook. En production cette fonction n'est jamais appelée
 * (cf. `main.tsx`).
 */
export function installBenchHook(): void {
  const w = window as unknown as { __runBench?: (o?: WebviewBenchOptions) => Promise<AttemptResult[]>, __benchTasks?: () => CodingTask[] };
  if (w.__runBench) return;
  w.__runBench = runWebviewBench;
  w.__benchTasks = loadWebviewTasks;
  console.info("[bench] hook dev prêt : `await __runBench()` (config auto via .env) — `__benchTasks()` liste les tâches.");

  // Auto-run DEV optionnel : piloté par `VITE_BENCH_AUTORUN`. Sert à exécuter le
  // bench depuis la webview Tauri SANS clic manuel (le seul chemin honnête pour
  // la VRAIE boucle d'outils). Format : `taskIds` séparés par des virgules, ou
  // `all` pour tout. Aucun effet si la variable n'est pas définie.
  const autorun = import.meta.env.VITE_BENCH_AUTORUN as string | undefined;
  if (autorun) {
    const runs = Number(import.meta.env.VITE_BENCH_RUNS ?? "1") || 1;
    const taskIds = autorun === "all" ? undefined : autorun.split(",").map(s => s.trim()).filter(Boolean);
    console.info(`[bench] auto-run : tâches=${autorun} runs=${runs}`);
    void runWebviewBench({ taskIds, runs }).then((results) => {
      // On expose le résultat brut sur `window` pour récupération via la console.
      (window as unknown as { __benchResults?: AttemptResult[] }).__benchResults = results;
      const resolved = results.filter(r => r.outcome === "resolved").length;
      console.info(`[bench] terminé : ${resolved}/${results.length} résolues`);
      console.table(results.map(r => ({
        tâche: r.taskId, issue: r.outcome, tours: r.turns ?? 0,
        outils: r.toolCalls ?? 0, agentMs: r.agentMs, testMs: r.testMs, erreur: r.error ?? "",
      })));
      // Remontée dans les logs Rust (visibles hors DevTools) : une ligne JSON par
      // tentative. Utile pour récupérer les résultats sans ouvrir la console.
      for (const r of results) {
        void invoke("origin_log", {
          level: "info", target: "bench",
          message: JSON.stringify({
            taskId: r.taskId, outcome: r.outcome, turns: r.turns ?? 0, toolCalls: r.toolCalls ?? 0,
            agentMs: r.agentMs, testMs: r.testMs,
            failToPass: r.failToPass.map(f => `${f.name}=${f.passed ? "ok" : "ko"}`).join(","),
            error: r.error ?? "",
          }),
        }).catch(() => undefined);
      }
    }).catch((e) => {
      console.error("[bench] auto-run échoué :", e instanceof Error ? e.message : e);
      void invoke("origin_log", { level: "error", target: "bench", message: `auto-run échoué : ${e instanceof Error ? e.message : e}` }).catch(() => undefined);
    });
  }
}
