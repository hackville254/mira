/**
 * Validation RÉELLE du routage adaptatif (circuit breaker 429 + tri TTFT).
 *
 * Deux phases, réseau réel :
 *   1. On exerce `runAgent` sur un modèle RÉPUTÉ saturé (celui de `.env` / argv).
 *      S'il renvoie 429, `modelHealth` le met en cooldown.
 *   2. On affiche l'ordre de la chaîne AVANT (statique) et APRÈS (routé) pour
 *      prouver que le modèle saturé est rétrogradé, sans réseau additionnel.
 *
 * Si le modèle ne renvoie PAS 429 (il répond), le banc le signale et le test
 * reste informatif (il n'y a alors rien à déprioriser).
 *
 * Hors suite vitest (réseau + `.env`). Lancer :
 *   npx tsx scripts/routing-probe.ts [modele-tete] [modele-repli]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { runAgent, type AgentEvent } from "../src/lib/agent/run";
import { buildModelChain } from "../src/lib/agent/modelCascade";
import { modelHealth, rankModelChain } from "../src/lib/agent/modelHealth";

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

const HEAD = process.argv[2] ?? "deepseek-v4.1-flash";
const FALLBACK = process.argv[3] ?? "deepseek-v4-flash-0731";
const allowed = [HEAD, FALLBACK];
const provider = createOpenAICompatible({ name: "orvyx", baseURL: BASE, apiKey: API_KEY });
const models: LanguageModel[] = allowed.map(id => provider.chatModel(id) as unknown as LanguageModel);

const staticChain = buildModelChain(HEAD, allowed);
console.log("═══════════════════════════════════════════════════════════════");
console.log("Validation routage adaptatif — circuit breaker 429");
console.log(`chaîne statique : ${staticChain.join("  →  ")}`);
console.log("═══════════════════════════════════════════════════════════════");

let sawRateLimit = false;
const onEvent = (e: AgentEvent) => {
  if (e.type === "timing") {
    console.log(`  → timing  model=${e.model} ttft=${e.ttftMs}ms total=${e.totalMs}ms fallbacks=${e.fallbacks}`);
  } else if (e.type === "notice") {
    console.log(`  → notice  [${e.kind}] ${e.detail}`);
    if (/rate|429|busy|satur/i.test(e.detail)) sawRateLimit = true;
  } else if (e.type === "error") {
    console.log(`  → error   ${e.message.slice(0, 160)}`);
    if (/429|rate|busy/i.test(e.message)) sawRateLimit = true;
  }
};

const t0 = performance.now();
const { status } = runAgent({
  model: models[0],
  modelChain: models,
  modelIds: allowed,
  messages: [{ role: "user", content: "Réponds exactement : OK" }],
  tools: {},
  systemPrompt: "Tu réponds en un mot.",
  maxSteps: 1,
  onEvent,
  onSettled: () => {
    console.log(`\ndurée observée : ${Math.round(performance.now() - t0)} ms`);
    console.log(`cooldown ${HEAD} enregistré ? ${modelHealth.isCoolingDown(HEAD)}`);
    const routed = rankModelChain(staticChain);
    console.log(`\nchaîne statique : ${staticChain.join("  →  ")}`);
    console.log(`chaîne routée   : ${routed.join("  →  ")}`);
    if (sawRateLimit && modelHealth.isCoolingDown(HEAD)) {
      console.log(routed[0] !== HEAD
        ? "✅ circuit breaker — modèle saturé rétrogradé au tour suivant"
        : "❌ modèle saturé toujours en tête (régression du routage)");
    } else {
      console.log("ℹ️  pas de 429 observé — rien à déprioriser (test informatif)");
    }
    process.exit(0);
  },
});
void status;
setTimeout(() => { console.error("⏱ timeout global du banc (90 s)"); process.exit(2); }, 90_000);
