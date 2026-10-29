#!/usr/bin/env node
// Build du sidecar Cline (moteur d'agent Node) — utilisé par `npm run build`
// AVANT `tauri build`, et à la demande en développement.
//
// Objectif : produire un **bundle mono-fichier** `dist/index.mjs` que Rust
// embarque comme ressource. On veut un build déterministe et reproductible,
// sans supposer que l'utilisateur a lancé un `npm install` dans le sous-dossier.
//
// Sécurité / hygiène :
//   - On n'exécute rien depuis le réseau ici : `npm ci/install` s'appuie sur le
//     lockfile du sous-dossier ; aucune URL arbitraire n'est fetchée par ce
//     script lui-même.
//   - Échec = code de sortie non nul : le build global s'arrête au lieu de
//     produire une app dont le moteur manquerait.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarDir = join(here, "..", "src-tauri", "cline-sidecar");
const outputFile = join(sidecarDir, "dist", "index.mjs");

if (!existsSync(sidecarDir)) {
  console.error(`[build-sidecar] dossier introuvable : ${sidecarDir}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";

/**
 * Exécute une commande npm dans le dossier du sidecar, en héritant stdio.
 *
 * `shell: true` sur Windows — OBLIGATOIRE : depuis Node 18.20.2 / 20.12.2
 * (correctif CVE-2024-27980), `spawn` refuse d'exécuter un `.cmd`/`.bat`
 * (`npm.cmd`) sans passer par le shell et échoue avec `EINVAL`. Le build CI
 * Windows cassait exactement là. Les arguments étant des littéraux fixes
 * ("ci", "install", "run", "build"), activer le shell n'introduit aucune
 * surface d'injection.
 */
function run(args) {
  const res = spawnSync(isWindows ? "npm.cmd" : "npm", args, {
    cwd: sidecarDir,
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
  });
  if (res.error) {
    console.error(`[build-sidecar] échec d'exécution : ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[build-sidecar] "npm ${args.join(" ")}" a échoué (code ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Dépendances : `npm ci` si un lockfile existe (reproductible), sinon
//    `npm install`. On ne le fait que si `node_modules` manque, pour ne pas
//    ralentir un rebuild incrémental.
const nodeModules = join(sidecarDir, "node_modules");
if (!existsSync(nodeModules)) {
  const hasLock = existsSync(join(sidecarDir, "package-lock.json"));
  run(hasLock ? ["ci"] : ["install"]);
}

// 2. Bundle esbuild mono-fichier (voir le script "build" du package.json).
run(["run", "build"]);

if (!existsSync(outputFile)) {
  console.error(`[build-sidecar] bundle attendu absent : ${outputFile}`);
  process.exit(1);
}

// 3. Garde-fou d'autonomie du bundle.
//
// POURQUOI : le bundle est copié **seul** comme ressource Tauri (dans
// `target/<profile>/cline-sidecar/dist/` en dev, et dans `Resources/` en
// release). Il n'a donc AUCUN `node_modules` à côté. Si une dépendance DIRECTE
// du sidecar reste en `--external` (ex. `simple-git`, `jiti`), Node ne peut pas
// la résoudre au runtime → le sidecar crashe au chargement → l'UI reçoit
// `SIDECAR_EXITED_EARLY` sans message clair. Cette régression a réellement eu
// lieu : on la verrouille.
//
// On cible uniquement les **dépendances déclarées** (pkg.dependencies) : le
// bundle peut contenir des `require()` conditionnels de paquets optionnels
// (`@aws-sdk/…` par exemple) qui n'échouent pas s'ils sont absents — les
// signaler serait un faux positif.
const pkg = JSON.parse(readFileSync(join(sidecarDir, "package.json"), "utf8"));
const declared = Object.keys(pkg.dependencies ?? {});
const bundleText = readFileSync(outputFile, "utf8");
const leaked = declared.filter((name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Import externe nu : `from "<pkg>"` ou `require("<pkg>")`, exactement.
  const re = new RegExp(`(?:from|require\\()\\s*["']${escaped}["']`);
  return re.test(bundleText);
});
if (leaked.length > 0) {
  console.error(
    `[build-sidecar] bundle NON autonome : dépendance(s) en import externe : ${leaked.join(", ")}\n` +
      `  → retire le flag --external correspondant dans le script "build" du package.json.`,
  );
  process.exit(1);
}

console.log(`[build-sidecar] OK → ${outputFile}`);
