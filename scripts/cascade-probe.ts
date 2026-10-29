/**
 * Validation RÉELLE de la cascade de modèles (bout en bout, réseau).
 *
 * Exerce le VRAI `runAgent` avec une chaîne [modèle lent, modèle rapide] et un
 * budget TTFT bas, pour prouver que la bascule `shouldFallbackOnSlowTtft`
 * fonctionne : le tour doit finir sur le modèle rapide, journal `fallbacks=1`.
 *
 * Hors suite vitest (appel réseau + `.env`). Lancer :
 *   npx tsx scripts/cascade-probe.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { runAgent, type AgentEvent } from "../src/lib/agent/run";

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
const API_KEY = env.ORVYX_AI_API_KEY;
const BASE = env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";
if (!API_KEY) { console.error("ORVYX_AI_API_KEY manquant dans .env"); process.exit(1); }

// Chaîne volontairement « piège » : tête lente/saturée, repli rapide mesuré.
// Un id de tête peut être imposé en argument (sinon `.env`).
const CHAIN = (process.argv[2] ?? env.ORVYX_ALLOWED_MODELS ?? "deepseek-v4-flash,deepseek-v4.1-flash")
  .split(",").map(s => s.trim()).filter(Boolean);
const BUDGET_MS = Number(process.argv[3] ?? "4000");
const provider = createOpenAICompatible({ name: "orvyx", baseURL: BASE, apiKey: API_KEY });
const models: LanguageModel[] = CHAIN.map(id => provider.chatModel(id) as unknown as LanguageModel);

const events: string[] = [];
const onEvent = (e: AgentEvent) => {
  if (e.type === "timing") {
    events.push(`  → timing  model=${e.model} ttft=${e.ttftMs}ms total=${e.totalMs}ms fallbacks=${e.fallbacks}`);
  } else if (e.type === "notice") {
    events.push(`  → notice  [${e.kind}] ${e.detail}`);
  } else if (e.type === "error") {
    events.push(`  → error   ${e.message.slice(0, 160)}`);
  }
};

console.log("═══════════════════════════════════════════════════════════════");
console.log("Validation cascade — runAgent réel");
console.log(`chaîne : ${CHAIN.join("  →  ")}`);
console.log(`budget TTFT : ${BUDGET_MS} ms (bascule si 1er token au-delà)`);
console.log("═══════════════════════════════════════════════════════════════");

const t0 = performance.now();
const { status } = runAgent({
  model: models[0],
  modelChain: models,
  modelIds: CHAIN,
  messages: [{ role: "user", content: "Réponds exactement : OK" }],
  tools: {},
  systemPrompt: "Tu réponds en un mot.",
  maxSteps: 1,
  ttftBudgetMs: BUDGET_MS,
  onEvent,
  onSettled: (s) => {
    console.log(events.join("\n"));
    console.log(`\nstatut final : ${s} | durée observée : ${Math.round(performance.now() - t0)} ms`);
    const usedFallback = events.some(l => l.includes("fallbacks=1")) || events.some(l => l.includes("bascule"));
    console.log(usedFallback
      ? "✅ cascade déclenchée — le repli a pris le relais"
      : "ℹ️  pas de bascule (le 1er modèle a répondu dans le budget)");
    process.exit(0);
  },
});

// Sécurité : ne pas pendre indéfiniment si le flux ne se ferme jamais.
void status;
setTimeout(() => { console.error("⏱ timeout global du banc (90 s)"); process.exit(2); }, 90_000);
