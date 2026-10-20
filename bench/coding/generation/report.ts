// ── Génération — métriques et rapport (Pass@1, ventilation, comparaison) ──────
//
// Principes exigeants de la mission (Phase 4) :
//  - Pass@1 = taux de réussite au PREMIER essai, par (benchmark, mode, modèle) ;
//  - ventilation par catégorie d'erreur (modèle / fournisseur / timeout / …) ;
//  - médiane ET p95 des durées (p95 seulement si l'échantillon est suffisant) ;
//  - coût moyen par tâche RÉUSSIE (uniquement si un tarif est fourni) ;
//  - on NE fusionne JAMAIS des benchmarks différents en un score arbitraire ;
//  - une valeur indisponible reste `undefined` — jamais remplacée par 0.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ErrorClass,
  GenerationAttempt,
  GenerationBenchmark,
  EvalMode,
} from "./types";

/** Statistiques descriptives d'une série de durées (ms). */
export interface DurationStats {
  count: number;
  mean: number;
  median: number;
  p95: number | null;
  max: number;
}

export interface GroupSummary {
  benchmark: GenerationBenchmark;
  evalMode: EvalMode;
  modelId: string;
  provider: string;
  datasetVersion: string;
  /** Vrai si le groupe porte sur un sous-ensemble du benchmark. */
  subset: boolean;
  attempts: number;
  resolved: number;
  /** Pass@1 = resolved / attempts (le run 1 par tâche est le premier essai). */
  passAt1: number;
  /** Ventilation des échecs par origine. */
  byErrorClass: Partial<Record<ErrorClass, number>>;
  /** Durées de génération (agent ou HTTP). */
  generationMs: DurationStats;
  /** Durées de notation Docker. */
  evalMs: DurationStats;
  /** Durées totales. */
  totalMs: DurationStats;
  /** Tokens (somme), si disponibles au moins une fois. */
  inputTokens?: number;
  outputTokens?: number;
  /** Nombre de tentatives où les tokens étaient indisponibles. */
  tokensMissing: number;
  turns: number;
  toolCalls: number;
  /** Coût estimé (USD) et source du tarif, si fourni. Sinon `null` = inconnu. */
  estimatedCostUsd: number | null;
  costPerResolvedUsd: number | null;
  costSource: string | null;
}

export interface GenerationReport {
  schemaVersion: 1;
  generatedAt: string;
  /** Rappel explicite de méthode : jamais un score officiel « clé en main ». */
  note: string;
  groups: GroupSummary[];
  attempts: GenerationAttempt[];
}

function stats(xs: number[]): DurationStats {
  if (xs.length === 0) return { count: 0, mean: 0, median: 0, p95: null, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  // p95 seulement à partir de 20 échantillons : en dessous, l'estimation n'a
  // pas de sens statistique (on renvoie null = inconnu, jamais une valeur fausse).
  const p95 = sorted.length >= 20 ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null;
  return {
    count: sorted.length,
    mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    median: Math.round(median),
    p95: p95 === null ? null : Math.round(p95),
    max: sorted[sorted.length - 1],
  };
}

/** Tarif par million de tokens, fourni explicitement par l'appelant. */
export interface TokenTariff {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Source du tarif (URL ou libellé). Obligatoire pour tracer le calcul. */
  source: string;
}

/**
 * Agrège les tentatives en groupes (benchmark × mode × modèle). Le tarif est
 * optionnel : sans lui, le coût reste `null` (INCONNU), jamais 0.
 */
export function summarizeGeneration(
  attempts: GenerationAttempt[],
  tariff?: TokenTariff,
): GenerationReport {
  const groups = new Map<string, GenerationAttempt[]>();
  for (const a of attempts) {
    const k = `${a.benchmark}::${a.evalMode}::${a.modelId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }

  const out: GroupSummary[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const byErrorClass: Partial<Record<ErrorClass, number>> = {};
    for (const a of list) {
      if (a.resolved) continue;
      const c = a.errorClass ?? "harness";
      byErrorClass[c] = (byErrorClass[c] ?? 0) + 1;
    }
    const resolved = list.filter(a => a.resolved).length;
    const tokensMissing = list.filter(a => a.metrics.inputTokens === undefined && a.metrics.outputTokens === undefined).length;
    const sum = (f: (a: GenerationAttempt) => number | undefined): number | undefined => {
      const vals = list.map(f).filter((n): n is number => typeof n === "number");
      return vals.length > 0 ? vals.reduce((x, y) => x + y, 0) : undefined;
    };
    const inputTokens = sum(a => a.metrics.inputTokens);
    const outputTokens = sum(a => a.metrics.outputTokens);

    let estimatedCostUsd: number | null = null;
    let costPerResolvedUsd: number | null = null;
    let costSource: string | null = null;
    if (tariff && inputTokens !== undefined && outputTokens !== undefined) {
      estimatedCostUsd =
        (inputTokens / 1_000_000) * tariff.inputPerMillion +
        (outputTokens / 1_000_000) * tariff.outputPerMillion;
      costPerResolvedUsd = resolved > 0 ? estimatedCostUsd / resolved : null;
      costSource = tariff.source;
    }

    out.push({
      benchmark: first.benchmark,
      evalMode: first.evalMode,
      modelId: first.modelId,
      provider: first.provider,
      datasetVersion: first.datasetVersion,
      subset: first.subset,
      attempts: list.length,
      resolved,
      passAt1: list.length > 0 ? resolved / list.length : 0,
      byErrorClass,
      generationMs: stats(list.map(a => a.metrics.generationMs)),
      evalMs: stats(list.map(a => a.metrics.evalMs)),
      totalMs: stats(list.map(a => a.metrics.totalMs)),
      inputTokens,
      outputTokens,
      tokensMissing,
      turns: sum(a => a.metrics.modelCalls) ?? 0,
      toolCalls: sum(a => a.metrics.toolCalls) ?? 0,
      estimatedCostUsd,
      costPerResolvedUsd,
      costSource,
    });
  }
  out.sort((a, b) =>
    a.benchmark.localeCompare(b.benchmark) ||
    a.evalMode.localeCompare(b.evalMode) ||
    b.passAt1 - a.passAt1,
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note:
      "Scores de génération de fonctions (HumanEval+/MBPP+, EvalPlus). " +
      "Pass@1 mesuré par exécution du programme de test OFFICIEL EvalPlus dans un conteneur isolé. " +
      "Un sous-ensemble est étiqueté `subset:true` et n'est PAS un score sur le benchmark complet. " +
      "Les scores de benchmarks différents ne sont jamais fusionnés. " +
      "Précision MBPP+ : l'énoncé naturel ne nomme pas toujours la fonction attendue, " +
      "mais le test officiel l'appelle par son nom exact — un nom différent produit un " +
      "`NameError` classé `model` (échec légitime, conforme au protocole officiel).",
    groups: out,
    attempts,
  };
}

/** Écrit le rapport JSON (crée le dossier parent). */
export async function writeGenerationReport(report: GenerationReport, outFile: string): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Tableau texte lisible pour la console. */
export function formatGenerationTable(report: GenerationReport): string {
  const head = ["benchmark", "mode", "modèle", "résolus", "pass@1", "méd. gen", "méd. eval", "coût/tâche réussie"];
  const rows = report.groups.map(g => [
    g.benchmark,
    g.evalMode,
    g.modelId,
    `${g.resolved}/${g.attempts}`,
    `${(g.passAt1 * 100).toFixed(1)}%`,
    `${g.generationMs.median}ms`,
    `${g.evalMs.median}ms`,
    g.costPerResolvedUsd === null ? "inconnu" : `$${g.costPerResolvedUsd.toFixed(4)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  return [line(head), widths.map(w => "-".repeat(w)).join("-|-"), ...rows.map(line)].join("\n");
}

/** Ligne « ventilation » lisible : origine d'échec → nombre. */
export function formatErrorBreakdown(g: GroupSummary): string {
  const entries = Object.entries(g.byErrorClass) as [ErrorClass, number][];
  if (entries.length === 0) return "aucun échec";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}
