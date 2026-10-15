/**
 * Comparateur de modèles — mesure le TTFT/débit du MÊME prompt système réel
 * sur plusieurs modèles du provider orvyx, pour objectiver lequel est rapide.
 *
 * Hors suite vitest (appel réseau). Lancer :
 *   npx tsx scripts/model-compare.ts
 *   npx tsx scripts/model-compare.ts --models a,b,c --runs 2
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt } from "../src/lib/agent/prompts";

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
const API_KEY = env.ORVYX_AI_API_KEY!;
const BASE = env.ORVYX_AI_BASE_URL ?? "https://api.orvyx-ai.com/v1";
if (!API_KEY) { console.error("ORVYX_AI_API_KEY manquant"); process.exit(1); }

const args = process.argv.slice(2);
const idx = args.indexOf("--models");
const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "claude-haiku-4-5",
  "qwen3-coder-480b-a35b-instruct-turbo",
  "llama-3.3-70b-instruct-turbo",
  "glm-5.3-flash",
];
const MODELS = idx >= 0 ? args[idx + 1].split(",") : DEFAULT_MODELS;
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx >= 0 ? Math.max(1, parseInt(args[runsIdx + 1] ?? "1", 10)) : 1;

const SYSTEM = buildSystemPrompt("agent", false);
const USER = "Reply with exactly one word: pong.";

async function once(model: string): Promise<{ ttftMs: number; totalMs: number; tok: number; err?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 16,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: USER },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return { ttftMs: -1, totalMs: performance.now() - t0, tok: 0, err: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ttft = -1;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const p = s.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const j = JSON.parse(p);
          const d = j.choices?.[0]?.delta?.content ?? "";
          if (d) { if (ttft < 0) ttft = performance.now() - t0; text += d; }
        } catch { /* ignore */ }
      }
    }
    const totalMs = performance.now() - t0;
    return { ttftMs: ttft < 0 ? totalMs : ttft, totalMs, tok: Math.ceil(text.length / 4) };
  } catch (e) {
    return { ttftMs: -1, totalMs: performance.now() - t0, tok: 0, err: (e as Error).message.slice(0, 80) };
  }
}

function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  console.log("═".repeat(74));
  console.log(`Comparateur de modèles — prompt système agent/normal (~${Math.ceil(SYSTEM.length / 4)} tok)`);
  console.log(`Mesures par modèle : ${RUNS}`);
  console.log("═".repeat(74));
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

  const results: Array<{ model: string; ttft: number; total: number; note: string }> = [];
  for (const model of MODELS) {
    const ts: number[] = [];
    const totals: number[] = [];
    let note = "";
    for (let r = 0; r < RUNS; r++) {
      const res = await once(model);
      if (res.err) { note = res.err; break; }
      ts.push(res.ttftMs);
      totals.push(res.totalMs);
      process.stdout.write(`  ${model} run${r + 1}: TTFT ${res.ttftMs.toFixed(0)}ms `);
    }
    if (ts.length) {
      const ttft = median(ts);
      const total = median(totals);
      results.push({ model, ttft, total, note: "" });
      console.log(`→ médiane TTFT ${ttft.toFixed(0)} ms`);
    } else {
      results.push({ model, ttft: Infinity, total: 0, note });
      console.log(`→ ÉCHEC (${note})`);
    }
  }

  results.sort((a, b) => a.ttft - b.ttft);
  console.log("\n" + "═".repeat(74));
  console.log("CLASSEMENT (TTFT croissant)");
  console.log("═".repeat(74));
  console.log(pad("modèle", 40) + "TTFT(ms)".padStart(10) + "total(ms)".padStart(11));
  console.log("-".repeat(74));
  for (const r of results) {
    const ttft = r.ttft === Infinity ? "ÉCHEC" : r.ttft.toFixed(0);
    console.log(pad(r.model, 40) + String(ttft).padStart(10) + String(r.ttft === Infinity ? "—" : r.total.toFixed(0)).padStart(11));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
