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
import { validateInstance, toCodingTask, testFilesFor, type SweBenchInstance } from "./swebench/instance";
import { runWebviewLcb, loadLcbShardViaTauri, type WebviewLcbOptions, type LcbProblem, type LcbCase } from "./livecodebench/benchLcb";
import type { AttemptResult, CodingTask, TaskCategory } from "./types";

/** Commande Tauri `bench_bash_run` : exécution DEV bornée (timeout paramétrable). */
interface BenchBashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
}

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

/**
 * Callback d'export : reçoit le nom de fichier souhaité et la charge utile
 * JSON. Permet à un harnais externe (navigateur headless) de RÉCUPÉRER les
 * résultats hors de la webview, sans ouvrir les DevTools.
 */
export type ExportSink = (fileName: string, json: string) => void;

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
  /** Borne la boucle d'outils (défaut : 25). Empêche un run non convergent. */
  maxIterations?: number;
  /** Nombre de répétitions par tâche (défaut 1). */
  runs?: number;
  /** Racine du dépôt (là où vit `bench/coding/tasks`). Auto-résolue si omise. */
  repoRoot?: string;
  /** Callback de progression (id de tâche, index, total). */
  onProgress?: (info: { taskId: string; run: number; index: number; total: number }) => void;
  /** Export optionnel des résultats bruts (harnais headless). */
  onExport?: ExportSink;
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
  maxIterations: number;
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
    autoApprove: opts.autoApprove === true,
    maxIterations: Math.max(1, opts.maxIterations ?? 25),
    runs: Math.max(1, opts.runs ?? 1),
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
      // Un TOUR = une itération de la boucle d'outils. `step-finish` marque la
      // fin d'un tour (le SDK Cline en émet un par itération). L'événement
      // `timing`, lui, n'est émis qu'UNE fois en fin de run : il ne comptait
      // donc jamais plus de 1 (bug de reporting corrigé ici).
      else if (e.type === "step-finish") turns++;
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
      // Borne la boucle d'outils (paramètre public du contrat, cf. runOneSwe).
      maxIterations: opts.maxIterations,
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
      // NE PAS await l'acquittement de `send` : le SDK Cline (`engine.send`) ne
      // répond `{accepted:true}` qu'à la FIN du tour complet, donc tout tour de
      // plus de 30 s dépasse le COMMAND_REPLY_TIMEOUT du sidecar Rust et rejette
      // en SIDECAR_REPLY_TIMEOUT — alors que l'agent a réellement travaillé (le
      // flux arrive par `cline://event`). On ignore donc ce rejet : seul
      // l'événement terminal de l'agent (`finish`/`error`) ou le timer
      // `agentTimeoutMs` clôt le tour. Aucune modification du moteur (§6).
      void handle.send(task.instruction).catch((e) => {
        // Un rejet du canal de commande n'est PAS une fin d'agent : on le note
        // en diagnostic et on laisse `finished` se résoudre sur `finish`/`error`.
        diagnostics.push(`send-ack: ${e instanceof Error ? e.message : String(e)}`);
      });
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

// ── SWE-bench réel (instances téléchargées) — pilotage depuis la webview ──────
//
// DIFFÉRENCE CLÉ AVEC LES FIXTURES INTERNES
// -----------------------------------------
// Les fixtures internes sont copiées dans un dossier temporaire jetable : elles
// n'ont besoin d'aucun environnement (Node pur). Une instance SWE-bench, elle,
// NÉCESSITE un environnement préparé À L'AVANCE hors webview (`swebench/cli.ts
// --prepare-only`) : clone du dépôt réel + image Docker `orvyx-swebench:<id>` +
// `pip install -e .` + `test_patch` appliqué. La webview ne peut pas faire cela :
// `prepare.ts` dépend de `node:child_process`, INTERDIT dans la webview.
//
// Ici on ne fait donc que DEUX choses, en réutilisant l'environnement préparé :
//   1. lancer le VRAI agent (`startClineHarness`) dans `.envs/<id>/repo` ;
//   2. exécuter les tests DANS LE CONTENEUR (docker run) via la commande DEV
//      `bench_bash_run` (timeout paramétrable, sortie large) — `agent_bash_run`
//      est inutilisable ici (plafond 120 s / 64 Ko).
//
// Ce chemin prouve l'INTÉGRATION réelle : mêmes critères FAIL_TO_PASS /
// PASS_TO_PASS, même `parseTestOutcomes`/`evaluateCriteria` que le harnais Node.

/** Options du runner SWE-bench webview. */
export interface WebviewSwebenchOptions {
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** IDs d'instances à exécuter ; par défaut toutes celles fournies. */
  instanceIds?: string[];
  /** Mode d'agent Cline (`act` par défaut). */
  mode?: string;
  /** Approuve automatiquement les actions `ask`. DÉFAUT : false (refus sûr). */
  autoApprove?: boolean;
  /** Borne la boucle d'outils (défaut : 25). Empêche un run non convergent. */
  maxIterations?: number;
  /** Nombre de répétitions par instance (défaut 1). */
  runs?: number;
  /** Racine des environnements préparés (défaut `.envs` à côté des instances). */
  envRoot?: string;
  /** Callback de progression. */
  onProgress?: (info: { instanceId: string; run: number; index: number; total: number }) => void;
  /** Export optionnel des résultats bruts (harnais headless). */
  onExport?: ExportSink;
}

/** Options SWE-bench résolues. */
interface ResolvedSwebenchOptions {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  instanceIds?: string[];
  mode: string;
  autoApprove: boolean;
  maxIterations: number;
  runs: number;
  envRoot?: string;
  onProgress?: WebviewSwebenchOptions["onProgress"];
  onExport?: ExportSink;
}

/** Instances SWE-bench versionnées (JSON réel, aucun renommage de champ). */
const SWE_INSTANCES = import.meta.glob("./swebench/instances/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

/** Toutes les instances SWE-bench, triées par id pour un ordre stable. */
export function loadSwebenchInstances(): SweBenchInstance[] {
  return Object.entries(SWE_INSTANCES)
    .map(([path, raw]) => validateInstance(raw, path.split("/").pop() ?? path))
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
}

/** Tâches SWE-bench converties au contrat `CodingTask` (pour inspection). */
export function loadSwebenchTasks(): CodingTask[] {
  return loadSwebenchInstances().map(toCodingTask);
}

/** Complète les options SWE-bench depuis la config de dev Rust (`.env`). */
async function resolveSwebenchOptions(opts: WebviewSwebenchOptions): Promise<ResolvedSwebenchOptions> {
  const dev = await invoke<DevAiConfig>("dev_ai_config");
  const providerId = opts.providerId ?? dev.provider ?? "";
  const modelId = opts.modelId ?? dev.model ?? "";
  const apiKey = opts.apiKey ?? dev.api_key ?? "";
  const baseUrl = opts.baseUrl ?? dev.base_url ?? undefined;
  if (!providerId || !modelId || !apiKey) {
    throw new Error("config AI incomplète : renseigne providerId/modelId/apiKey ou un `.env` ORVYX_AI_*");
  }
  return {
    providerId, modelId, apiKey, baseUrl,
    instanceIds: opts.instanceIds, mode: opts.mode ?? "act",
    autoApprove: opts.autoApprove === true,
    maxIterations: Math.max(1, opts.maxIterations ?? 25),
    runs: Math.max(1, opts.runs ?? 1),
    envRoot: opts.envRoot, onProgress: opts.onProgress, onExport: opts.onExport,
  };
}

/**
 * Résout la racine des environnements préparés (`.envs`) en remontant depuis le
 * cwd (qui vaut `src-tauri` en dev Tauri), puis vérifie que l'instance y est.
 */
async function sweEnvDir(instanceId: string, explicit?: string): Promise<string> {
  if (explicit) return `${explicit}/${instanceId}`;
  const cmd = [
    'd=$(pwd)',
    'while [ "$d" != "/" ]; do',
    '  if [ -d "$d/bench/coding/swebench/.envs" ]; then printf "%s" "$d/bench/coding/swebench/.envs"; exit 0; fi',
    '  d=$(dirname "$d")',
    'done',
    'exit 1',
  ].join("\n");
  const res = await invoke<BashResult>("agent_bash_run", { command: cmd, cwd: "." });
  const root = res.stdout.trim();
  if (res.exit_code !== 0 || !root) {
    throw new Error("racine `.envs` introuvable — lance d'abord `npx tsx bench/coding/swebench/cli.ts --prepare-only`");
  }
  return `${root}/${instanceId}`;
}

/**
 * Nom d'image Docker d'une instance. DOIT rester aligné sur `prepare` : le
 * chemin par défaut est l'IMAGE OFFICIELLE SWE-bench (`swebench/sweb.eval...`),
 * c'est celle qu'utilise la préparation. On duplique la règle (plutôt que
 * d'importer) car ce module tourne dans la webview : il ne peut pas charger du
 * code Node de préparation (fs/child_process).
 */
function imageNameFor(instanceId: string): string {
  const m = /^(.+)__(.+-[0-9]+)$/.exec(instanceId);
  if (!m) throw new Error(`instance_id inattendu : ${instanceId}`);
  const [, org, rest] = m;
  return `swebench/sweb.eval.x86_64.${org}_1776_${rest}`;
}

/**
 * Exécute pytest DANS le conteneur Docker sur le dépôt monté, via la commande
 * DEV `bench_bash_run`. Reproduit EXACTEMENT la commande de `prepare.runPytest`
 * (`--color=no`, `FORCE_COLOR=0` pour une sortie parsable sans ANSI).
 *
 * Le `bash` de l'hôte est utilisé : le cwd est le dossier du dépôt (validé côté
 * Rust), le dépôt est monté sur `/testbed` en lecture-écriture.
 */
/**
 * Extrait les chemins de fichiers ciblés par un patch unifié (en-têtes
 * `diff --git a/... b/...`). Sert à identifier les fichiers que le `test_patch`
 * officiel va rouvrir, pour les remettre au `base_commit` avant application.
 */
function parsePatchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) out.add(m[2]);
  }
  return [...out];
}

async function runDockerPytest(
  repoDir: string,
  image: string,
  tests: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  const testsArgs = tests.map(t => `"${t}"`).join(" ");
  const dockerCmd = [
    "docker", "run", "--rm", "--platform", "linux/amd64",
    "-e", "FORCE_COLOR=0", "-e", "NO_COLOR=1",
    "-v", `"${repoDir}:/testbed"`, "-w", "/testbed", `"${image}"`,
    "python", "-m", "pytest", testsArgs, "-rA", "-q", "-p", "no:cacheprovider", "--color=no",
  ].join(" ");
  const t0 = Date.now();
  const res = await invoke<BenchBashResult>("bench_bash_run", {
    command: dockerCmd, cwd: repoDir, timeoutMs,
  });
  return {
    stdout: res.stdout, stderr: res.stderr,
    exitCode: res.exit_code, timedOut: res.timed_out,
    durationMs: Date.now() - t0,
  };
}

/**
 * Exécute UNE tentative SWE-bench : VRAI agent sur le dépôt préparé, puis tests
 * DANS Docker. Ne lève jamais : toute erreur devient un `AttemptResult` classé.
 */
async function runOneSwe(
  inst: SweBenchInstance,
  opts: ResolvedSwebenchOptions,
  run: number,
): Promise<AttemptResult> {
  const task = toCodingTask(inst);
  const base: AttemptResult = {
    taskId: task.id, modelId: `cline:${opts.modelId}`, run,
    outcome: "harness-error", agentMs: 0, testMs: 0, failToPass: [], passToPass: [],
  };
  let errorMessage: string | undefined;
  const diagnostics: string[] = [];
  try {
    const envDir = await sweEnvDir(inst.instance_id, opts.envRoot);
    const repoDir = `${envDir}/repo`;
    const image = imageNameFor(inst.instance_id);

    // Vérifie que l'environnement préparé existe (fail-fast, message actionnable).
    const check = await invoke<BashResult>("agent_bash_run", {
      command: `test -f "${envDir}/.prepared" && printf ok`, cwd: ".",
    });
    if (check.stdout.trim() !== "ok") {
      base.outcome = "harness-error";
      base.error = `environnement non préparé : ${envDir} — lance \`npx tsx bench/coding/swebench/cli.ts --prepare-only --instances=${inst.instance_id}\``;
      return base;
    }

    // ── Reset du dépôt à l'état initial (protocole officiel) ────────────────
    // Chaque instance repart du `base_commit` PROPRE : on annule toute
    // modification laissée par l'instance précédente. Sans cela, les runs
    // s'enchaînent sur le même clone et se contaminent mutuellement.
    const reset = await invoke<BashResult>("agent_bash_run", {
      command: `git checkout --force ${inst.base_commit} && git checkout -- . && git clean -fdq -e .env -e '*.pyc'`,
      cwd: repoDir,
    });
    if (reset.exit_code !== 0) {
      diagnostics.push(`reset dépôt: ${(reset.stderr || reset.stdout).slice(0, 300)}`);
    }

    const clineProvider = resolveClineProvider(opts.providerId);
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
      else if (e.type === "step-finish") turns++;
      else if (e.type === "finish") {
        inputTokens += e.usage?.inputTokens ?? 0;
        outputTokens += e.usage?.outputTokens ?? 0;
      } else if (e.type === "error") errorMessage = e.message;
      else if (e.type === "terminal-output") diagnostics.push(e.chunk);
      else if (e.type === "notice") diagnostics.push(`${e.kind}: ${e.detail}`);
      if (e.type === "finish" || e.type === "error") done();
    };

    const handle = await startClineHarness({
      workspace: repoDir,
      providerId: clineProvider.providerId,
      baseUrl: clineProvider.baseUrl,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      systemPrompt: buildSystemPrompt("agent", true),
      mode: opts.mode ?? "act",
      // Borne la boucle d'outils : sans `done` explicite du modèle, le SDK
      // termine lui-même à cette limite (paramètre PUBLIC du contrat, pas une
      // modification du moteur). Évite un run qui ne converge jamais.
      maxIterations: opts.maxIterations,
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
      // Idem fixtures : `engine.send` n'acquitte qu'à la fin du tour (souvent
      // > 30 s) → SIDECAR_REPLY_TIMEOUT. On n'attend QUE la fin réelle de
      // l'agent (`finished`, posé par `finish`/`error`) ou le timer de tâche.
      void handle.send(task.instruction).catch((e) => {
        diagnostics.push(`send-ack: ${e instanceof Error ? e.message : String(e)}`);
      });
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

    // ── Remise à l'état officiel du protocole SWE-bench ─────────────────────
    // L'agent peut avoir modifié les fichiers de test (constaté : il le fait
    // parfois pour « faire passer » un test). Le protocole officiel IGNORE ces
    // modifications : il repart du `base_commit` pour les fichiers touchés par
    // le `test_patch`, puis applique le `test_patch` officiel. Sans cette étape,
    // le score est faussé (un test modifié par l'agent ne prouve rien).
    const testPatchFiles = parsePatchTargets(inst.test_patch);
    if (testPatchFiles.length > 0) {
      const restore = await invoke<BashResult>("agent_bash_run", {
        command:
          `git checkout --force ${inst.base_commit} -- ${testPatchFiles.map(f => `"${f}"`).join(" ")} ` +
          `&& git checkout -- ${testPatchFiles.map(f => `"${f}"`).join(" ")} ` +
          `&& git apply --whitespace=nowarn "${envDir}/test_patch.diff"`,
        cwd: repoDir,
      });
      if (restore.exit_code !== 0) {
        diagnostics.push(`restauration tests: ${(restore.stderr || restore.stdout).slice(0, 300)}`);
      }
    }

    // ── Tests DANS Docker, critères identiques au harnais Node ──────────────
    // Les FAIL_TO_PASS peuvent être non qualifiés (ex. sympy) : on préfixe les
    // noms par le fichier résolu via `testFilesFor` pour que pytest les cible.
    const qualifiedTests = inst.FAIL_TO_PASS.map(t => {
      if (t.includes("::")) return t;
      const files = testFilesFor(inst);
      return files.length > 0 ? `${files[0]}::${t}` : t;
    });
    const testRun = await runDockerPytest(repoDir, image, qualifiedTests, task.testTimeoutMs);
    base.testMs = testRun.durationMs;
    const parsed = parseTestOutcomes(testRun.stdout, testRun.stderr);
    const runShape = {
      exitCode: testRun.exitCode, stdout: testRun.stdout, stderr: testRun.stderr,
      timedOut: testRun.timedOut, durationMs: testRun.durationMs,
    };
    base.failToPass = evaluateCriteria(task.criteria.failToPass, parsed, runShape);
    base.passToPass = evaluateCriteria(task.criteria.passToPass, parsed, runShape);
    base.outcome = criteriaSatisfied(base.failToPass) && criteriaSatisfied(base.passToPass)
      ? "resolved" : "unresolved";
    // Le timeout de PILOTAGE ne doit pas effacer un résultat de test valide :
    // si les critères sont satisfaits, l'issue est résolue quel que soit le
    // temps qu'a mis l'agent (le protocole officiel ne note QUE les tests).
    // On conserve la trace du timeout à part, pour l'analyse.
    if (base.outcome !== "resolved" && errorMessage) {
      base.outcome = "agent-error";
      base.error = errorMessage;
    } else if (base.outcome === "resolved" && errorMessage) {
      base.error = `(timeout pendant le pilotage, patch valide) ${errorMessage}`;
    }
    if (base.outcome === "agent-error" && diagnostics.length > 0) {
      base.error = `${base.error ?? ""} | sidecar: ${dedupeDiagnostics(diagnostics)}`;
    }
    return base;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    base.outcome = "agent-error";
    return base;
  }
}

/**
 * Exécute les instances SWE-bench demandées, `runs` fois chacune. Les tests sont
 * exécutés DANS le conteneur Docker préparé. Options manquantes complétées depuis
 * la config de dev. Aucun dossier n'est supprimé : l'environnement préparé est
 * réutilisé tel quel (l'agent modifie le dépôt hôte, comme le protocole officiel).
 */
export async function runWebviewSwebench(opts: WebviewSwebenchOptions = {}): Promise<AttemptResult[]> {
  const resolved = await resolveSwebenchOptions(opts);
  const all = loadSwebenchInstances();
  const selected = resolved.instanceIds
    ? all.filter(i => resolved.instanceIds!.includes(i.instance_id))
    : all;
  const total = selected.length * resolved.runs;

  // Même raison que pour les fixtures : sans « Full Access », chaque écriture
  // déclenche un `ask` jamais résolu → timeout sidecar (30 s) et run perdu.
  // DEV-ONLY + restauré en `finally`.
  const previousMode = loadPermissionMode();
  savePermissionMode("full");
  try {
    const results: AttemptResult[] = [];
    let index = 0;
    for (const inst of selected) {
      for (let r = 1; r <= resolved.runs; r++) {
        index++;
        resolved.onProgress?.({ instanceId: inst.instance_id, run: r, index, total });
        results.push(await runOneSwe(inst, resolved, r));
      }
    }
    resolved.onExport?.("swebench-results.json", JSON.stringify(results, null, 2));
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
  const w = window as unknown as {
    __runBench?: (o?: WebviewBenchOptions) => Promise<AttemptResult[]>,
    __benchTasks?: () => CodingTask[],
    __runSweBench?: (o?: WebviewSwebenchOptions) => Promise<AttemptResult[]>,
    __sweBenchTasks?: () => CodingTask[],
    __sweBenchResults?: AttemptResult[],
    __runLcbBench?: (o: WebviewLcbOptions) => Promise<AttemptResult[]>,
    __lcbResult?: LcbProblem[],
    __lcbProblems?: LcbProblem[],
    __lcbCases?: Record<string, LcbCase[]>,
    __lcbResults?: AttemptResult[],
  };
  if (w.__runBench) return;
  w.__runBench = runWebviewBench;
  w.__benchTasks = loadWebviewTasks;
  w.__runSweBench = runWebviewSwebench;
  w.__sweBenchTasks = loadSwebenchTasks;
  w.__runLcbBench = runWebviewLcb;
  console.info("[bench] hooks dev prêts : `await __runBench()` (fixtures internes), `await __runSweBench()` (instances SWE-bench réelles), `await __runLcbBench({problems, cases})` (LiveCodeBench) — `__benchTasks()` / `__sweBenchTasks()` listent.");

  // Auto-run DEV optionnel : piloté par `VITE_BENCH_AUTORUN`. Sert à exécuter le
  // bench depuis la webview Tauri SANS clic manuel (le seul chemin honnête pour
  // la VRAIE boucle d'outils). Format : `taskIds` séparés par des virgules, ou
  // `all` pour tout. Aucun effet si la variable n'est pas définie.
  const autorun = import.meta.env.VITE_BENCH_AUTORUN as string | undefined;
  if (autorun) {
    const runs = Number(import.meta.env.VITE_BENCH_RUNS ?? "1") || 1;
    const suite = import.meta.env.VITE_BENCH_SUITE as string | undefined;
    const isSwe = suite === "swebench";
    const isLcb = suite === "livecodebench";
    const taskIds = autorun === "all" ? undefined : autorun.split(",").map(s => s.trim()).filter(Boolean);
    // Export des résultats hors webview : le harnais headless lit les lignes
    // `[info][bench-export] <nom> <JSON>` dans la sortie de `tauri dev`.
    const onExport: ExportSink | undefined = import.meta.env.VITE_BENCH_EXPORT
      ? (fileName, json) => {
          console.info(`[bench-export] ${fileName} ${json}`);
          void invoke("origin_log", { level: "info", target: "bench-export", message: `${fileName} ${json}` }).catch(() => undefined);
        }
      : undefined;
    const exportResults = (results: AttemptResult[]): void => {
      w.__sweBenchResults = results;
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
    };

    if (isLcb) {
      // LiveCodeBench : l'échantillon vit sur disque en LOTS (`--shard-size`).
      // `autorun` liste les chemins de lots (séparés par des virgules) ; on les
      // enchaîne et on fusionne les résultats. Chaque lot est lu via `read_file`
      // (jamais de décodage encodé dans la webview).
      void (async () => {
        try {
          const repoRoot = await resolveRepoRoot();
          const shardPaths = autorun.split(",").map(s => s.trim()).filter(Boolean);
          const all: AttemptResult[] = [];
          for (const rel of shardPaths) {
            const abs = rel.startsWith("/") ? rel : `${repoRoot}/${rel}`;
            const { problems, cases } = await loadLcbShardViaTauri(abs, repoRoot);
            console.info(`[bench] LCB lot ${rel} : ${problems.length} problème(s)`);
            const res = await runWebviewLcb({ problems, cases, runs, onExport });
            all.push(...res);
          }
          exportResults(all);
          onExport?.("lcb-results.json", JSON.stringify(all, null, 2));
        } catch (e) {
          console.error("[bench] auto-run LCB échoué :", e instanceof Error ? e.message : e);
          void invoke("origin_log", { level: "error", target: "bench", message: `auto-run LCB échoué : ${e instanceof Error ? e.message : e}` }).catch(() => undefined);
        }
      })();
      return;
    }

    console.info(`[bench] auto-run : suite=${isSwe ? "swebench" : "fixtures"} tâches=${autorun} runs=${runs}`);
    const exec = isSwe
      ? runWebviewSwebench({ instanceIds: taskIds, runs, onExport })
      : runWebviewBench({ taskIds, runs, onExport });
    void exec.then(exportResults).catch((e) => {
      console.error("[bench] auto-run échoué :", e instanceof Error ? e.message : e);
      void invoke("origin_log", { level: "error", target: "bench", message: `auto-run échoué : ${e instanceof Error ? e.message : e}` }).catch(() => undefined);
    });
  }
}
