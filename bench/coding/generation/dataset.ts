// ── Génération de fonctions — chargement des datasets EvalPlus RÉELS ──────────
//
// On lit les fichiers JSONL TÉLÉCHARGÉS depuis HuggingFace (`evalplus/humanevalplus`,
// `evalplus/mbppplus`, licence Apache-2.0). Aucune donnée n'est inventée ni
// synthétisée : si un fichier manque, on lève une erreur explicite indiquant la
// commande de téléchargement.
//
// FORMATS RÉELS (vérifiés sur les fichiers)
// -----------------------------------------
//  HumanEval+ (164 lignes) : {task_id, prompt, canonical_solution, entry_point, test}
//    - `prompt` = signature + docstring ; `test` = programme contenant
//      `check(candidate)` et, en fin de fichier, l'appel `check(<entry_point>)`.
//  MBPP+ (378 lignes) : {task_id, code, prompt, source_file, test_imports, test_list, test}
//    - `prompt` = énoncé en langage naturel ; `code` = solution canonique ;
//      `test_imports` = imports requis ; `test` = programme de test étendu.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GenerationBenchmark, GenerationTask } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Dossier des datasets téléchargés (JSONL). */
export const DATASETS_DIR = join(HERE, "datasets");

/**
 * Version explicite du dataset. On l'inscrit AVEC chaque résultat pour qu'un
 * score reste interprétable dans le temps (le contenu HF peut évoluer).
 */
export const DATASET_VERSIONS: Record<GenerationBenchmark, string> = {
  humanevalplus: "evalplus/humanevalplus@main:test.jsonl",
  mbppplus: "evalplus/mbppplus@main:test-00000-of-00001.parquet→jsonl",
};

/** Nom de fichier local par benchmark. */
const FILES: Record<GenerationBenchmark, string> = {
  humanevalplus: "humanevalplus.jsonl",
  mbppplus: "mbppplus.jsonl",
};

/** Commande de (re)téléchargement, affichée quand un fichier manque. */
export const DOWNLOAD_HINT =
  "npx tsx bench/coding/generation/fetchDatasets.ts";

/** Ligne brute HumanEval+ telle que publiée par EvalPlus. */
interface RawHumanEvalPlus {
  task_id: string;
  prompt: string;
  canonical_solution: string;
  entry_point: string;
  test: string;
}

/** Ligne brute MBPP+ telle que publiée par EvalPlus (après conversion parquet→JSONL). */
interface RawMbppPlus {
  task_id: number;
  code: string;
  prompt: string;
  source_file?: string;
  test_imports?: string[];
  test_list?: string[];
  test: string;
}

/**
 * Extrait le nom du point d'entrée depuis un énoncé MBPP+ (pas de `entry_point`
 * explicite) — on lit la première `def` du code canonique fourni par EvalPlus.
 * Renvoie une chaîne vide si introuvable ; le runner EvalPlus échouera alors
 * proprement plutôt que de deviner à tort.
 */
function entryPointFromCode(code: string): string {
  const m = /^\s*def\s+([A-Za-z_]\w*)\s*\(/m.exec(code);
  return m ? m[1] : "";
}

/** Transforme une ligne HumanEval+ brute en tâche normalisée. */
function fromHumanEvalPlus(raw: RawHumanEvalPlus): GenerationTask {
  if (!raw.task_id || !raw.prompt || !raw.test || !raw.entry_point) {
    throw new Error(`HumanEval+ : ligne invalide (champs manquants) : ${raw.task_id ?? "?"}`);
  }
  return {
    taskId: raw.task_id,
    benchmark: "humanevalplus",
    datasetVersion: DATASET_VERSIONS.humanevalplus,
    prompt: raw.prompt,
    entryPoint: raw.entry_point,
    test: raw.test,
    testImports: [],
  };
}

/** Transforme une ligne MBPP+ brute en tâche normalisée. */
function fromMbppPlus(raw: RawMbppPlus): GenerationTask {
  const entryPoint = entryPointFromCode(raw.code ?? "");
  if (raw.task_id === undefined || !raw.prompt || !raw.test || !entryPoint) {
    throw new Error(`MBPP+ : ligne invalide (champs manquants) : ${raw.task_id ?? "?"}`);
  }
  return {
    taskId: `MBPP/${raw.task_id}`,
    benchmark: "mbppplus",
    datasetVersion: DATASET_VERSIONS.mbppplus,
    prompt: raw.prompt,
    entryPoint,
    test: raw.test,
    testImports: Array.isArray(raw.test_imports) ? raw.test_imports : [],
  };
}

/** Chemin du fichier JSONL local pour un benchmark. */
export function datasetPath(benchmark: GenerationBenchmark): string {
  return join(DATASETS_DIR, FILES[benchmark]);
}

/**
 * Charge TOUTES les tâches d'un benchmark depuis le fichier local. Lève une
 * erreur explicite si le fichier est absent (jamais de fallback silencieux).
 */
export async function loadTasks(benchmark: GenerationBenchmark): Promise<GenerationTask[]> {
  const path = datasetPath(benchmark);
  if (!existsSync(path)) {
    throw new Error(
      `dataset ${benchmark} introuvable : ${path}\n` +
      `Télécharge-le d'abord :\n  ${DOWNLOAD_HINT}`,
    );
  }
  const text = await readFile(path, "utf8");
  const out: GenerationTask[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const raw = JSON.parse(s) as unknown;
    out.push(
      benchmark === "humanevalplus"
        ? fromHumanEvalPlus(raw as RawHumanEvalPlus)
        : fromMbppPlus(raw as RawMbppPlus),
    );
  }
  if (out.length === 0) throw new Error(`dataset ${benchmark} vide : ${path}`);
  return out;
}

/**
 * Sélectionne un sous-ensemble REPRODUCTIBLE et DÉTERMINISTE : on prend les
 * N premières tâches dans l'ordre d'apparition du fichier. Aucun tirage
 * aléatoire (une campagne doit être rejouable à l'identique).
 *
 * `taskIds`, s'il est fourni, prime sur `limit` (sélection explicite).
 */
export function selectTasks(
  tasks: GenerationTask[],
  opts: { limit?: number; taskIds?: string[] } = {},
): GenerationTask[] {
  if (opts.taskIds && opts.taskIds.length > 0) {
    const wanted = new Set(opts.taskIds);
    const found = tasks.filter(t => wanted.has(t.taskId));
    const missing = opts.taskIds.filter(id => !tasks.some(t => t.taskId === id));
    if (missing.length > 0) {
      throw new Error(`tâches introuvables dans le dataset : ${missing.join(", ")}`);
    }
    return found;
  }
  if (opts.limit !== undefined && opts.limit >= 0 && opts.limit < tasks.length) {
    return tasks.slice(0, opts.limit);
  }
  return tasks;
}
