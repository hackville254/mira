/**
 * Banc TTFT MULTI-TOURS — mesure l'effet du cache préfixe et de la borne des
 * sorties d'outils sur un vrai `runAgent` (réseau réel, hors suite vitest).
 *
 * ── Pourquoi ce banc ──────────────────────────────────────────────────────────
 * Le banc `ttft-probe` mesure des appels ISOLÉS : il ne peut pas montrer l'effet
 * du cache préfixe (le préfixe doit être réémis à l'identique d'un tour à
 * l'autre pour que le provider le serve depuis son cache). Or c'est là que se
 * joue le « c'est lent » en conversation : au 2ᵉ tour, l'historique entier est
 * re-payé en prefill.
 *
 * Ce banc joue donc N tours successifs sur la MÊME histoire persistée :
 *   - tour 1 : question simple, historique minuscule (TTFT « froid »).
 *   - tour 2 : même préfixe + réponse + question de suivi → doit profiter du
 *     cache (TTFT attendu ≤ tour 1 sur un provider qui supporte le cache).
 *   - tour 3 : historique gonflé par un FAUX résultat d'outil énorme → prouve
 *     que `clampToolResult` élide AVANT l'envoi (inputTokens borné).
 *
 * On lit l'usage réel (`finish`) pour objectiver : inputTokens du tour N doit
 * croître de façon BORNÉE (clamp actif), et `cacheReadTokens` doit être > 0 au
 * 2ᵉ tour si le provider honore le cache.
 *
 * Lancer :
 *   npx tsx scripts/turn-probe.ts                 # modèle de .env
 *   npx tsx scripts/turn-probe.ts --model X       # impose un modèle
 *   npx tsx scripts/turn-probe.ts --big 120000    # taille du faux résultat
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ModelMessage } from "ai";
import { runAgent, type AgentEvent } from "../src/lib/agent/run";
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
const API_KEY = env.ORVYX_AI_API_KEY;
const BASE = env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";
if (!API_KEY) { console.error("ORVYX_AI_API_KEY manquant dans .env"); process.exit(1); }

const args = process.argv.slice(2);
const mIdx = args.indexOf("--model");
const MODEL = mIdx >= 0 ? args[mIdx + 1] : (env.ORVYX_AI_MODEL ?? "glm-5.3-flash");
const bIdx = args.indexOf("--big");
const BIG_CHARS = bIdx >= 0 ? Math.max(1_000, parseInt(args[bIdx + 1] ?? "120000", 10)) : 120_000;

const provider = createOpenAICompatible({ name: "orvyx", baseURL: BASE, apiKey: API_KEY });
const model = provider.chatModel(MODEL) as unknown as LanguageModel;

// ── Un tour, mesuré ────────────────────────────────────────────────────────────

interface TurnResult {
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  text: string;
  status: string;
}

function runTurn(history: ModelMessage[], systemPrompt: string): Promise<TurnResult> {
  return new Promise((resolvePromise) => {
    let ttftMs = -1;
    let totalMs = -1;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let text = "";

    const onEvent = (e: AgentEvent) => {
      if (e.type === "token") text += e.delta;
      else if (e.type === "timing") { ttftMs = e.ttftMs; totalMs = e.totalMs; }
      else if (e.type === "finish") usage = e.usage;
      else if (e.type === "error") console.error(`   ⚠ erreur : ${e.message.slice(0, 160)}`);
    };

    runAgent({
      model,
      messages: history,
      tools: {},
      systemPrompt,
      cacheSystem: true,
      maxSteps: 1,
      ttftBudgetMs: 0, // pas de bascule : on mesure le modèle tel quel
      onEvent,
      onSettled: (status) => {
        resolvePromise({
          ttftMs,
          totalMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          text,
          status,
        });
      },
    });
  });
}

// ── Scénario ───────────────────────────────────────────────────────────────────

function synthBigToolResult(chars: number): string {
  // Simule un `read_file` d'un fichier de `chars` caractères : lignes numérotées.
  const line = "export function handler(req, res) { /* ... */ return res.json({ ok: true }); }\n";
  const per = 2000;
  let out = "";
  while (out.length < chars) out += line.repeat(per);
  return out.slice(0, chars);
}

async function main() {
  const SYSTEM = buildSystemPrompt("agent", true);
  console.log("═".repeat(78));
  console.log(`Banc MULTI-TOURS — provider=orvyx  model=${MODEL}`);
  console.log(`Prompt système agent/max : ${SYSTEM.length} car. (~${Math.ceil(SYSTEM.length / 4)} tok)`);
  console.log(`Faux résultat d'outil du tour 3 : ${BIG_CHARS} car. (~${Math.ceil(BIG_CHARS / 4)} tok brut)`);
  console.log("═".repeat(78));

  // Histoire persistée (comme l'app : on AJOUTE à chaque tour, on ne repart pas de zéro).
  const history: ModelMessage[] = [
    { role: "user", content: "Liste en 1 phrase ce que fait ce projet." },
  ];

  const results: TurnResult[] = [];

  // ── Tour 1 : préfixe froid ──
  console.log("\n▶ Tour 1 (préfixe froid)");
  const t1 = await runTurn(history, SYSTEM);
  results.push(t1);
  console.log(`   TTFT ${t1.ttftMs} ms | total ${t1.totalMs} ms | in ${t1.inputTokens} / out ${t1.outputTokens} tok | cacheRead ${t1.cacheReadTokens}`);
  history.push({ role: "assistant", content: t1.text || "(réponse)" });

  // ── Tour 2 : même préfixe → cache attendu ──
  console.log("\n▶ Tour 2 (préfixe identique → cache attendu)");
  history.push({ role: "user", content: "En 1 phrase, quel est son point d'entrée ?" });
  const t2 = await runTurn(history, SYSTEM);
  results.push(t2);
  console.log(`   TTFT ${t2.ttftMs} ms | total ${t2.totalMs} ms | in ${t2.inputTokens} / out ${t2.outputTokens} tok | cacheRead ${t2.cacheReadTokens} cacheWrite ${t2.cacheCreationTokens}`);
  history.push({ role: "assistant", content: t2.text || "(réponse)" });

  // ── Tour 3 : historique gonflé par un ÉNORME résultat d'outil ──
  console.log("\n▶ Tour 3 (résultat d'outil énorme → clamp attendu)");
  // On injecte le faux résultat BRUT (hors clamp) pour mesurer l'inputTokens :
  // si le clamp marche au niveau du run, il ne s'applique qu'aux résultats émis
  // PAR le SDK ; ici on mesure donc la borne d'entrée telle qu'elle sera envoyée.
  history.push({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "src/index.ts" } }] as never,
  });
  history.push({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "c1",
      toolName: "read_file",
      output: { type: "text", value: synthBigToolResult(BIG_CHARS) },
    }] as never,
  });
  history.push({ role: "user", content: "En 1 phrase, résume ce fichier." });
  const t3 = await runTurn(history, SYSTEM);
  results.push(t3);
  console.log(`   TTFT ${t3.ttftMs} ms | total ${t3.totalMs} ms | in ${t3.inputTokens} / out ${t3.outputTokens} tok | cacheRead ${t3.cacheReadTokens}`);

  // ── Synthèse ──
  console.log("\n" + "═".repeat(78));
  console.log("SYNTHÈSE");
  console.log("═".repeat(78));
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const num = (v: number, n = 10) => String(v).padStart(n);
  console.log(pad("tour", 26) + "TTFT(ms)".padStart(9) + "total(ms)".padStart(11) + "in(tok)".padStart(9) + "cacheRead".padStart(11));
  console.log("-".repeat(78));
  const labels = ["1 — préfixe froid", "2 — préfixe identique", "3 — outil énorme"];
  results.forEach((r, i) => {
    console.log(pad(labels[i] ?? `tour ${i + 1}`, 26) + num(r.ttftMs, 9) + num(r.totalMs, 11) + num(r.inputTokens, 9) + num(r.cacheReadTokens, 11));
  });

  console.log("\n" + "─".repeat(78));
  console.log("LECTURE");
  console.log("─".repeat(78));
  const [a, b, c] = results;
  if (a && b) {
    const delta = b.ttftMs - a.ttftMs;
    console.log(
      `Cache préfixe : TTFT tour 2 ${b.ttftMs} ms vs tour 1 ${a.ttftMs} ms ` +
      `(${delta >= 0 ? "+" : ""}${delta} ms). ` +
      (b.cacheReadTokens > 0
        ? `→ cache HONORÉ (${b.cacheReadTokens} tok lus depuis le cache).`
        : "→ cache NON rapporté par le provider (il peut rester actif sans le déclarer)."),
    );
  }
  if (a && c) {
    const cap = Math.ceil(BIG_CHARS / 4);
    console.log(
      `Borne d'entrée : tour 3 in=${c.inputTokens} tok pour un faux outil de ~${cap} tok brut ` +
      `→ ${c.inputTokens < cap ? "BORNÉ (clamp actif)" : "NON borné (à vérifier)"}.`,
    );
  }
  console.log(
    "\nRepère : si le TTFT du tour 2 ≲ tour 1 et/ou cacheRead > 0, le cache préfixe joue.\n" +
    "Si in(tok) du tour 3 reste << taille brute de l'outil, la troncature est effective.",
  );
}

main().catch(e => { console.error("Échec du banc :", e); process.exit(1); });
