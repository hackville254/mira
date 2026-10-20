#!/usr/bin/env node
// ── CLI du benchmark de codage ────────────────────────────────────────────────
//
// Usage :
//   npx tsx bench/coding/cli.ts --driver=reference        (OFFLINE, sans réseau)
//   npx tsx bench/coding/cli.ts --driver=reference --out=bench/results/coding.json
//
// Le driver « reference » est un ORACLE DÉTERMINISTE : il applique la
// correction connue de chaque tâche. Il ne fait AUCUN appel modèle. Il sert à
// valider que le harnais mesure correctement (les scores doivent être 100 %).
//
// Un driver réel branché sur les vrais outils d'ORVYX (sidecar Cline, Tauri) est
// disponible via `--driver=cline` : il n'est utilisable QUE dans l'app Tauri
// (les outils de production passent par `invoke`, donc non simulables en Node).
// Un benchmark réseau lancé en Node (`bench:network`) est séparé et nécessite un
// accord explicite.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { loadTasks } from "./tasks";
import { runTask, type AgentDriver } from "./runner";
import { summarize, writeReport, formatTable } from "./report";
import { createTauriDriver, isTauriAvailable } from "./tauriDriver";
import { buildSystemPrompt } from "../../src/lib/agent/prompts";
import type { CodingTask } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS = join(HERE, "tasks");

/** Corrections connues, indexées par id de tâche — oracle de référence. */
const ORACLE: Record<string, Record<string, string>> = {
  "bugfix-sum-negatives": {
    "src/math.mjs": "export function sum(a, b) { return a + b; }\n",
  },
  "fix-test-range": {
    "src/range.mjs": "export function range(start, end) {\n  const out = [];\n  for (let i = start; i < end; i++) out.push(i);\n  return out;\n}\n",
  },
  "feature-slugify": {
    "src/text.mjs": [
      "export function titleCase(s) {",
      '  return String(s).split(" ").map(w => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(" ");',
      "}",
      "export function slugify(title) {",
      "  return String(title)",
      '    .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")',
      "    .toLowerCase()",
      '    .replace(/[^a-z0-9]+/g, "-")',
      '    .replace(/^-+|-+$/g, "");',
      "}",
      "",
    ].join("\n"),
    "src/post.mjs": 'import { slugify } from "./text.mjs";\nexport function makePost(title, body) {\n  return { title, body, slug: slugify(title) };\n}\n',
  },
};

/** Driver oracle : écrit la correction connue, sans réseau. */
function referenceDriver(): AgentDriver {
  return {
    id: "reference-oracle",
    async run({ workdir, instruction }) {
      const fs = await import("node:fs/promises");
      for (const { pattern, taskId } of ORACLE_MATCHERS) {
        if (pattern.test(instruction)) {
          const files = ORACLE[taskId];
          await applyOracle(workdir, files, fs);
          return { turns: 1, toolCalls: Object.keys(files).length };
        }
      }
      // Aucun motif reconnu : l'oracle n'intervient pas (tâche non couverte).
      return { turns: 0, toolCalls: 0 };
    },
  };
}

/** Motifs d'instruction → id de tâche possédant une correction connue. */
const ORACLE_MATCHERS: { pattern: RegExp; taskId: string }[] = [
  { pattern: /sum\(a, b\)/, taskId: "bugfix-sum-negatives" },
  { pattern: /range\(start, end\)/, taskId: "fix-test-range" },
  { pattern: /slugify/, taskId: "feature-slugify" },
];

async function applyOracle(
  workdir: string,
  files: Record<string, string>,
  fs: typeof import("node:fs/promises"),
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workdir, rel);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

function resolveDriver(name: string): AgentDriver {
  if (name === "reference") return referenceDriver();
  if (name === "cline" || name === "tauri") return clineDriver();
  throw new Error(
    `driver inconnu : « ${name} ». Drivers disponibles : reference (offline, oracle), ` +
    `cline|tauri (réel via sidecar, UNIQUEMENT dans l'app Tauri).`,
  );
}

/**
 * Construit le driver RÉEL à partir de l'environnement. Ne fait AUCUN appel
 * réseau ici : la clé est lue depuis `ORVYX_AI_API_KEY` et transmise au sidecar,
 * jamais journalisée. Hors Tauri, on refuse explicitement (les vrais outils
 * d'ORVYX passent par `invoke` et ne peuvent pas être simulés).
 */
function clineDriver(): AgentDriver {
  if (!isTauriAvailable()) {
    throw new Error(
      "driver « cline » indisponible ici : il nécessite l'app Tauri (les outils " +
      "de production passent par `invoke`). Lancez le bench depuis l'app, pas en Node.",
    );
  }
  const providerId = process.env.ORVYX_AI_PROVIDER;
  const modelId = process.env.ORVYX_AI_MODEL;
  const apiKey = process.env.ORVYX_AI_API_KEY;
  const baseUrl = process.env.ORVYX_AI_BASE_URL;
  if (!providerId || !modelId || !apiKey) {
    throw new Error(
      "driver « cline » : ORVYX_AI_PROVIDER, ORVYX_AI_MODEL et ORVYX_AI_API_KEY " +
      "sont requis dans l'environnement (valeurs jamais journalisées).",
    );
  }
  return createTauriDriver({
    workspace: process.cwd(),
    providerId,
    baseUrl,
    apiKey,
    modelId,
    // Prompt système RÉEL du mode Agent (contrat d'outils complet) : on ne
    // fabrique pas un prompt de test, on mesure le moteur tel qu'il est livré.
    systemPrompt: buildSystemPrompt("agent", true),
    autoApprove: process.env.ORVYX_BENCH_AUTO_APPROVE === "1",
  });
}

function argValue(args: string[], key: string): string | undefined {
  const hit = args.find(a => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const driverName = argValue(args, "driver") ?? "reference";
  const tasksDir = argValue(args, "tasks") ?? DEFAULT_TASKS;
  const runs = Number(argValue(args, "runs") ?? "1");
  const out = argValue(args, "out") ?? join(HERE, "..", "results", "coding.json");

  const driver = resolveDriver(driverName);
  const tasks: CodingTask[] = await loadTasks(tasksDir);
  // Associe chaque taskId à sa catégorie pour la ventilation du rapport.
  const kindOf = (id: string): string => tasks.find(t => t.id === id)?.kind ?? "unknown";

  console.log(`# Benchmark de codage — harnais interne`);
  console.log(`driver=${driver.id}  tâches=${tasks.length}  répétitions=${runs}\n`);

  const attempts = [];
  for (const task of tasks) {
    const rs = await runTask(task, driver, { tasksDir, runs });
    attempts.push(...rs);
    for (const r of rs) {
      const mark = r.outcome === "resolved" ? "✓" : r.outcome === "unresolved" ? "✗" : "!";
      console.log(`  ${mark} ${task.id} (run ${r.run}) — ${r.outcome} [agent ${r.agentMs}ms, tests ${r.testMs}ms]`);
      if (r.error) console.log(`      erreur : ${r.error}`);
    }
  }

  const report = summarize(attempts, kindOf);
  await writeReport(report, out);
  const markdownPath = out.replace(/\.json$/, ".md");
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(
    markdownPath,
    `# Rapport de benchmark de codage\n\nGénéré : ${report.generatedAt}\n\n> ${report.note}\n\n\`\`\`\n${formatTable(report)}\n\`\`\`\n`,
    "utf8",
  );

  console.log(`\n${formatTable(report)}`);
  console.log(`\nJSON  : ${out}`);
  console.log(`MD    : ${markdownPath}`);
}

main().catch((e) => {
  console.error(`Erreur du harnais : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
