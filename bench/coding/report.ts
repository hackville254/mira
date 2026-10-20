// ── Agrégation des résultats de benchmark de codage ───────────────────────────
//
// Transforme une liste plate d'`AttemptResult` en un rapport JSON versionné :
//   - score de résolution par modèle (toutes tâches, puis par catégorie) ;
//   - durées (agent / tests) en moyenne et médiane ;
//   - tokens et appels d'outils agrégés ;
//   - erreurs VENTILÉES par origine (agent, tests, harnais) — jamais confondues.
//
// Le rapport ne contient JAMAIS de clé API : `modelId` est un libellé public.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AttemptResult, AttemptOutcome } from "./types";

export interface ModelSummary {
  modelId: string;
  attempts: number;
  resolved: number;
  /** Taux de résolution (0..1). */
  resolvedRate: number;
  byOutcome: Record<AttemptOutcome, number>;
  /** Durées (ms) sur les tentatives où l'agent a fourni une mesure. */
  agentMs: { mean: number; median: number; max: number };
  testMs: { mean: number; median: number; max: number };
  /** Sommes déclarées par le driver, si présentes. */
  tokens: { input: number; output: number };
  turns: number;
  toolCalls: number;
  /** Ventilation des échecs — permet de distinguer modèle / outils / harnais. */
  byCategory: Record<string, { attempts: number; resolved: number }>;
}

export interface BenchReport {
  schemaVersion: 1;
  generatedAt: string;
  /** Rappel explicite : ceci n'est PAS un score SWE-bench officiel. */
  note: string;
  models: ModelSummary[];
  attempts: AttemptResult[];
}

const OUTCOMES: AttemptOutcome[] = ["resolved", "unresolved", "agent-error", "harness-error"];

function stats(xs: number[]): { mean: number; median: number; max: number } {
  if (xs.length === 0) return { mean: 0, median: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    median: Math.round(median),
    max: sorted[sorted.length - 1],
  };
}

/** Agrège les tentatives par modèle. `kindOf` associe un taskId à sa catégorie. */
export function summarize(
  attempts: AttemptResult[],
  kindOf: (taskId: string) => string = () => "unknown",
): BenchReport {
  const byModel = new Map<string, AttemptResult[]>();
  for (const a of attempts) {
    const list = byModel.get(a.modelId) ?? [];
    list.push(a);
    byModel.set(a.modelId, list);
  }

  const models: ModelSummary[] = [];
  for (const [modelId, list] of byModel) {
    const byOutcome = Object.fromEntries(OUTCOMES.map(o => [o, 0])) as Record<AttemptOutcome, number>;
    const byCategory: Record<string, { attempts: number; resolved: number }> = {};
    for (const a of list) {
      byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
      const cat = kindOf(a.taskId);
      const c = (byCategory[cat] ??= { attempts: 0, resolved: 0 });
      c.attempts += 1;
      if (a.outcome === "resolved") c.resolved += 1;
    }
    const resolved = byOutcome.resolved;
    models.push({
      modelId,
      attempts: list.length,
      resolved,
      resolvedRate: list.length > 0 ? resolved / list.length : 0,
      byOutcome,
      agentMs: stats(list.map(a => a.agentMs).filter(n => n > 0)),
      testMs: stats(list.map(a => a.testMs).filter(n => n > 0)),
      tokens: {
        input: list.reduce((s, a) => s + (a.inputTokens ?? 0), 0),
        output: list.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
      },
      turns: list.reduce((s, a) => s + (a.turns ?? 0), 0),
      toolCalls: list.reduce((s, a) => s + (a.toolCalls ?? 0), 0),
      byCategory,
    });
  }
  models.sort((a, b) => b.resolvedRate - a.resolvedRate);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: "Harnais interne — tâches internes vérifiées par tests. Ceci n'est PAS un score SWE-bench officiel (protocole Docker/harness non appliqué).",
    models,
    attempts,
  };
}

/** Écrit le rapport JSON (crée le dossier parent si besoin). */
export async function writeReport(report: BenchReport, outFile: string): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Tableau texte lisible (pour la console ou le rapport Markdown). */
export function formatTable(report: BenchReport): string {
  const head = ["modèle", "résolus", "taux", "échec agent", "échec harnais", "agent ms (méd.)", "tests ms (méd.)"];
  const rows = report.models.map(m => [
    m.modelId,
    `${m.resolved}/${m.attempts}`,
    `${(m.resolvedRate * 100).toFixed(1)}%`,
    String(m.byOutcome["agent-error"] ?? 0),
    String(m.byOutcome["harness-error"] ?? 0),
    String(m.agentMs.median),
    String(m.testMs.median),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  return [line(head), widths.map(w => "-".repeat(w)).join("-|-"), ...rows.map(line)].join("\n");
}
