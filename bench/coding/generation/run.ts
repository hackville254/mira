#!/usr/bin/env node
// ── Génération de fonctions — RUNNER CLI (HumanEval+ / MBPP+) ─────────────────
//
// Évalue la génération de fonctions EvalPlus en deux MODES SÉPARÉS :
//   --mode=model-only  : le modèle SEUL (HTTP Chat Completions standardisé) ;
//   --mode=agent       : le SYSTÈME ORVYX Code complet (moteur Cline + outils).
//   --mode=both        : les deux, avec les MÊMES tâches et le MÊME évaluateur.
//
// Exemples :
//   # Mode rapide (sous-ensemble reproductible + model-only)
//   npx tsx bench/coding/generation/run.ts --mode=model-only --benchmark=humanevalplus --limit=5
//
//   # Mode complet (tout le benchmark + les deux modes)
//   npx tsx bench/coding/generation/run.ts --mode=both --benchmark=humanevalplus
//
//   # Reprendre une campagne interrompue (saute les tentatives déjà écrites)
//   npx tsx bench/coding/generation/run.ts --mode=model-only --benchmark=mbppplus --resume
//
// SÉCURITÉ
//  - La clé d'API vient de `.env` / `ORVYX_AI_*` ; elle n'est JAMAIS journalisée
//    ni écrite dans un résultat (garde-fou dans `results.ts`).
//  - Le code généré n'est JAMAIS exécuté sur l'hôte : uniquement dans Docker
//    verrouillé (`evaluator.ts`).
//  - L'agent travaille dans un workspace JETABLE, jamais dans le dépôt réel.

import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { ClineSidecarClient } from "../headless/clineSidecar";
import { resolveClineProvider } from "../../../src/lib/agent/providers";
import { loadTasks, selectTasks, DATASET_VERSIONS } from "./dataset";
import { extractCode, runGeneration, classifyOutcome, GEN_IMAGE } from "./evaluator";
import { callModelOnly } from "./modelOnly";
import { runAgentOnTask } from "./agent";
import { appendAttempt, loadDoneKeys, attemptKey } from "./results";
import {
  summarizeGeneration,
  writeGenerationReport,
  formatGenerationTable,
  formatErrorBreakdown,
  type TokenTariff,
} from "./report";
import {
  resultsFileName,
  type EvalMode,
  type GenerationAttempt,
  type GenerationBenchmark,
  type GenerationTask,
} from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const OUT_DIR = join(HERE, "..", "results");
const SIDECAR = join(ROOT, "src-tauri", "cline-sidecar", "dist", "index.mjs");

interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** Lit `.env` sans écraser `process.env`. Ne journalise JAMAIS la clé. */
async function loadAiConfig(): Promise<AiConfig> {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, k, raw] = m;
      const v = raw.replace(/^["']|["']$/g, "");
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  const provider = process.env.ORVYX_AI_PROVIDER ?? "";
  const model = process.env.ORVYX_AI_MODEL ?? "";
  const apiKey = process.env.ORVYX_AI_API_KEY ?? "";
  const baseUrl = process.env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";
  if (!provider || !model || !apiKey) {
    throw new Error("config IA incomplète : ORVYX_AI_PROVIDER / _MODEL / _API_KEY requis dans `.env`");
  }
  return { provider, model, apiKey, baseUrl };
}

function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

/**
 * Instruction envoyée au modèle/agent — IDENTIQUE dans les deux modes (seule
 * cette condition rend la comparaison model-only vs agent interprétable).
 */
function taskInstruction(task: GenerationTask): string {
  return [
    "Implémente la fonction Python demandée.",
    "Réponds UNIQUEMENT avec un bloc de code Python complet (aucune explication).",
    "Ne modifie pas la signature de la fonction.",
    "",
    task.prompt,
  ].join("\n");
}

/** Prompt système minimal, identique dans les deux modes. */
function systemPrompt(): string {
  return [
    "Tu es un expert en programmation Python.",
    "Tu réponds UNIQUEMENT par un bloc de code Python complet, sans explication.",
  ].join("\n");
}

/** Tarif optionnel depuis l'environnement (sinon coût = inconnu). */
function loadTariff(): TokenTariff | undefined {
  const inP = process.env.ORVYX_BENCH_PRICE_INPUT_PER_M;
  const outP = process.env.ORVYX_BENCH_PRICE_OUTPUT_PER_M;
  const src = process.env.ORVYX_BENCH_PRICE_SOURCE;
  if (!inP || !outP) return undefined;
  return {
    inputPerMillion: Number(inP),
    outputPerMillion: Number(outP),
    source: src ?? "ORVYX_BENCH_PRICE_* (env)",
  };
}

interface RunOptions {
  benchmark: GenerationBenchmark;
  modes: EvalMode[];
  limit?: number;
  taskIds?: string[];
  runs: number;
  resume: boolean;
  maxTokens: number;
  maxIterations: number;
  agentTimeoutMs: number;
  evalTimeoutMs: number;
}

async function parseOptions(args: string[]): Promise<RunOptions> {
  const modeArg = argValue(args, "mode") ?? "model-only";
  const modes: EvalMode[] =
    modeArg === "both" ? ["model-only", "agent"] :
    modeArg === "agent" ? ["agent"] : ["model-only"];

  const benchArg = argValue(args, "benchmark") ?? "humanevalplus";
  if (benchArg !== "humanevalplus" && benchArg !== "mbppplus") {
    throw new Error(`--benchmark invalide : ${benchArg} (attendu : humanevalplus | mbppplus)`);
  }
  const limitRaw = argValue(args, "limit");
  const taskIds = argValue(args, "tasks")?.split(",").map(s => s.trim()).filter(Boolean);

  return {
    benchmark: benchArg,
    modes,
    limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
    taskIds,
    runs: Math.max(1, Number(argValue(args, "runs") ?? 1)),
    resume: args.includes("--resume"),
    maxTokens: Math.max(64, Number(argValue(args, "max-tokens") ?? 1024)),
    maxIterations: Math.max(1, Number(argValue(args, "max-iterations") ?? 15)),
    agentTimeoutMs: Number(argValue(args, "timeout-ms") ?? 5 * 60 * 1000),
    evalTimeoutMs: Number(argValue(args, "eval-timeout-ms") ?? 60_000),
  };
}

/**
 * Évalue UNE tâche dans UN mode et renvoie la tentative (jamais d'exception :
 * toute erreur est classée dans la tentative).
 */
async function runOne(
  task: GenerationTask,
  mode: EvalMode,
  modelLabel: string,
  provider: string,
  run: number,
  subset: boolean,
  cfg: AiConfig,
  opts: RunOptions,
  client: ClineSidecarClient | null,
): Promise<GenerationAttempt> {
  const base: GenerationAttempt = {
    taskId: task.taskId,
    benchmark: task.benchmark,
    datasetVersion: task.datasetVersion,
    evalMode: mode,
    modelId: modelLabel,
    provider,
    run,
    subset,
    resolved: false,
    metrics: { totalMs: 0, generationMs: 0, evalMs: 0, modelCalls: 0, toolCalls: 0 },
  };

  const t0 = Date.now();
  let producedText = "";
  let providerErrorClass: "provider" | "timeout" | "truncated" | "orchestration" | "tool" | undefined;
  let providerError: string | undefined;
  let httpStatus: number | undefined;

  if (mode === "model-only") {
    const r = await callModelOnly({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      system: systemPrompt(),
      user: taskInstruction(task),
      maxTokens: opts.maxTokens,
    });
    producedText = r.text;
    base.metrics.generationMs = r.metrics.totalMs;
    base.metrics.ttftMs = r.metrics.ttftMs;
    base.metrics.inputTokens = r.metrics.inputTokens;
    base.metrics.outputTokens = r.metrics.outputTokens;
    base.metrics.modelCalls = 1;
    providerErrorClass = r.errorClass;
    providerError = r.error;
    httpStatus = r.httpStatus;
  } else {
    if (!client) throw new Error("client sidecar requis en mode agent");
    const clineProvider = resolveClineProvider(cfg.provider);
    const r = await runAgentOnTask(client, {
      sidecarPath: SIDECAR,
      dataDir: join(tmpdir(), "orvyx-gen-cline"),
      providerId: clineProvider.providerId,
      baseUrl: clineProvider.baseUrl,
      apiKey: cfg.apiKey,
      modelId: cfg.model,
      systemPrompt: systemPrompt(),
      instruction: taskInstruction(task),
      maxIterations: opts.maxIterations,
      timeoutMs: opts.agentTimeoutMs,
    });
    producedText = r.text;
    base.metrics.generationMs = r.metrics.totalMs;
    base.metrics.ttftMs = r.metrics.ttftMs;
    base.metrics.modelCalls = r.metrics.turns;
    base.metrics.toolCalls = r.metrics.toolCalls;
    base.metrics.inputTokens = r.metrics.inputTokens || undefined;
    base.metrics.outputTokens = r.metrics.outputTokens || undefined;
    providerErrorClass = r.errorClass;
    providerError = r.error;
  }

  const code = extractCode(producedText);
  const hadCode = code.trim().length > 0;
  base.code = code.slice(0, 2000);

  const tEval = Date.now();
  const evalResult = await runGeneration(task, code, { timeoutMs: opts.evalTimeoutMs, image: GEN_IMAGE });
  base.metrics.evalMs = Date.now() - tEval;
  base.metrics.totalMs = Date.now() - t0;

  const cls = classifyOutcome({ evalResult, hadCode, providerErrorClass, providerError });
  base.resolved = cls.resolved;
  base.errorClass = cls.errorClass;
  base.error = cls.error;
  if (httpStatus !== undefined) base.httpStatus = httpStatus;

  return base;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = await parseOptions(args);
  const cfg = await loadAiConfig();
  const modelLabel = `orvyx-code/${cfg.model}`;
  const tariff = loadTariff();

  const all = await loadTasks(opts.benchmark);
  const tasks = selectTasks(all, { limit: opts.limit, taskIds: opts.taskIds });
  const subset = tasks.length < all.length;

  console.log("═".repeat(78));
  console.log("Génération de fonctions — benchmark EvalPlus (HumanEval+ / MBPP+)");
  console.log(`benchmark    : ${opts.benchmark} (${DATASET_VERSIONS[opts.benchmark]})`);
  console.log(`tâches       : ${tasks.length}/${all.length}${subset ? "  [SOUS-ENSEMBLE — pas un score complet]" : "  [benchmark complet]"}`);
  console.log(`modes        : ${opts.modes.join(", ")}`);
  console.log(`modèle       : ${modelLabel} (provider=${cfg.provider})`);
  console.log(`répétitions  : ${opts.runs}  max_tokens : ${opts.maxTokens}`);
  console.log(`évaluateur   : Docker (${GEN_IMAGE}), programme de test OFFICIEL EvalPlus`);
  console.log("═".repeat(78));

  await mkdir(OUT_DIR, { recursive: true });

  // Un client sidecar par campagne, uniquement si le mode agent est demandé.
  let client: ClineSidecarClient | null = null;
  if (opts.modes.includes("agent")) {
    const dataDir = join(tmpdir(), `orvyx-gen-cline-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    client = new ClineSidecarClient({
      sidecarPath: SIDECAR,
      dataDir,
      onLog: m => console.log(`   [client] ${m}`),
      approvalPolicy: req => {
        console.log(`   [approve] ${req.toolName}`);
        return true;
      },
    });
    await client.start();
  }

  try {
    for (const mode of opts.modes) {
      const outFile = join(OUT_DIR, resultsFileName(opts.benchmark, mode));
      const done = opts.resume ? await loadDoneKeys(outFile) : new Set<string>();
      if (opts.resume && done.size > 0) {
        console.log(`\n# reprise ${mode} : ${done.size} tentative(s) déjà présente(s) dans ${outFile}`);
      }

      for (const task of tasks) {
        for (let r = 1; r <= opts.runs; r++) {
          const probeKey = attemptKey({
            benchmark: opts.benchmark, evalMode: mode, modelId: modelLabel, run: r, taskId: task.taskId,
          });
          if (done.has(probeKey)) {
            console.log(`   · ${mode} ${task.taskId} #${r} — déjà fait, sauté`);
            continue;
          }
          console.log(`\n── [${mode}] ${task.taskId} run ${r}/${opts.runs}`);
          const attempt = await runOne(task, mode, modelLabel, cfg.provider, r, subset, cfg, opts, client);
          await appendAttempt(outFile, attempt);
          const mark = attempt.resolved ? "✓" : `✗ (${attempt.errorClass ?? "?"})`;
          console.log(
            `   → ${mark} gen=${Math.round(attempt.metrics.generationMs / 1000)}s ` +
            `eval=${Math.round(attempt.metrics.evalMs / 1000)}s ` +
            `tours=${attempt.metrics.modelCalls} outils=${attempt.metrics.toolCalls}`,
          );
        }
      }

      // Rapport recalculé sur l'ensemble des lignes du fichier (y compris les
      // tentatives des campagnes précédentes).
      const { loadExisting } = await import("./results");
      const attempts = await loadExisting(outFile);
      const report = summarizeGeneration(attempts, tariff);
      await writeGenerationReport(report, join(OUT_DIR, `generation-${mode}-${opts.benchmark}-report.json`));
      console.log(`\n## ${mode} — ${opts.benchmark}`);
      console.log(formatGenerationTable(report));
      for (const g of report.groups) {
        console.log(`   ventilation échecs (${g.modelId}) : ${formatErrorBreakdown(g)}`);
      }
      console.log(`   résultats JSONL : ${outFile}`);
    }
  } finally {
    await client?.dispose();
  }
}

void main().catch(e => {
  console.error(`ERREUR FATALE : ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
