#!/usr/bin/env node
// ── CLI LiveCodeBench — préparation du run et publication des résultats ───────
//
// Usage :
//   npx tsx bench/coding/livecodebench/cli.ts --extract --out bench/coding/datasets/lcb.json
//   npx tsx bench/coding/livecodebench/cli.ts --payload --since 2024-01-01 --limit 50
//   npx tsx bench/coding/livecodebench/cli.ts --report
//
// RÔLE
// ----
// LiveCodeBench n'exige PAS de dépôt : l'agent GÉNÈRE une solution, notée dans un
// sandbox Docker. Ce CLI prépare donc :
//   1. `--extract` : décode le dataset (base64+zlib+pickle) HORS LIGNE de façon
//      SÛRE (via `extract_cases.py`, jamais du pickle en Node), avec filtre de
//      contamination par `contest_date` ;
//   2. `--payload` : produit le JSON `{problems, cases}` à injecter dans la
//      webview Tauri, et un « run spec » décrivant les filtres appliqués ;
//   3. `--report` : agrège `lcb-results.json` (écrit par le harnais webview) en
//      un rapport Markdown + un `lcb-results-summary.json`.
//
// IMPORTANT : l'exécution de l'agent se fait DANS la webview Tauri (les outils de
// production passent par `invoke`). Ce CLI n'appelle AUCUN modèle.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayload, payloadToInstance, validateInstance } from "./instance";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "results");
const DATASETS_DIR = join(HERE, "..", "datasets");
const EXTRACTOR = join(HERE, "extract_cases.py");

function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

/** Chemin par défaut du dataset brut (cache HuggingFace). */
function defaultRawDataset(): string {
  const base = join(process.env.HOME ?? "", ".cache", "huggingface", "hub",
    "datasets--livecodebench--code_generation_lite", "snapshots");
  const glob = spawnSync("bash", ["-lc", `ls ${base}/*/test.jsonl 2>/dev/null | head -1`], { encoding: "utf8" });
  return glob.stdout.trim();
}

/**
 * Lance l'extraction sûre (Python). Refuse d'écrire si l'entrée est introuvable.
 * Le décodage pickle se fait donc TOUJOURS dans un interpréteur jetable, jamais
 * dans le processus Node de l'app.
 */
function extract(args: string[]): void {
  const input = argValue(args, "input") ?? defaultRawDataset();
  if (!input) throw new Error("dataset brut introuvable : passe `--input=<test.jsonl>`");
  const out = argValue(args, "out") ?? join(DATASETS_DIR, "lcb.json");
  const py = argValue(args, "python") ?? "python3";
  mkdirSync(dirname(out));
  const argv = [EXTRACTOR, "--input", input, "--out", out];
  const since = argValue(args, "since"); if (since) argv.push("--since", since);
  const until = argValue(args, "until"); if (until) argv.push("--until", until);
  const platforms = argValue(args, "platforms"); if (platforms) argv.push("--platforms", platforms);
  const limit = argValue(args, "limit"); if (limit) argv.push("--limit", limit);
  const res = spawnSync(py, argv, { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`extract_cases.py a échoué (code ${res.status})`);
}

function mkdirSync(dir: string): void {
  spawnSync("mkdir", ["-p", dir], { stdio: "ignore" });
}

/**
 * Produit le(s) payload(s) injectable(s) dans la webview à partir du JSON extrait.
 * Applique les filtres (date/plateforme/limite) ICI, côté Node, pour que la
 * webview reçoive exactement l'échantillon à évaluer.
 *
 * DÉCOUPAGE EN LOTS (`--shard-size`) : les cas privés LiveCodeBench sont verboses
 * (≈ 2,5 Mo par problème). Injecter 75 problèmes d'un coup saturerait la webview.
 * On écrit donc un fichier par lot ; la webview lit le lot courant via `read_file`
 * (chemin validé par `workspaceRoot`), jamais l'intégralité du dataset.
 *
 * `--stratified=N` : échantillonne au plus N problèmes par (plateforme × difficulté)
 * pour un échantillon représentatif et PUBLIABLE. Les lots sont triés par
 * `question_id` pour un ordre déterministe et reproductible.
 */
async function makePayload(args: string[]): Promise<void> {
  const src = argValue(args, "input") ?? join(DATASETS_DIR, "lcb.json");
  const payload = await loadPayload(src);
  const since = argValue(args, "since");
  const until = argValue(args, "until");
  const platforms = argValue(args, "platforms")?.split(",").map(s => s.trim());
  const limit = argValue(args, "limit") ? Number(argValue(args, "limit")) : undefined;
  const ids = argValue(args, "ids")?.split(",").map(s => s.trim()).filter(Boolean);
  const stratified = argValue(args, "stratified") ? Number(argValue(args, "stratified")) : undefined;
  const shardSize = argValue(args, "shard-size") ? Number(argValue(args, "shard-size")) : undefined;

  // 1) Filtrage initial (date / plateforme / ids / limite globale).
  const filtered = payload.problems.filter(p => {
    if (ids && !ids.includes(p.question_id)) return false;
    if (since && p.contest_date && p.contest_date < since) return false;
    if (until && p.contest_date && p.contest_date > until) return false;
    if (platforms && platforms.length > 0 && !platforms.includes(p.platform ?? "unknown")) return false;
    return true;
  });

  // 2) Échantillonnage stratifié (plateforme × difficulté) : ordre déterministe
  //    (question_id) puis au plus `stratified` par strate. Reproductible.
  let selected = [...filtered].sort((a, b) => a.question_id.localeCompare(b.question_id));
  if (stratified) {
    const perStrate: Record<string, number> = {};
    selected = selected.filter(p => {
      const k = `${p.platform ?? "unknown"}::${p.difficulty ?? "unknown"}`;
      perStrate[k] = (perStrate[k] ?? 0) + 1;
      return perStrate[k] <= stratified;
    });
  }
  if (limit) selected = selected.slice(0, limit);

  // 3) Construction des problèmes + cas (validation : jamais de problème non évaluable).
  const problems: Array<Record<string, unknown>> = [];
  const cases: Record<string, Array<{ input: string; output: string; hidden?: boolean }>> = {};
  for (const p of selected) {
    const inst = payloadToInstance(p, payload.cases[p.question_id] ?? []);
    validateInstance(inst);
    problems.push({ ...p, caseCount: inst.cases.length });
    cases[inst.question_id] = inst.cases.map(c => ({ input: c.input, output: c.output, hidden: c.hidden }));
  }

  const filters = { since, until, platforms, limit, ids, stratified };
  // 4) Écriture : un fichier par lot (ou un seul si pas de `--shard-size`).
  if (!shardSize || shardSize <= 0) {
    const out = argValue(args, "out") ?? join(RESULTS_DIR, "lcb-payload.json");
    mkdirSync(dirname(out));
    await writeFile(out, `${JSON.stringify({ source: src, filters, problems, cases }, null, 2)}\n`, "utf8");
    const totalCases = Object.values(cases).reduce((a, c) => a + c.length, 0);
    console.log(`Payload LiveCodeBench : ${out}`);
    console.log(`   ${problems.length} problème(s), ${totalCases} cas`);
    console.log(`   filtres : since=${since ?? "-"} until=${until ?? "-"} platforms=${platforms?.join("|") ?? "-"} stratified=${stratified ?? "-"} limit=${limit ?? "-"}`);
    return;
  }

  const shardsDir = argValue(args, "shards-dir") ?? join(RESULTS_DIR, "lcb-shards");
  mkdirSync(shardsDir);
  const nShards = Math.ceil(problems.length / shardSize);
  for (let i = 0; i < nShards; i++) {
    const chunk = problems.slice(i * shardSize, (i + 1) * shardSize);
    const chunkCases: typeof cases = {};
    for (const p of chunk) chunkCases[p.question_id as string] = cases[p.question_id as string];
    const out = join(shardsDir, `lcb-payload-${String(i).padStart(3, "0")}.json`);
    await writeFile(out, `${JSON.stringify({ source: src, filters, shard: i, shards: nShards, problems: chunk, cases: chunkCases })}\n`, "utf8");
  }
  console.log(`Lots LiveCodeBench : ${shardsDir}`);
  console.log(`   ${problems.length} problème(s) réparti(s) en ${nShards} lot(s) de ≤${shardSize}`);
  console.log(`   filtres : since=${since ?? "-"} until=${until ?? "-"} platforms=${platforms?.join("|") ?? "-"} stratified=${stratified ?? "-"} limit=${limit ?? "-"}`);
}

/**
 * Agrège `lcb-results.json` en taux de résolution + rapport Markdown.
 * Contrat d'entrée : tableau d'`AttemptResult` (voir `bench/coding/types`).
 */
async function report(): Promise<void> {
  const inFile = join(RESULTS_DIR, "lcb-results.json");
  const raw = JSON.parse(await readFile(inFile, "utf8")) as Array<{
    taskId: string; modelId: string; run: number; outcome: string;
    agentMs: number; testMs: number; turns?: number; toolCalls?: number;
    inputTokens?: number; outputTokens?: number; error?: string;
  }>;
  const byOutcome: Record<string, number> = {};
  let resolved = 0;
  let agentMs = 0, inTok = 0, outTok = 0;
  for (const r of raw) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    if (r.outcome === "resolved") resolved++;
    agentMs += r.agentMs ?? 0;
    inTok += r.inputTokens ?? 0;
    outTok += r.outputTokens ?? 0;
  }
  const n = raw.length || 1;
  const summary = {
    generated_at: new Date().toISOString(),
    benchmark: "LiveCodeBench (code_generation_lite)",
    problems: new Set(raw.map(r => r.taskId)).size,
    attempts: raw.length,
    resolved,
    resolve_rate: resolved / n,
    by_outcome: byOutcome,
    avg_agent_ms: Math.round(agentMs / n),
    total_input_tokens: inTok,
    total_output_tokens: outTok,
    model: raw[0]?.modelId ?? "unknown",
  };
  await writeFile(join(RESULTS_DIR, "lcb-results-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const md = [
    "# LiveCodeBench — résultats",
    "",
    `- Modèle : \`${summary.model}\``,
    `- Problèmes : ${summary.problems} (${summary.attempts} tentatives)`,
    `- Taux de résolution : **${(summary.resolve_rate * 100).toFixed(1)}%** (${resolved}/${raw.length})`,
    `- Latence agent moyenne : ${summary.avg_agent_ms} ms`,
    `- Tokens : ${inTok} in / ${outTok} out`,
    "",
    "| Issue | Nombre |",
    "| --- | --- |",
    ...Object.entries(byOutcome).map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ].join("\n");
  await writeFile(join(RESULTS_DIR, "lcb-report.md"), md, "utf8");
  console.log(`Rapport : ${join(RESULTS_DIR, "lcb-report.md")}`);
  console.log(`   résolus=${resolved}/${raw.length} (${(summary.resolve_rate * 100).toFixed(1)}%)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--extract")) { extract(args); return; }
  if (args.includes("--payload")) { await makePayload(args); return; }
  if (args.includes("--report")) { await report(); return; }
  console.log("Usage : cli.ts --extract | --payload | --report");
}

main().catch((e) => {
  console.error(`Erreur LiveCodeBench : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
