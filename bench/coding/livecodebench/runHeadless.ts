/**
 * Origin — Runner LiveCodeBench HEADLESS (agent réel, sans Tauri).
 *
 * POURQUOI
 * --------
 * `benchLcb.ts` pilote l'agent DEPUIS LA WEBVIEW (il appelle `invoke`), donc il
 * dépend de l'UI et n'est pas exécutable en CI. Ce runner reproduit le même
 * protocole LiveCodeBench — instruction identique, extraction du code, notation
 * dans Docker verrouillé — mais il pilote le VRAI moteur Cline via le client
 * headless NDJSON (`bench/coding/headless/clineSidecar.ts`), exactement comme le
 * sidecar lancé par Rust.
 *
 * PROTOCOLE (identique au benchmark officiel)
 * -------------------------------------------
 *   1. l'agent reçoit l'énoncé + le `starter_code` et produit UNE solution ;
 *   2. on extrait le premier bloc ```python``` (ou toute la réponse) ;
 *   3. on exécute la solution contre TOUS les cas (publics + privés) dans un
 *      conteneur verrouillé (réseau coupé, limites mémoire/CPU/PID, lecture
 *      seule, non-root) ;
 *   4. un problème est « résolu » seulement si 100 % des cas passent.
 *
 * SÉCURITÉ
 * --------
 *  - la clé API ne quitte jamais ce process (jamais journalisée) ;
 *  - le code généré n'est JAMAIS exécuté sur l'hôte : uniquement dans Docker ;
 *  - le prompt de l'agent lui interdit d'exécuter des commandes : il doit
 *    seulement rendre du code. Même s'il en exécute, l'approbation headless
 *    reste locale et journalisée, sans effet hors du workspace jetable.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { ClineSidecarClient } from "../headless/clineSidecar";
import { searchIndex } from "../headless/codeSearch";
import type { ConvergenceReport } from "../headless/convergence";
import { resolveClineProvider } from "../../../src/lib/agent/providers";
import { summarize, writeReport, formatTable, type BenchReport } from "../report";
import type { AttemptResult } from "../types";
import {
  extractCode,
  isResolved,
  runSolution,
  LCB_IMAGE,
  type LcbEvalResult,
} from "./evaluator";
import {
  loadPayload,
  payloadToInstance,
  validateInstance,
  type LcbInstance,
} from "./instance";
import { detectContract } from "./contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RESULTS_DIR = join(HERE, "..", "results");
const SHARDS_DIR = join(RESULTS_DIR, "lcb-shards");
const SIDECAR = join(ROOT, "src-tauri", "cline-sidecar", "dist", "index.mjs");

/** Configuration IA lue depuis `.env` (jamais imprimée, clé exclue des logs). */
interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
}

/** Lit `.env` sans écraser `process.env` puis extrait la config IA. */
async function loadAiConfig(): Promise<AiConfig> {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
  const provider = process.env.ORVYX_AI_PROVIDER ?? "";
  const model = process.env.ORVYX_AI_MODEL ?? "";
  const apiKey = process.env.ORVYX_AI_API_KEY ?? "";
  if (!provider || !model || !apiKey) {
    throw new Error("config IA incomplète : ORVYX_AI_PROVIDER/_MODEL/_API_KEY requis dans `.env`");
  }
  return { provider, model, apiKey };
}

/** Extrait `--clé=valeur` de la ligne de commande. */
function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

/** Une tentative LiveCodeBench (métriques de l'agent incluses). */
interface LcbAttempt extends AttemptResult {
  /** Identifiant du problème. */
  taskId: string;
  /** Nombre de cas réussis / total. */
  passed: number;
  total: number;
  /** Contrat de sortie appliqué (traçabilité du format attendu). */
  contract?: "functional" | "stdin" | "interactive";
  /** Vrai si le problème a été EXCLU du score (interactif, non évaluable). */
  skipped?: boolean;
  /** Motif de fin du moteur (`completed`/`max_iterations`/`error`/…). */
  stopReason?: string;
  /** Signal de non-convergence (boucle d'outil / exploration stérile). */
  convergence?: ConvergenceReport;
}

/**
 * Instruction LiveCodeBench — le contrat de sortie dépend du PROBLÈME :
 *  - `functional` : la réponse doit définir `class Solution` ;
 *  - `stdin`      : la réponse doit être un PROGRAMME COMPLET lisant stdin.
 *
 * Envoyer la mauvaise consigne provoquait 6 faux négatifs (AtCoder jugé avec le
 * contrat LeetCode). L'instruction est donc dérivée du même `detectContract()`
 * que l'évaluateur : consigne et notation ne peuvent plus diverger.
 */
function lcbInstruction(inst: LcbInstance): string {
  const contract = detectContract(inst);
  const lines = ["Résous le problème de programmation suivant en Python."];
  if (contract === "stdin") {
    lines.push(
      "Réponds UNIQUEMENT avec un PROGRAMME Python complet.",
      "Le programme lit ses entrées sur l'entrée standard (sys.stdin) et écrit le résultat",
      "sur la sortie standard (print). Il ne doit PAS définir de classe Solution.",
      "N'exécute aucune commande : donne juste le programme.",
    );
  } else {
    lines.push(
      "Réponds UNIQUEMENT avec un bloc de code Python complet (classe `Solution`).",
      "N'exécute aucune commande : donne juste la solution.",
    );
  }
  lines.push("", `Titre : ${inst.question_title}`, "", inst.question_content);
  if (inst.starter_code.trim()) {
    lines.push("", "Code de départ :", "```python", inst.starter_code, "```");
  }
  return lines.join("\n");
}

/** Prompt système minimal pour le mode headless (aucune indication de solution). */
function buildAgentSystemPrompt(): string {
  return [
    "Tu es un expert en algorithmique qui résout des problèmes de programmation.",
    "Tu réponds UNIQUEMENT par un bloc de code Python complet, sans exécuter de commande.",
    "Adapte le format demandé : classe `Solution` ou programme complet sur stdin selon la consigne.",
  ].join("\n");
}

/** Charge les instances depuis tous les shards (ou un payload unique). */
async function loadInstances(only?: string[]): Promise<LcbInstance[]> {
  const files = existsSync(SHARDS_DIR)
    ? (await readdir(SHARDS_DIR)).filter(f => f.endsWith(".json")).sort()
    : [];
  const paths = files.length > 0
    ? files.map(f => join(SHARDS_DIR, f))
    : [join(RESULTS_DIR, "lcb-payload.json")];

  const out: LcbInstance[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const payload = await loadPayload(p);
    for (const problem of payload.problems) {
      const id = String(problem.question_id);
      if (seen.has(id)) continue;
      if (only && only.length > 0 && !only.includes(id)) continue;
      const inst = payloadToInstance(problem, payload.cases[id] ?? []);
      validateInstance(inst);
      seen.add(id);
      out.push(inst);
    }
  }
  out.sort((a, b) => a.question_id.localeCompare(b.question_id));
  return out;
}

/**
 * Exécute UN problème : l'agent produit une solution, on l'extrait, puis on la
 * note dans Docker. Ne lève jamais : toute erreur devient une tentative classée.
 */
async function runOne(
  inst: LcbInstance,
  client: ClineSidecarClient,
  cfg: AiConfig,
  modelLabel: string,
  opts: { maxIterations: number; timeoutMs: number; evalTimeoutMs: number; run: number },
): Promise<LcbAttempt> {
  const attempt: LcbAttempt = {
    taskId: inst.question_id,
    modelId: modelLabel,
    run: opts.run,
    outcome: "harness-error",
    agentMs: 0,
    testMs: 0,
    failToPass: [],
    passToPass: [],
    passed: 0,
    total: inst.cases.length,
  };

  // Workspace jetable : l'agent n'écrit nulle part ailleurs.
  const workspace = await mkdtempDir();
  const clineProvider = resolveClineProvider(cfg.provider);
  const tAgent = Date.now();
  let run: Awaited<ReturnType<ClineSidecarClient["runTurn"]>> | null = null;
  try {
    run = await client.runTurn(
      {
        cwd: workspace,
        providerId: clineProvider.providerId,
        baseUrl: clineProvider.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.model,
        systemPrompt: buildAgentSystemPrompt(),
        mode: "act",
        maxIterations: opts.maxIterations,
      },
      lcbInstruction(inst),
    );
    const timer = setTimeout(() => { void run?.abort(); }, opts.timeoutMs);
    try {
      await run.finished;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    attempt.error = `agent : ${e instanceof Error ? e.message : String(e)}`;
    attempt.agentMs = Date.now() - tAgent;
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    attempt.outcome = "agent-error";
    return attempt;
  }
  attempt.agentMs = Date.now() - tAgent;
  attempt.turns = run.metrics.turns;
  attempt.toolCalls = run.metrics.toolCalls;
  attempt.inputTokens = run.metrics.inputTokens;
  attempt.outputTokens = run.metrics.outputTokens;
  attempt.stopReason = run.metrics.stopReason;
  attempt.convergence = run.metrics.convergence;
  if (run.metrics.error) attempt.error = `agent : ${run.metrics.error}`;

  // ── Notation : code extrait → Docker verrouillé ───────────────────────────
  attempt.contract = detectContract(inst);
  const code = extractCode(run.finalText ?? "");
  let evalResult: LcbEvalResult;
  const tTest = Date.now();
  try {
    if (!code.trim()) {
      evalResult = { passed: 0, total: inst.cases.length, failed: [], error: "aucun code produit" };
    } else {
      evalResult = await runSolution(inst, code, { timeoutMs: opts.evalTimeoutMs, image: LCB_IMAGE });
    }
  } catch (e) {
    evalResult = {
      passed: 0, total: inst.cases.length, failed: [],
      error: `notation : ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  attempt.testMs = Date.now() - tTest;
  attempt.passed = evalResult.passed;
  attempt.total = evalResult.total;
  attempt.skipped = evalResult.skipped === true;
  attempt.outcome = isResolved(evalResult) ? "resolved" : "unresolved";
  if (evalResult.error && !attempt.error) attempt.error = evalResult.error;
  console.log(
    `   [eval] contrat=${attempt.contract} passed=${evalResult.passed}/${evalResult.total} ` +
    `failed=[${evalResult.failed.join(",")}]${attempt.skipped ? " EXCLU" : ""} err=${evalResult.error ?? "-"}`,
  );

  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  return attempt;
}

/** Crée un dossier temporaire unique pour un run. */
async function mkdtempDir(): Promise<string> {
  const dir = join(tmpdir(), `orvyx-lcb-headless-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Résumé LCB : taux de résolution + cas réussis (jamais de score inventé). */
function summarizeLcb(attempts: LcbAttempt[]): BenchReport {
  return summarize(attempts, () => "feature");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cfg = await loadAiConfig();
  const modelLabel = `orvyx-code/${cfg.model}`;
  const maxIterations = Number(argValue(args, "max-iterations") ?? 20);
  const timeoutMs = Number(argValue(args, "timeout-ms") ?? 10 * 60 * 1000);
  const evalTimeoutMs = Number(argValue(args, "eval-timeout-ms") ?? 60_000);
  const runs = Math.max(1, Number(argValue(args, "runs") ?? 1));
  const only = argValue(args, "problems")?.split(",").map(s => s.trim()).filter(Boolean);

  const instances = await loadInstances(only);
  if (instances.length === 0) throw new Error("aucun problème LiveCodeBench chargé");

  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(`# LiveCodeBench headless — ${instances.length} problème(s), ${runs} run(s)`);
  console.log(`# modèle=${cfg.model} provider=${cfg.provider} node=${process.version}`);
  console.log(`# sidecar=${SIDECAR}`);

  const dataDir = join(tmpdir(), `orvyx-lcb-cline-${Date.now()}`);
  const client = new ClineSidecarClient({
    sidecarPath: SIDECAR,
    dataDir,
    onLog: m => console.log(`   [client] ${m}`),
    onEvent: () => {},
    approvalPolicy: req => {
      console.log(`   [approve] ${req.toolName}`);
      return true;
    },
    // Recherche de code BM25 en Node pur : rend `codebase_search` fonctionnel en
    // headless (sans Tauri), comme en production.
    onToolInvoke: async (command, args) => {
      if (command !== "search_index") throw new Error(`commande non supportée en headless : ${command}`);
      const workspace = typeof args.workspace === "string" ? args.workspace : "";
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : 12;
      const hits = await searchIndex(workspace, query, limit);
      return JSON.stringify(hits);
    },
  });
  await client.start();

  const attempts: LcbAttempt[] = [];
  const persist = async (): Promise<void> => {
    await writeFile(
      join(RESULTS_DIR, "lcb-headless-results.json"),
      JSON.stringify(attempts, null, 2),
      "utf8",
    );
    const report = summarizeLcb(attempts);
    await writeReport(report, join(RESULTS_DIR, "lcb-report.json"));
    console.log("\n" + formatTable(report));
  };

  try {
    for (const inst of instances) {
      for (let r = 1; r <= runs; r++) {
        console.log(`\n── ${inst.question_id} [${inst.difficulty}] ${inst.question_title} (${inst.cases.length} cas) run ${r}/${runs}`);
        const a = await runOne(inst, client, cfg, modelLabel, { maxIterations, timeoutMs, evalTimeoutMs, run: r });
        attempts.push(a);
        console.log(
          `   → ${a.outcome} | cas=${a.passed}/${a.total} tours=${a.turns ?? 0} outils=${a.toolCalls ?? 0} ` +
          `in=${a.inputTokens ?? 0} out=${a.outputTokens ?? 0} agent=${Math.round(a.agentMs / 1000)}s eval=${Math.round(a.testMs / 1000)}s` +
          (a.stopReason ? ` | fin=${a.stopReason}` : "") +
          (a.convergence?.loopDetected ? ` | boucle_outil=${a.convergence.maxConsecutiveSameTool}` : "") +
          (a.convergence?.stalled ? " | exploration_stérile" : ""),
        );
        await persist();
      }
    }
  } finally {
    await client.dispose();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  const resolved = attempts.filter(a => a.outcome === "resolved").length;
  console.log(`\n# terminé : ${resolved}/${attempts.length} résolue(s)`);
}

void main().catch(e => {
  console.error(`ERREUR FATALE : ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
