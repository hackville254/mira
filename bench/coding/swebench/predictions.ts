// ── SWE-bench — collecte des patchs produits et publication ───────────────────
//
// Ce module réunit deux responsabilités, séparées du reste du harnais afin que
// la publication reste auditable :
//
//   1. `captureModelPatch(repoDir)` — extrait le diff git produit par l'agent
//      dans un dépôt préparé. C'est le `model_patch` du format officiel.
//   2. `writePredictions(...)` — écrit `predictions.jsonl`, fichier accepté par
//      le harness officiel SWE-bench :
//          {"instance_id": ..., "model_patch": ..., "model_name_or_path": ...}
//
// GARANTIES :
//   - aucune clé API n'est écrite : `model_name_or_path` est un libellé public ;
//   - un `model_patch` vide est écrit explicitement (chaîne vide) — le harness
//     officiel le compte comme non résolu, ce qui est le comportement correct ;
//   - l'ordre des instances est stable (trié) pour rendre le fichier diffable.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Une prédiction au format officiel (aucun champ supplémentaire). */
export interface Prediction {
  instance_id: string;
  model_patch: string;
  model_name_or_path: string;
}

/** Timeout (ms) des commandes git de capture. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Capture le diff produit par l'agent dans un dépôt préparé.
 *
 * Inclut les fichiers modifiés ET non suivis (`git add -A` en index virtuel via
 * `git diff HEAD`), car un agent peut créer de nouveaux fichiers de code source.
 * Les fichiers de test ne sont PAS exclus ici : l'exclusion éventuelle relève du
 * harness d'évaluation, pas de la capture. Renvoie une chaîne vide si le dépôt
 * n'a subi aucune modification.
 */
export async function captureModelPatch(repoDir: string): Promise<string> {
  // `git add -A` marque les nouveaux fichiers comme suivis (sans commit).
  await exec("git", ["add", "-A"], { cwd: repoDir, timeout: GIT_TIMEOUT_MS }).catch(() => {});
  const { stdout } = await exec(
    "git",
    ["diff", "--cached", "--binary", "--no-color", "HEAD"],
    { cwd: repoDir, timeout: GIT_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Écrit `predictions.jsonl` — un objet JSON par ligne, trié par `instance_id`.
 * `model_name_or_path` doit être un libellé public (ex. `orvyx-code/deepseek-v4-flash`),
 * JAMAIS une clé API ni une URL contenant un secret.
 */
export async function writePredictions(
  predictions: Prediction[],
  outFile: string,
): Promise<void> {
  const sorted = [...predictions].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const body = sorted.map(p => JSON.stringify(p)).join("\n");
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${body}\n`, "utf8");
}
