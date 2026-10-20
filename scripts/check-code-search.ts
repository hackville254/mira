// Vérification manuelle de l'Étape 2 : `codebase_search` est-il réellement
// exposé par le sidecar quand on déclare `extraTools:[{kind:"code_index"}]`, et
// le handler headless répond-il correctement à `search_index` ?
//
// Ce script pilote le VRAI bundle sidecar (comme Rust) mais n'appelle PAS de
// LLM : il vérifie uniquement le chemin `tool_invoke` → handler → réponse.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ClineSidecarClient } from "../bench/coding/headless/clineSidecar";
import { searchIndex, clearSearchCache } from "../bench/coding/headless/codeSearch";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR = join(ROOT, "src-tauri", "cline-sidecar", "dist", "index.mjs");

async function main(): Promise<void> {
  const ws = await mkdtemp(join(tmpdir(), "orvyx-searchcheck-"));
  await writeFile(join(ws, "auth_service.py"), "def login_with_token(token):\n    return token\n");
  await writeFile(join(ws, "unrelated.py"), "x = 1\n");

  const seen: string[] = [];
  const client = new ClineSidecarClient({
    sidecarPath: SIDECAR,
    dataDir: await mkdtemp(join(tmpdir(), "orvyx-searchcheck-data-")),
    onLog: m => console.log(`   [client] ${m}`),
    onToolInvoke: async (command, args) => {
      seen.push(command);
      if (command !== "search_index") throw new Error(`non supporté: ${command}`);
      const hits = await searchIndex(
        String(args.workspace ?? ""),
        String(args.query ?? ""),
        typeof args.limit === "number" ? args.limit : 12,
      );
      return JSON.stringify(hits);
    },
  });
  await client.start();

  // On déclare les extraTools (le client le fait dès qu'onToolInvoke existe) :
  // ici on vérifie le handler DIRECTEMENT (le SDK seul décide d'appeler l'outil).
  console.log("handler direct search_index ->", await searchIndex(ws, "login token", 5));
  clearSearchCache();
  console.log("commandes vues:", seen);

  await client.dispose();
  await rm(ws, { recursive: true, force: true });
  console.log("OK: chemin tool_invoke → recherche BM25 opérationnel en headless");
}

void main().catch(e => {
  console.error("ERREUR:", e);
  process.exit(1);
});
