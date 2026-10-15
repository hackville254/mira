/**
 * Banc de mesure TTFT réel — hors suite vitest (appel réseau).
 *
 * Objectif : mesurer objectivement ce que « c'est lent » veut dire, en
 * distinguant les trois composantes du temps :
 *
 *   1. TTFT (Time To First Token)  → latence perçue au démarrage.
 *   2. Débit de génération (tok/s) → vitesse du stream une fois lancé.
 *   3. Temps total                 → durée complète d'un tour.
 *
 * On teste plusieurs « formes » de requête pour isoler ce qui pèse :
 *   - prompt minuscule  (mesure le plancher réseau + modèle).
 *   - prompt SYSTÈME réel (agent/plan/ask, normal/max) + question simple.
 *   - question complexe avec le prompt système réel.
 *
 * Sécurité : la clé vient de `.env` (dev), n'est jamais loguée.
 *
 * Lancer :
 *   npx tsx scripts/ttft-probe.ts            # prompts système, requête simple
 *   npx tsx scripts/ttft-probe.ts --runs 3   # 3 mesures par cas
 *   npx tsx scripts/ttft-probe.ts --complex  # ajoute les cas complexes
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt } from "../src/lib/agent/prompts";

// ── Config ─────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
const args = process.argv.slice(2);
const API_KEY = env.ORVYX_AI_API_KEY;
const MODEL_ARG_IDX = args.indexOf("--model");
const MODEL = MODEL_ARG_IDX >= 0 ? args[MODEL_ARG_IDX + 1] : (env.ORVYX_AI_MODEL ?? "deepseek-v4-flash");
const BASE = env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";

if (!API_KEY) {
  console.error("ORVYX_AI_API_KEY manquant dans .env");
  process.exit(1);
}

const RUNS = (() => {
  const i = args.indexOf("--runs");
  return i >= 0 ? Math.max(1, parseInt(args[i + 1] ?? "1", 10)) : 1;
})();
const INCLUDE_COMPLEX = args.includes("--complex");

// ── Mesure d'un appel streaming ──────────────────────────────────────────────

interface Timing {
  ttftMs: number;      // temps jusqu'au premier token de contenu
  totalMs: number;     // temps total du stream
  genMs: number;       // total - ttft (temps de génération)
  outTokens: number;   // tokens de sortie comptés
  tokPerSec: number;   // débit sur la phase de génération
  chars: number;
}

async function measure(systemPrompt: string, userPrompt: string): Promise<Timing> {
  const body = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttftMs = -1;
  let firstByteMs = -1;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs < 0) firstByteMs = performance.now() - t0;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta: string = json.choices?.[0]?.delta?.content ?? "";
        if (delta.length > 0) {
          if (ttftMs < 0) ttftMs = performance.now() - t0;
          text += delta;
        }
      } catch {
        /* fragment non-JSON ignoré */
      }
    }
  }

  const totalMs = performance.now() - t0;
  if (ttftMs < 0) ttftMs = totalMs; // aucun token de contenu → TTFT = total
  const genMs = Math.max(1, totalMs - ttftMs);
  // Approximation tokens : ~4 chars/token (suffisant pour un débit relatif).
  const outTokens = Math.ceil(text.length / 4);

  return {
    ttftMs,
    totalMs,
    genMs,
    outTokens,
    tokPerSec: outTokens / (genMs / 1000),
    chars: text.length,
  };
}

// ── Cas de test ───────────────────────────────────────────────────────────────

interface Case {
  name: string;
  system: string;
  user: string;
}

function buildCases(): Case[] {
  const simple = "Reply with exactly one word: pong.";
  const produce = "Write a 3-line TypeScript function that adds two numbers. Code only.";

  const cases: Case[] = [
    // Plancher : aucun prompt système volumineux, juste le réseau + modèle.
    { name: "plancher (sys vide, 1 mot)", system: "", user: simple },
    // Prompts système RÉELS de l'app, question simple.
    { name: "agent/max  + 1 mot", system: buildSystemPrompt("agent", true), user: simple },
    { name: "agent/norm + 1 mot", system: buildSystemPrompt("agent", false), user: simple },
    { name: "plan/max   + 1 mot", system: buildSystemPrompt("plan", true), user: simple },
    { name: "ask/max    + 1 mot", system: buildSystemPrompt("ask", true), user: simple },
    // Mêmes prompts, mais l'utilisateur demande de PRODUIRE (débit mesurable).
    { name: "agent/max  + code", system: buildSystemPrompt("agent", true), user: produce },
  ];

  if (INCLUDE_COMPLEX) {
    const complex =
      "Design a rate limiter for a multi-tenant API. List the trade-offs of " +
      "token bucket vs sliding window, then give a concrete plan with 5 steps.";
    cases.push({ name: "agent/max  + complexe", system: buildSystemPrompt("agent", true), user: complex });
    cases.push({ name: "plan/max   + complexe", system: buildSystemPrompt("plan", true), user: complex });
  }

  return cases;
}

// ── Rapport ────────────────────────────────────────────────────────────────────

function sizeInfo(prompt: string): string {
  const chars = prompt.length;
  const tokens = Math.ceil(chars / 4);
  const sections = (prompt.match(/^## /gm) ?? []).length;
  return `${chars} car. (~${tokens} tok, ${sections} sect.)`;
}

function avg(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}
function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  console.log("═".repeat(78));
  console.log(`Banc TTFT — provider=orvyx  model=${MODEL}`);
  console.log(`Base : ${BASE}`);
  console.log(`Mesures par cas : ${RUNS}${INCLUDE_COMPLEX ? "  (inclut cas complexes)" : ""}`);
  console.log("═".repeat(78));

  const cases = buildCases();
  const rows: Array<{ name: string; sys: string } & Timing> = [];

  for (const c of cases) {
    console.log(`\n▶ ${c.name}`);
    console.log(`   système : ${c.system ? sizeInfo(c.system) : "(vide)"}`);
    console.log(`   user    : "${c.user.slice(0, 60)}${c.user.length > 60 ? "…" : ""}"`);

    const timings: Timing[] = [];
    for (let r = 0; r < RUNS; r++) {
      try {
        const t = await measure(c.system, c.user);
        timings.push(t);
        console.log(
          `   run ${r + 1} : TTFT ${t.ttftMs.toFixed(0)} ms | total ${t.totalMs.toFixed(0)} ms | ` +
          `${t.outTokens} tok @ ${t.tokPerSec.toFixed(1)} tok/s`,
        );
      } catch (e) {
        console.log(`   run ${r + 1} : ERREUR — ${(e as Error).message}`);
      }
    }
    if (timings.length === 0) continue;

    rows.push({
      name: c.name,
      sys: c.system,
      ttftMs: median(timings.map(t => t.ttftMs)),
      totalMs: median(timings.map(t => t.totalMs)),
      genMs: median(timings.map(t => t.genMs)),
      outTokens: median(timings.map(t => t.outTokens)),
      tokPerSec: median(timings.map(t => t.tokPerSec)),
      chars: median(timings.map(t => t.chars)),
    });
  }

  // ── Tableau de synthèse ──
  console.log("\n" + "═".repeat(78));
  console.log("SYNTHÈSE (médianes)");
  console.log("═".repeat(78));
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const num = (v: number, n = 8) => v.toFixed(0).padStart(n);
  console.log(
    pad("cas", 24) + pad("sys", 30) + "TTFT(ms)".padStart(9) + "total".padStart(9) +
    "tok".padStart(6) + "tok/s".padStart(8),
  );
  console.log("-".repeat(78));
  for (const r of rows) {
    const sysInfo = r.sys ? sizeInfo(r.sys) : "(vide)";
    console.log(
      pad(r.name, 24) + pad(sysInfo, 30) + num(r.ttftMs, 9) + num(r.totalMs, 9) +
      String(Math.round(r.outTokens)).padStart(6) + r.tokPerSec.toFixed(1).padStart(8),
    );
  }

  // ── Analyse : le prompt système pèse-t-il sur le TTFT ? ──
  const floor = rows.find(r => r.name.startsWith("plancher"));
  console.log("\n" + "─".repeat(78));
  console.log("LECTURE DES RÉSULTATS");
  console.log("─".repeat(78));
  if (floor) {
    console.log(`Plancher réseau+modèle (sys vide) : TTFT ${floor.ttftMs.toFixed(0)} ms`);
    for (const r of rows) {
      if (r.sys) {
        const delta = r.ttftMs - floor.ttftMs;
        const pct = ((delta / floor.ttftMs) * 100).toFixed(0);
        console.log(
          `  ${pad(r.name, 24)} TTFT ${r.ttftMs.toFixed(0).padStart(5)} ms ` +
          `(${delta >= 0 ? "+" : ""}${delta.toFixed(0)} ms vs plancher, ${pct}%)`,
        );
      }
    }
  }
  console.log(
    "\nRepère : si le TTFT des cas « sys réel » ≈ plancher, le prompt système n'est PAS\n" +
    "le facteur limitant — la latence vient du réseau/modèle. S'il s'en écarte fortement,\n" +
    "la taille du prompt (prefill) compte et il faut réduire les tokens d'entrée.",
  );
}

main().catch(e => {
  console.error("Échec du banc :", e);
  process.exit(1);
});
