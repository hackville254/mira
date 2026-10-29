#!/usr/bin/env node
// ── CLI SWE-bench — préparer, exécuter et publier un mini-set réel ────────────
//
// Usage :
//   npx tsx bench/coding/swebench/cli.ts --prepare-only
//   npx tsx bench/coding/swebench/cli.ts --prepare-only --instances=astropy__astropy-12907
//   npx tsx bench/coding/swebench/cli.ts --verify            (oracle : applique `patch`)
//   npx tsx bench/coding/swebench/cli.ts --predictions-only  (écrit predictions.jsonl vide/préexistant)
//
// RÔLE DE CE CLI
// --------------
// 1. `--prepare-only` : clone les dépôts réels, construit l'IMAGE DOCKER de
//    l'instance (linux/amd64, python 3.9), applique les `test_patch` et PROUVE
//    que les FAIL_TO_PASS échouent avant l'agent. Aucun appel modèle.
// 2. `--verify` : applique le `patch` ORACLE de l'instance puis relance les
//    tests DANS le conteneur. Si l'oracle ne fait pas passer les FAIL_TO_PASS,
//    l'environnement est mis en cause (jamais le modèle). Contrôle de validité
//    du banc d'essai.
// 3. `--predictions-only` : matérialise le squelette `predictions.jsonl`
//    (format officiel) pour pouvoir le compléter après un run réel.
//
// L'exécution d'un VRAI agent sur ces dépôts se fait depuis l'app Tauri
// (les outils de production passent par `invoke`) : ce CLI n'embarque pas
// d'appel modèle, conformément à la contrainte « pas de coût sans accord ».

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateInstance, type SweBenchInstance } from "./instance";
import { prepareInstance, runPytest, ensureArmed, parsePytestOutcome } from "./prepare";
import { writePredictions, type Prediction } from "./predictions";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTANCES_DIR = join(HERE, "instances");
const ENV_ROOT = join(HERE, ".envs");
// Résultats : `bench/coding/results` (là où vivent déjà `predictions.jsonl` et
// `swebench-results.json`). `HERE` = bench/coding/swebench → on remonte d'UN
// seul niveau (`..`) pour retomber sur `bench/coding`.
const RESULTS_DIR = join(HERE, "..", "results");

function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

/** Charge les instances demandées (toutes par défaut). */
async function loadInstances(only?: string[]): Promise<SweBenchInstance[]> {
  const files = (await readdir(INSTANCES_DIR)).filter(f => f.endsWith(".json"));
  const out: SweBenchInstance[] = [];
  for (const f of files) {
    const p = join(INSTANCES_DIR, f);
    const inst = validateInstance(JSON.parse(await readFile(p, "utf8")), p);
    if (!only || only.includes(inst.instance_id)) out.push(inst);
  }
  out.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  return out;
}

/**
 * Applique le patch ORACLE (seed de référence de l'instance) sur le dépôt hôte,
 * puis relance les FAIL_TO_PASS DANS le conteneur Docker (dépôt monté sur
 * /testbed). Si l'oracle ne fait pas passer les tests, c'est l'environnement
 * qui est en cause — jamais le modèle.
 */
async function verifyOracle(inst: SweBenchInstance, repoDir: string, image: string): Promise<boolean> {
  // État armé garanti : base_commit + test_patch (idempotent).
  await ensureArmed(inst, repoDir);
  // On part d'un base_commit PROPRE avant d'appliquer le patch oracle : sinon il
  // ne s'applique pas (« patch does not apply » sur un fichier déjà modifié).
  await exec("git", ["checkout", "--force", inst.base_commit, "--", "."], { cwd: repoDir, timeout: 60_000 })
    .catch(() => {});
  await ensureArmed(inst, repoDir);

  const patchFile = join(dirname(repoDir), "oracle_patch.diff");
  await writeFile(patchFile, inst.patch, "utf8");
  await exec("git", ["apply", "--whitespace=nowarn", patchFile], { cwd: repoDir, timeout: 60_000 });

  const stdout = await runPytest(repoDir, image, inst.FAIL_TO_PASS, 10 * 60 * 1000);
  const o = parsePytestOutcome(stdout);
  if (o.unresolved && !o.passed && !o.failed) return false;
  return o.passed && !o.failed && !o.errored;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = argValue(args, "instances")?.split(",").map(s => s.trim()).filter(Boolean);
  const instances = await loadInstances(only);

  if (args.includes("--predictions-only")) {
    // Squelette publiable : l'agent n'ayant rien produit ici, patch vide.
    const preds: Prediction[] = instances.map(i => ({
      instance_id: i.instance_id,
      model_patch: "",
      model_name_or_path: argValue(args, "model") ?? "orvyx-code/unknown",
    }));
    const out = argValue(args, "out") ?? join(RESULTS_DIR, "predictions.jsonl");
    await writePredictions(preds, out);
    console.log(`Squelette écrit : ${out} (${preds.length} instance(s), patch vide)`);
    return;
  }

  console.log(`# SWE-bench — ${instances.length} instance(s) locale(s)`);
  const report: { instance: string; ready: boolean; reason?: string; oracle?: boolean }[] = [];

  for (const inst of instances) {
    console.log(`\n── ${inst.instance_id} (${inst.repo})`);
    const prep = await prepareInstance(inst, { root: ENV_ROOT, log: m => console.log(`   ${m}`) });
    const entry: { instance: string; ready: boolean; reason?: string; oracle?: boolean } = {
      instance: inst.instance_id,
      ready: prep.ready,
      reason: prep.reason,
    };
    if (args.includes("--verify") && prep.ready) {
      console.log("   vérification oracle (patch de référence)…");
      entry.oracle = await verifyOracle(inst, prep.workdir, prep.image);
      // Nettoyage du patch oracle pour laisser un état exploitable par l'agent.
      await exec("git", ["checkout", "--", "."], { cwd: prep.workdir, timeout: 60_000 }).catch(() => {});
      console.log(`   oracle ${entry.oracle ? "OK (F2P passent avec le patch)" : "ÉCHEC (environnement suspect)"}`);
    }
    report.push(entry);
  }

  const out = join(RESULTS_DIR, "swebench-prepare.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nRapport de préparation : ${out}`);
  console.log(`\n${report.map(r => `${r.ready ? "✓" : "✗"} ${r.instance}${r.oracle != null ? ` (oracle ${r.oracle ? "OK" : "KO"})` : ""}${r.reason ? ` — ${r.reason}` : ""}`).join("\n")}`);
}

main().catch((e) => {
  console.error(`Erreur SWE-bench : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
