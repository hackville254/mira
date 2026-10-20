// ── Génération de fonctions — récupération des datasets EvalPlus RÉELS ────────
//
// Télécharge les datasets officiels EvalPlus (HuggingFace) puis les normalise en
// JSONL local, tel que consommé par `dataset.ts`. AUCUN contenu n'est inventé :
// les fichiers proviennent directement des dépôts publiés.
//
//   HumanEval+ : https://huggingface.co/datasets/evalplus/humanevalplus
//   MBPP+      : https://huggingface.co/datasets/evalplus/mbppplus
//
// HumanEval+ est publié en JSONL (`test.jsonl`). MBPP+ est publié en Parquet :
// on privilégie la conversion via `pyarrow` (dépendance de DATASET uniquement,
// jamais du moteur ORVYX Code) ; à défaut, on explique précisément le blocage.
//
// Usage :
//   npx tsx bench/coding/generation/fetchDatasets.ts            # les deux
//   npx tsx bench/coding/generation/fetchDatasets.ts humanevalplus

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { DATASETS_DIR, DATASET_VERSIONS } from "./dataset";
import type { GenerationBenchmark } from "./types";

/** URL canoniques des fichiers EvalPlus. */
const SOURCES: Record<GenerationBenchmark, string> = {
  humanevalplus:
    "https://huggingface.co/datasets/evalplus/humanevalplus/resolve/main/test.jsonl",
  mbppplus: "https://huggingface.co/datasets/evalplus/mbppplus/resolve/main/data/test-00000-of-00001-d5781c9c51e02795.parquet",
};

/** Noms de fichiers locaux. */
const LOCAL: Record<GenerationBenchmark, string> = {
  humanevalplus: "humanevalplus.jsonl",
  mbppplus: "mbppplus.jsonl",
};

/** Fichier intermédiaire pour MBPP+ (parquet avant conversion). */
const MBPP_PARQUET = join(DATASETS_DIR, "mbppplus.parquet");

/** Exécute une commande et renvoie stdout (rejette si code de sortie ≠ 0). */
function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += String(d)));
    child.stderr.on("data", d => (stderr += String(d)));
    child.on("error", err => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Télécharge une URL vers un fichier local via `fetch` (streaming). */
async function download(url: string, dest: string): Promise<void> {
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `téléchargement échoué (HTTP ${res.status}) : ${url}\n` +
      `Vérifie la connectivité réseau ; le fichier reste absent tant qu'il n'est pas récupéré.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`fichier téléchargé vide : ${url}`);
  await writeFile(dest, buf);
  process.stdout.write(`    écrit ${dest} (${buf.length} octets)\n`);
}

/** Compte les lignes non vides d'un JSONL et valide le premier enregistrement. */
async function validateJsonl(path: string): Promise<{ lines: number; keys: string[] }> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`JSONL vide après conversion : ${path}`);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  return { lines: lines.length, keys: Object.keys(first) };
}

/** Convertit le parquet MBPP+ en JSONL via pyarrow (script Python éphémère). */
async function convertMbppParquet(): Promise<void> {
  const dest = join(DATASETS_DIR, LOCAL.mbppplus);
  const script = [
    "import sys, json",
    "try:",
    "    import pyarrow.parquet as pq",
    "except Exception as e:",
    "    print('NO_PYARROW ' + str(e), file=sys.stderr); sys.exit(42)",
    "t = pq.read_table(sys.argv[1])",
    "rows = t.to_pylist()",
    "with open(sys.argv[2], 'w', encoding='utf-8') as f:",
    "    for r in rows:",
    "        f.write(json.dumps(r, ensure_ascii=False) + '\\n')",
  ].join("\n");

  // On essaie python3 (hôte). pyarrow est requis UNIQUEMENT ici.
  const r = await run("python3", ["-c", script, MBPP_PARQUET, dest]);
  if (r.code === 42 || /NO_PYARROW/.test(r.stderr)) {
    throw new Error(
      "conversion MBPP+ impossible : `pyarrow` n'est pas installé dans le Python hôte.\n" +
      "Installe-le puis relance :\n  python3 -m pip install --user pyarrow\n" +
      "Astuce : la conversion peut aussi être faite dans Docker, ex. :\n" +
      `  docker run --rm -v "${DATASETS_DIR}":/d python:3.11-slim sh -c "pip install -q pyarrow && python -c \\"import pyarrow.parquet as pq,json;t=pq.read_table('/d/mbppplus.parquet');open('/d/mbppplus.jsonl','w').write(''.join(json.dumps(x,ensure_ascii=False)+chr(10) for x in t.to_pylist()))\\""`,
    );
  }
  if (r.code !== 0) {
    throw new Error(`conversion MBPP+ échouée (code ${r.code}) :\n${r.stderr.slice(0, 800)}`);
  }
}

/** Télécharge et normalise un benchmark. Renvoie un résumé vérifiable. */
async function fetchOne(benchmark: GenerationBenchmark): Promise<{ lines: number; keys: string[] }> {
  const dest = join(DATASETS_DIR, LOCAL[benchmark]);
  process.stdout.write(`\n[${benchmark}] version : ${DATASET_VERSIONS[benchmark]}\n`);

  if (benchmark === "humanevalplus") {
    await download(SOURCES.humanevalplus, dest);
  } else {
    await download(SOURCES.mbppplus, MBPP_PARQUET);
    await convertMbppParquet();
    // On retire l'intermédiaire pour ne pas laisser de fichier lourd inutile.
    if (existsSync(MBPP_PARQUET)) await rm(MBPP_PARQUET, { force: true });
  }

  const info = await validateJsonl(dest);
  process.stdout.write(`  ✓ ${info.lines} lignes — colonnes : ${info.keys.join(", ")}\n`);
  return info;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
  const targets: GenerationBenchmark[] =
    args.length > 0
      ? (args as GenerationBenchmark[])
      : ["humanevalplus", "mbppplus"];

  for (const t of targets) {
    if (t !== "humanevalplus" && t !== "mbppplus") {
      throw new Error(`benchmark inconnu : ${t} (attendu : humanevalplus | mbppplus)`);
    }
  }

  await mkdir(DATASETS_DIR, { recursive: true });
  const summary: Record<string, { lines: number; keys: string[] }> = {};
  for (const t of targets) {
    summary[t] = await fetchOne(t);
  }

  process.stdout.write("\nDatasets prêts :\n");
  for (const [k, v] of Object.entries(summary)) {
    process.stdout.write(`  ${k} : ${v.lines} tâches\n`);
  }
}

// `HERE` conservé pour cohérence avec dataset.ts (résolution du dossier datasets).
void dirname(fileURLToPath(import.meta.url));

main().catch(err => {
  process.stderr.write(`\nERREUR : ${(err as Error).message}\n`);
  process.exit(1);
});
