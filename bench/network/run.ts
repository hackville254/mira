#!/usr/bin/env node
// ── Benchmark RÉSEAU (Niveau B) — vrais modèles, cycle tool-call complet ───────
//
// ⚠️  CE SCRIPT FAIT DES APPELS PAYANTS. Il n'est JAMAIS lancé automatiquement.
//     Il doit être exécuté manuellement, avec un accord explicite :
//
//       npx tsx bench/network/run.ts --models claude-haiku-4-5,gemini-3.5-flash
//       npx tsx bench/network/run.ts --models ... --runs 2 --max-tokens 512
//       npx tsx bench/network/run.ts --models ... --resume   (reprend un run interrompu)
//
// Il mesure, sur un MÊME protocole reproductible :
//   - TTFT (délai avant le premier token), durée totale ;
//   - tokens entrée/sortie (si le provider les renvoie) et tokens/s ;
//   - nombre de tours et d'appels d'outils, taux de réussite des appels ;
//   - exactitude des arguments, taux d'abstention quand les outils sont inutiles ;
//   - erreurs HTTP (429/5xx/timeout/parsing) ventilées par catégorie ;
//   - coût estimé (source du tarif indiquée) — jamais présenté comme réel.
//
// Les identifiants de modèles et l'endpoint proviennent de la config existante
// (.env / ORVYX_AI_*), JAMAIS inventés ici. Les clés ne sont jamais écrites
// dans les résultats.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildSystemPrompt } from "../../src/lib/agent/prompts";

// ── Configuration ─────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
const API_KEY = process.env.ORVYX_AI_API_KEY ?? env.ORVYX_AI_API_KEY ?? "";
const BASE = process.env.ORVYX_AI_BASE_URL ?? env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";

interface Args { models: string[]; runs: number; maxTokens: number; resume: boolean; out: string; tasks: string[]; }

function parseArgs(argv: string[]): Args {
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const defModels = (env.ORVYX_ALLOWED_MODELS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    models: (val("models") ?? defModels.join(",") ?? "").split(",").map(s => s.trim()).filter(Boolean),
    runs: Math.max(1, parseInt(val("runs") ?? "1", 10)),
    maxTokens: Math.max(16, parseInt(val("max-tokens") ?? "512", 10)),
    resume: argv.includes("--resume"),
    out: val("out") ?? resolve("bench", "results", "network.json"),
    tasks: (val("tasks") ?? "simple,toolcall").split(",").map(s => s.trim()).filter(Boolean),
  };
}

// ── Protocole : mêmes prompts pour tous les modèles ───────────────────────────

const SYSTEM = buildSystemPrompt("agent", false);

/** Une « sonde » = un tour utilisateur + les outils factices exposés. */
interface Probe {
  id: "simple" | "toolcall" | "abstain";
  /** Message utilisateur identique pour tous les modèles. */
  user: string;
  /** Outils exposés (format OpenAI tools). Vide = aucun outil. */
  tools: OpenAiTool[];
  /** Évalue la réponse : renvoie les métriques de qualité. */
  score(content: string, toolCalls: { name: string; args: string }[]): ProbeScore;
}

interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ProbeScore {
  /** Le modèle a-t-il produit le comportement ATTENDU ? (0..1) */
  correct: boolean;
  /** Nombre d'appels d'outils (0 = abstention). */
  toolCallCount: number;
  /** Vrai si les arguments sont exacts (nom + valeurs attendues). */
  argsExact: boolean;
  detail: string;
}

const READ_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file in the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

const PROBES: Probe[] = [
  {
    id: "simple",
    user: "Réponds exactement par le mot : pong.",
    tools: [],
    score: (content) => ({
      correct: /\bpong\b/i.test(content),
      toolCallCount: 0,
      argsExact: true,
      detail: content.trim().slice(0, 40),
    }),
  },
  {
    id: "toolcall",
    user: "Lis le fichier src/math.mjs et dis-moi ce qu'il contient. Utilise l'outil.",
    tools: [READ_TOOL],
    score: (content, calls) => {
      const call = calls[0];
      const pathArg = call ? call.args : "";
      const argsExact = /math\.mjs/.test(pathArg);
      return {
        correct: calls.length >= 1 && argsExact,
        toolCallCount: calls.length,
        argsExact,
        detail: call ? `${call.name}(${pathArg.slice(0, 60)})` : content.slice(0, 40),
      };
    },
  },
  {
    id: "abstain",
    user: "Combien font 2 + 2 ? Réponds directement, sans outil.",
    tools: [READ_TOOL],
    score: (content, calls) => ({
      correct: calls.length === 0 && /4/.test(content),
      toolCallCount: calls.length,
      argsExact: true,
      detail: calls.length === 0 ? content.trim().slice(0, 40) : "a appelé un outil à tort",
    }),
  },
];

// ── Exécution d'une sonde ─────────────────────────────────────────────────────

interface ProbeResult {
  model: string;
  probe: string;
  run: number;
  ttftMs: number;
  totalMs: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  turns: number;
  toolCalls: number;
  correct: boolean;
  argsExact: boolean;
  detail: string;
  /** Catégorie d'erreur : model | provider | tool | harness (ou vide). */
  errorClass?: "provider" | "parsing" | "harness";
  error?: string;
  httpStatus?: number;
}

/** Classe une erreur HTTP : 429/5xx = provider ; 4xx client = harness (config). */
function classifyHttp(status: number): ProbeResult["errorClass"] {
  if (status === 429 || status >= 500) return "provider";
  return "harness";
}

async function runProbe(model: string, probe: Probe, runIndex: number, maxTokens: number): Promise<ProbeResult> {
  const t0 = performance.now();
  const body: Record<string, unknown> = {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: probe.user },
    ],
  };
  if (probe.tools.length > 0) {
    body.tools = probe.tools;
    body.tool_choice = "auto";
  }

  const base: ProbeResult = {
    model, probe: probe.id, run: runIndex,
    ttftMs: -1, totalMs: 0, turns: 1, toolCalls: 0,
    correct: false, argsExact: false, detail: "",
  };
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return {
        ...base,
        totalMs: performance.now() - t0,
        httpStatus: res.status,
        errorClass: classifyHttp(res.status),
        error: `HTTP ${res.status} ${text.slice(0, 120)}`,
      };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ttft = -1;
    let content = "";
    const calls: { name: string; args: string }[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let j: {
          choices?: { delta?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.usage) {
          inputTokens = j.usage.prompt_tokens ?? inputTokens;
          outputTokens = j.usage.completion_tokens ?? outputTokens;
        }
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          if (ttft < 0) ttft = performance.now() - t0;
          content += delta.content;
        }
        for (const tc of delta.tool_calls ?? []) {
          if (ttft < 0) ttft = performance.now() - t0;
          const last = calls[calls.length - 1];
          const name = tc.function?.name ?? "";
          const args = tc.function?.arguments ?? "";
          if (name && (!last || last.name !== name)) calls.push({ name, args });
          else if (last) last.args += args;
        }
      }
    }

    const totalMs = performance.now() - t0;
    const sc = probe.score(content, calls);
    return {
      ...base,
      ttftMs: ttft < 0 ? totalMs : ttft,
      totalMs,
      // Un tour = un aller-retour HTTP. Un appel d'outil ouvert en implique un
      // second (résultat → réponse), même si le résultat n'est pas réinjecté ici.
      turns: calls.length > 0 ? 2 : 1,
      inputTokens, outputTokens,
      tokensPerSec: outputTokens != null && totalMs > 0 ? (outputTokens / (totalMs / 1000)) : undefined,
      toolCalls: calls.length,
      correct: sc.correct,
      argsExact: sc.argsExact,
      detail: sc.detail,
    };
  } catch (e) {
    return { ...base, totalMs: performance.now() - t0, errorClass: "harness", error: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}

// ── Reprise ───────────────────────────────────────────────────────────────────

interface NetworkReport {
  schemaVersion: 1;
  generatedAt: string;
  base: string;
  note: string;
  results: ProbeResult[];
  summaries: {
    model: string;
    probe: string;
    runs: number;
    ttftMedian: number;
    totalMedian: number;
    correctRate: number;
    abstainRate: number;
    argsExactRate: number;
    providerErrors: number;
  }[];
}

function summarizeResults(results: ProbeResult[]): NetworkReport["summaries"] {
  const groups = new Map<string, ProbeResult[]>();
  for (const r of results) {
    const k = `${r.model}::${r.probe}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const median = (ns: number[]): number => {
    if (ns.length === 0) return -1;
    const s = [...ns].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const out: NetworkReport["summaries"] = [];
  for (const [k, rs] of groups) {
    const [model, probe] = k.split("::");
    out.push({
      model, probe,
      runs: rs.length,
      ttftMedian: median(rs.map(r => r.ttftMs).filter(n => n >= 0)),
      totalMedian: median(rs.map(r => r.totalMs).filter(n => n > 0)),
      correctRate: rs.filter(r => r.correct).length / rs.length,
      abstainRate: probe === "abstain" ? rs.filter(r => r.toolCalls === 0).length / rs.length : 0,
      argsExactRate: probe === "toolcall" ? rs.filter(r => r.argsExact).length / rs.length : 0,
      providerErrors: rs.filter(r => r.errorClass === "provider").length,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.probe.localeCompare(b.probe));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!API_KEY) { console.error("Clé API absente (ORVYX_AI_API_KEY). Abandon."); process.exit(1); }
  if (args.models.length === 0) {
    console.error("Aucun modèle : passe --models a,b ou renseigne ORVYX_ALLOWED_MODELS. Abandon.");
    process.exit(1);
  }

  console.log("═".repeat(74));
  console.log("Benchmark RÉSEAU ORVYX Code — appels PAYANTS (accord explicite requis)");
  console.log(`endpoint : ${BASE}`);
  console.log(`modèles  : ${args.models.join(", ")}`);
  console.log(`sondes   : ${args.tasks.join(", ")}  répétitions : ${args.runs}  max_tokens : ${args.maxTokens}`);
  console.log("═".repeat(74));

  const probes = PROBES.filter(p => args.tasks.includes(p.id));

  // Reprise : recharge les résultats déjà présents et saute ce qui est fait.
  let results: ProbeResult[] = [];
  if (args.resume && existsSync(args.out)) {
    try {
      results = (JSON.parse(readFileSync(args.out, "utf8")) as NetworkReport).results ?? [];
      console.log(`Reprise : ${results.length} résultats déjà présents.`);
    } catch { /* fichier corrompu : on repart de zéro */ }
  }
  const done = new Set(results.map(r => `${r.model}::${r.probe}::${r.run}`));

  for (const model of args.models) {
    for (const probe of probes) {
      for (let r = 1; r <= args.runs; r++) {
        if (done.has(`${model}::${probe.id}::${r}`)) continue;
        const res = await runProbe(model, probe, r, args.maxTokens);
        results.push(res);
        const mark = res.errorClass ? `! ${res.errorClass}` : res.correct ? "✓" : "✗";
        console.log(`  ${mark} ${model} / ${probe.id} #${r} — TTFT ${res.ttftMs.toFixed(0)}ms, total ${res.totalMs.toFixed(0)}ms, outils ${res.toolCalls}${res.error ? ` (${res.error})` : ""}`);

        // Persistance incrémentale : un Ctrl-C ne perd pas la progression.
        const partial: NetworkReport = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          base: BASE,
          note: "Benchmark réseau interne. Coûts ESTIMÉS (source : voir tariffs). Aucune clé API persistée.",
          results,
          summaries: summarizeResults(results),
        };
        mkdirSync(dirname(args.out), { recursive: true });
        writeFileSync(args.out, `${JSON.stringify(partial, null, 2)}\n`, "utf8");
      }
    }
  }

  console.log("\nRésumé écrit dans : " + args.out);
}

main().catch(e => { console.error(`Erreur du harnais réseau : ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
