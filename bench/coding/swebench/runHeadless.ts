#!/usr/bin/env node
// ── SWE-bench — RUNNER HEADLESS (agent réel + tests Docker officiels) ────────
//
// POURQUOI UN RUNNER HEADLESS (et pas la webview)
// -----------------------------------------------
// Le premier essai pilotait le moteur depuis la webview Tauri : ça dépend du
// montage React, de l'injection `import.meta.env` et du focus fenêtre — fragile
// et impossible en CI. Or le moteur Cline est un process Node AUTONOME
// (`src-tauri/cline-sidecar/dist/index.mjs`) parlant NDJSON sur stdio ; Rust ne
// fait que relayer vers la webview. Ce runner reproduit ce rôle de relais en
// Node pur (`headless/clineSidecar.ts`) : il exécute donc le VRAI moteur, avec le
// VRAI modèle et les VRAIS exécuteurs d'outils, sans aucune dépendance à l'UI.
//
// PROTOCOLE OFFICIEL REPRODUIT
// ----------------------------
//   1. Le dépôt préparé est remis au `base_commit` PROPRE (reset).
//   2. L'agent travaille dans ce dépôt (workspace = `<envDir>/repo`).
//   3. Le `model_patch` est capturé (git diff) → `predictions.jsonl`.
//   4. Les fichiers du `test_patch` sont restaurés au `base_commit`, puis le
//      `test_patch` OFFICIEL est appliqué (les modifs de tests par l'agent sont
//      ignorées, comme le fait l'évaluation officielle).
//   5. pytest tourne DANS l'image Docker officielle, sur le dépôt monté.
//   6. FAIL_TO_PASS / PASS_TO_PASS sont jugés avec la MÊME logique pure que le
//      harnais Node (`evaluatorCore`).
//
// SÉCURITÉ
// --------
//  - La clé d'API vient de `.env` (ORVYX_AI_*), n'est JAMAIS journalisée ni
//    écrite dans un résultat. `model_name_or_path` est un libellé public.
//  - `CLINE_DIR` est isolé dans un dossier jetable du run ; aucun process
//    orphelin (kill du groupe à la fin).
//  - Aucun coût caché : ce runner appelle réellement le modèle (opt-in explicite
//    par la présence des variables d'environnement).
//
// Usage :
//   node --import tsx bench/coding/swebench/runHeadless.ts --all
//   node --import tsx bench/coding/swebench/runHeadless.ts --instances=id1,id2
//   ... --runs=1 --max-iterations=40 --timeout-ms=1800000

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { ClineSidecarClient, type HeadlessRunMetrics } from "../headless/clineSidecar";
import { validateInstance, testFilesFor, type SweBenchInstance } from "./instance";
import { ensureArmed, officialImageName } from "./prepare";
import { captureModelPatch, writePredictions, type Prediction } from "./predictions";
import { parseTestOutcomes, evaluateCriteria, criteriaSatisfied } from "../evaluatorCore";
import { resolveClineProvider } from "../../../src/lib/agent/providers";
import { summarize, writeReport, formatTable } from "../report";
import type { AttemptResult } from "../types";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");           // racine du dépôt `origin`
const INSTANCES_DIR = join(HERE, "instances");
const ENV_ROOT = join(HERE, ".envs");
const RESULTS_DIR = join(HERE, "..", "results");
const SIDECAR = join(ROOT, "src-tauri", "cline-sidecar", "dist", "index.mjs");

/** Configuration AI lue du `.env` (jamais journalisée dans son ensemble). */
interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Lit `.env` SANS écraser l'environnement déjà défini. On ne journalise JAMAIS
 * la clé. Un fichier absent n'est pas une erreur : on retombe sur `process.env`.
 */
async function loadAiConfig(): Promise<AiConfig> {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, k, rawV] = m;
      const v = rawV.replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  }
  const provider = process.env.ORVYX_AI_PROVIDER ?? "";
  const model = process.env.ORVYX_AI_MODEL ?? "";
  const apiKey = process.env.ORVYX_AI_API_KEY ?? "";
  const baseUrl = process.env.ORVYX_AI_BASE_URL || undefined;
  if (!provider || !model || !apiKey) {
    throw new Error("config AI incomplète : renseigne ORVYX_AI_PROVIDER / _MODEL / _API_KEY dans .env");
  }
  return { provider, model, apiKey, baseUrl };
}

function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

/** Charge les instances demandées (toutes par défaut), triées par id. */
async function loadInstances(only?: string[]): Promise<SweBenchInstance[]> {
  const files = (await readdir(INSTANCES_DIR)).filter(f => f.endsWith(".json"));
  const out: SweBenchInstance[] = [];
  for (const f of files) {
    const p = join(INSTANCES_DIR, f);
    const inst = validateInstance(JSON.parse(await readFile(p, "utf8")), p);
    if (!only || only.includes(inst.instance_id)) out.push(inst);
  }
  out.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  return out;
}

/** Quote des arguments pour un shell POSIX (usage dans un `bash -lc`). */
function shellJoin(args: string[]): string {
  return args.map(a => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Extrait les fichiers ciblés par un patch unifié (`diff --git a/… b/…`). */
function parsePatchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) out.add(m[2]);
  }
  return [...out];
}

/** Exécute une commande git dans `cwd` (best-effort, timeout borné). */
async function git(args: string[], cwd: string, timeout = 120_000): Promise<{ ok: boolean; err: string }> {
  try {
    await exec("git", args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, err: (err.stderr ?? err.message ?? "").slice(0, 400) };
  }
}

/**
 * Exécute pytest DANS l'image officielle, dépôt monté sur `/testbed`.
 * Réutilise `officialImageName` (même image que la préparation).
 */
async function runDockerPytest(
  repoDir: string,
  image: string,
  testsArgs: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await exec(
      "docker",
      ["run", "--rm", "--platform", "linux/amd64",
        "-e", "FORCE_COLOR=0", "-e", "NO_COLOR=1",
        "-v", `${repoDir}:/testbed`, "-w", "/testbed", image,
        // Le `python` par défaut des images officielles est celui de base,
        // SANS les dépendances du dépôt : les tests DOIVENT tourner dans
        // l'environnement conda `testbed` (comportement du harnais officiel).
        "bash", "-lc",
        `source /opt/miniconda3/bin/activate testbed && python -m pytest ${shellJoin(testsArgs)} -rA -q -p no:cacheprovider --color=no`],
      { cwd: repoDir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    return { stdout, stderr, exitCode: 0, durationMs: Date.now() - t0 };
  } catch (e) {
    // pytest != 0 : `execFile` rejette mais fournit stdout/stderr — c'est un
    // RÉSULTAT de test, pas une erreur de banc.
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "", stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
      durationMs: Date.now() - t0,
    };
  }
}

/** Une issue classée pour UNE tentative (jamais de score inventé). */
interface SweAttempt extends AttemptResult {
  /** Patch produit par l'agent (format officiel). */
  modelPatch?: string;
  /** Métriques brutes du run headless. */
  metrics?: HeadlessRunMetrics;
}

/**
 * Exécute UNE instance avec le VRAI agent headless puis les tests Docker.
 * Ne lève jamais : toute erreur devient une tentative classée.
 */
async function runOne(
  inst: SweBenchInstance,
  client: ClineSidecarClient,
  cfg: AiConfig,
  modelLabel: string,
  opts: { maxIterations: number; timeoutMs: number; run: number },
): Promise<SweAttempt> {
  const base: SweAttempt = {
    taskId: inst.instance_id, modelId: modelLabel, run: opts.run,
    outcome: "harness-error", agentMs: 0, testMs: 0, failToPass: [], passToPass: [],
  };
  const envDir = join(ENV_ROOT, inst.instance_id);
  const repoDir = join(envDir, "repo");

  if (!existsSync(join(envDir, ".prepared"))) {
    base.error = `environnement non préparé : ${envDir} — lance \`npx tsx bench/coding/swebench/cli.ts --prepare-only --instances=${inst.instance_id}\``;
    return base;
  }

  // ── Reset du dépôt au base_commit PROPRE (protocole officiel) ─────────────
  const reset = await git(["checkout", "--force", inst.base_commit], repoDir);
  await git(["checkout", "--", "."], repoDir);
  await git(["clean", "-fdq", "-e", ".env", "-e", "*.pyc"], repoDir);
  if (!reset.ok) base.error = `reset dépôt: ${reset.err}`;

  // ── Agent : VRAI moteur Cline (headless) ──────────────────────────────────
  const clineProvider = resolveClineProvider(cfg.provider);
  const instruction = [
    `Dépôt : ${inst.repo} (Python). Résous le problème décrit ci-dessous en modifiant le code source du dépôt.`,
    "N'écris PAS de nouveaux tests et ne modifie PAS les fichiers de test existants : les tests qui décrivent",
    "le comportement attendu sont déjà présents. Quand tu as terminé, laisse le dépôt dans son état final.",
    "",
    "── Issue ──",
    inst.problem_statement.trim(),
  ].join("\n");

  let run;
  try {
    run = await client.runTurn(
      {
        cwd: repoDir,
        providerId: clineProvider.providerId,
        baseUrl: clineProvider.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.model,
        systemPrompt: buildAgentSystemPrompt(),
        mode: "act",
        maxIterations: opts.maxIterations,
      },
      instruction,
    );
  } catch (e) {
    base.error = `démarrage agent: ${e instanceof Error ? e.message : String(e)}`;
    return base;
  }

  const tAgent = Date.now();
  const timer = setTimeout(() => { void run.abort(); }, opts.timeoutMs);
  try {
    await run.finished;
  } finally {
    clearTimeout(timer);
  }
  base.agentMs = Date.now() - tAgent;
  base.turns = run.metrics.turns;
  base.toolCalls = run.metrics.toolCalls;
  base.inputTokens = run.metrics.inputTokens;
  base.outputTokens = run.metrics.outputTokens;
  base.metrics = run.metrics;

  // ── Capture du patch produit (format officiel) ────────────────────────────
  try {
    base.modelPatch = await captureModelPatch(repoDir);
  } catch (e) {
    base.modelPatch = "";
    base.error = `${base.error ?? ""} capture patch: ${e instanceof Error ? e.message : String(e)}`.trim();
  }

  // ── Restauration officielle : base_commit des fichiers de test + test_patch ─
  const testPatchFiles = parsePatchTargets(inst.test_patch);
  if (testPatchFiles.length > 0) {
    await git(["checkout", "--force", inst.base_commit, "--", ...testPatchFiles], repoDir);
  }
  try {
    await ensureArmed(inst, repoDir);
  } catch (e) {
    base.error = `${base.error ?? ""} application test_patch: ${e instanceof Error ? e.message : String(e)}`.trim();
  }

  // ── Tests DANS Docker, critères identiques au harnais Node ────────────────
  // Protocole officiel : on exécute FAIL_TO_PASS ∪ PASS_TO_PASS en UNE passe
  // pytest (sinon les PASS_TO_PASS ne sont jamais exécutés et sont notés à tort
  // « non parsé »). Les noms non qualifiés (sympy) sont préfixés par le fichier
  // de test résolu via `testFilesFor` pour que pytest puisse les cibler.
  const files = testFilesFor(inst);
  const qualify = (t: string): string => {
    if (t.includes("::")) return t;
    return files.length > 0 ? `${files[0]}::${t}` : t;
  };
  const selected = [...new Set([...inst.FAIL_TO_PASS, ...inst.PASS_TO_PASS].map(qualify))];
  const testRun = await runDockerPytest(repoDir, officialImageName(inst), selected, 15 * 60 * 1000);
  base.testMs = testRun.durationMs;

  const parsed = parseTestOutcomes(testRun.stdout, testRun.stderr);
  const runShape = {
    exitCode: testRun.exitCode, stdout: testRun.stdout, stderr: testRun.stderr,
    timedOut: false, durationMs: testRun.durationMs,
  };
  base.failToPass = evaluateCriteria(inst.FAIL_TO_PASS.map(s => s.split("::").pop() ?? s), parsed, runShape);
  base.passToPass = evaluateCriteria(inst.PASS_TO_PASS.map(s => s.split("::").pop() ?? s), parsed, runShape);
  base.outcome = criteriaSatisfied(base.failToPass) && criteriaSatisfied(base.passToPass)
    ? "resolved" : "unresolved";
  // Un échec d'agent n'efface PAS les tests déjà valides (le protocole ne note
  // QUE les tests) ; il est conservé à part, pour l'analyse.
  if (base.outcome !== "resolved" && run.metrics.error) {
    base.outcome = base.turns === 0 ? "agent-error" : base.outcome;
    base.error = `${base.error ?? ""} agent: ${run.metrics.error}`.trim();
  }
  return base;
}

/**
 * Prompt système MINIMAL pour le mode headless. On ne réutilise pas
 * `buildSystemPrompt` (couplé au front) : ce texte neutre suffit à cadrer la
 * tâche. Aucune indication de solution n'y figure.
 */
function buildAgentSystemPrompt(): string {
  return [
    "Tu es un ingénieur logiciel autonome qui corrige des bugs dans un dépôt Python.",
    "Tu disposes d'outils pour lire/écrire des fichiers et exécuter des commandes shell dans le workspace.",
    "Explore le code, identifie la cause racine, applique une correction MINIMALE, puis termine.",
    "Ne modifie jamais les fichiers de test.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = argValue(args, "instances")?.split(",").map(s => s.trim()).filter(Boolean);
  const runs = Number(argValue(args, "runs") ?? "1") || 1;
  const maxIterations = Number(argValue(args, "max-iterations") ?? "40") || 40;
  const timeoutMs = Number(argValue(args, "timeout-ms") ?? String(30 * 60 * 1000)) || 30 * 60 * 1000;
  const all = args.includes("--all");

  const instances = await loadInstances(all ? undefined : only);
  if (instances.length === 0) throw new Error("aucune instance à exécuter (utilise --all ou --instances=…)");

  const cfg = await loadAiConfig();
  const modelLabel = `orvyx-code/${cfg.model}`;
  console.log(`# SWE-bench headless — ${instances.length} instance(s), ${runs} run(s)`);
  console.log(`# modèle=${cfg.model} provider=${cfg.provider} node=${process.version}`);
  console.log(`# sidecar=${SIDECAR}`);

  // Un seul process sidecar pour tout le run ; `CLINE_DIR` jetable et isolé.
  const dataDir = join(tmpdir(), `orvyx-swe-cline-${Date.now()}`);
  const client = new ClineSidecarClient({
    sidecarPath: SIDECAR,
    dataDir,
    // Politique de bench NON interactive : on approuve les outils cœur du SDK
    // (lecture/édition/shell) — sinon l'agent ne peut rien écrire. Journalisé.
    approvalPolicy: (req) => {
      console.log(`   [approve] ${req.toolName}`);
      return true;
    },
    onLog: (m) => console.log(`   ${m}`),
  });

  const attempts: SweAttempt[] = [];
  const predictions: Prediction[] = [];
  try {
    await client.start();
    for (const inst of instances) {
      for (let r = 1; r <= runs; r++) {
        console.log(`\n── ${inst.instance_id} (${inst.repo}) run ${r}/${runs}`);
        const t0 = Date.now();
        const a = await runOne(inst, client, cfg, modelLabel, { maxIterations, timeoutMs, run: r });
        attempts.push(a);
        predictions.push({
          instance_id: inst.instance_id,
          model_patch: a.modelPatch ?? "",
          model_name_or_path: modelLabel,
        });
        console.log(
          `   → ${a.outcome} | tours=${a.turns ?? 0} outils=${a.toolCalls ?? 0} ` +
          `in=${a.inputTokens ?? 0} out=${a.outputTokens ?? 0} ` +
          `agent=${Math.round(a.agentMs / 1000)}s test=${Math.round(a.testMs / 1000)}s total=${Math.round((Date.now() - t0) / 1000)}s` +
          (a.error ? ` | err=${a.error.slice(0, 160)}` : ""),
        );
        // Écriture INCRÉMENTALE : un run interrompu laisse un résultat partiel
        // exploitable (pas de perte des instances déjà terminées).
        await persist(attempts, predictions, modelLabel);
      }
    }
  } finally {
    await client.dispose();
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await persist(attempts, predictions, modelLabel);
  const resolved = attempts.filter(a => a.outcome === "resolved").length;
  console.log(`\n# terminé : ${resolved}/${attempts.length} résolue(s)`);
}

/** Écrit les livrables (résultats bruts, prédictions, rapport, résumé). */
async function persist(
  attempts: SweAttempt[],
  predictions: Prediction[],
  modelLabel: string,
): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(join(RESULTS_DIR, "swebench-headless-results.json"), `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
  await writePredictions(predictions, join(RESULTS_DIR, "swebench-predictions.jsonl"));

  const report = summarize(attempts, () => "feature");
  await writeReport(report, join(RESULTS_DIR, "swebench-report.json"));
  await writeFile(
    join(RESULTS_DIR, "swebench-model.json"),
    `${JSON.stringify({ model_name_or_path: modelLabel, generated_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\n${formatTable(report)}`);
}

main().catch((e) => {
  console.error(`Erreur runner SWE-bench : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
