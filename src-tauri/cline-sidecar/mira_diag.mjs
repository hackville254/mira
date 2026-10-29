// Banc de diagnostic : pilote le VRAI sidecar (`dist/index.mjs`) en NDJSON,
// exactement comme le fait Rust. But : vérifier empiriquement qu'une
// génération Mira/Orvyx aboutit (providerId "orvyx" + clientType/routing
// passés dans `providerConfig`).
//
// Usage :
//   ORVYX_AI_API_KEY=oryx_... node mira_diag.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const WS = "/tmp/mira-diag-ws";
mkdirSync(WS, { recursive: true });

const API_KEY = process.env.ORVYX_AI_API_KEY;
if (!API_KEY) {
  console.error("ORVYX_AI_API_KEY manquant");
  process.exit(1);
}

// ── Interception réseau ──────────────────────────────────────────────────
// On veut savoir à QUEL host/URL le SDK envoie sa requête de complétion.
// On lance le sidecar via un préchargement (`__netspy.mjs`) qui patche
// `globalThis.fetch`, journalise chaque appel, puis importe le vrai entrypoint.
const preload = join(__dir, "__netspy.mjs");
const child = spawn("node", [preload], {
  cwd: WS,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let startId = null;
let sessionId = null;
let sent = false;
let sawText = false;

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.kind === "ready") {
      console.log("[ready] pid=", msg.pid);
      startId = "s1";
      const variant = process.env.VARIANT ?? "builtin";
      const base = {
        id: startId,
        type: "start",
        cwd: WS,
        apiKey: API_KEY,
        baseUrl: "https://api.orvyx-ai.com/v1",
        modelId: "deepseek-v4-flash-0731",
        mode: "act",
        enableTeams: false,
      };
      const cfg =
        variant === "builtin"
          ? { ...base, providerId: "openai-compatible" }
          : variant === "routing"
            ? { ...base, providerId: "orvyx", routingProviderId: "openai-compatible" }
            : { ...base, providerId: "orvyx", clientType: "openai-compatible" };
      console.log("[variant]", variant, JSON.stringify(cfg));
      send(cfg);
      continue;
    }

    // Réponse de commande
    if (msg.id && typeof msg.ok === "boolean") {
      if (msg.id === startId) {
        if (!msg.ok) {
          console.log("START KO:", JSON.stringify(msg.error));
          process.exit(3);
        }
        sessionId = msg.result?.sessionId ?? msg.result?.id ?? sessionId;
        console.log("[start ok] session=", sessionId);
        if (sessionId && !sent) {
          sent = true;
          send({ id: "s2", type: "send", sessionId, prompt: "Réponds exactement: PONG" });
        }
      }
      continue;
    }

    // Événements de session
    if (msg.kind === "event") {
      const e = msg.event ?? {};
      const t = e.type ?? e.kind;
      if (t) console.log("[event]", t, JSON.stringify(e).slice(0, 400));
      const text =
        e.text ??
        e.delta ??
        e.content ??
        e.message?.content ??
        (Array.isArray(e.parts) ? e.parts.map((p) => p?.text ?? "").join("") : "");
      if (t && /text|delta|message|assistant/i.test(String(t)) && text) {
        sawText = true;
        console.log("   ↳", JSON.stringify(String(text).slice(0, 80)));
      }
      if (/completed|done|finish|error|failed/i.test(String(t))) {
        console.log(sawText ? "RESULT: OK (texte reçu)" : "RESULT: terminé sans texte");
        if (e.error) console.log("   error:", JSON.stringify(e.error));
        child.kill();
        process.exit(sawText ? 0 : 4);
      }
    }
  }
});

setTimeout(() => {
  console.log("TIMEOUT — sawText=", sawText, "session=", sessionId);
  child.kill();
  process.exit(sawText ? 0 : 2);
}, 90000);
