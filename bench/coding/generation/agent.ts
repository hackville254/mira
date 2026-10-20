// ── Génération — MODE AGENT (système complet ORVYX Code) ───────────────────────
//
// On pilote le VRAI moteur Cline via le client headless NDJSON (celui que Rust
// lance en production). L'agent dispose de ses outils réels (lecture, écriture,
// shell, patch) dans un workspace JETABLE, et rend sa solution en texte.
//
// Différence avec le mode model-only : ici l'agent peut itérer, exécuter des
// commandes si on l'autorise, se relire… C'est exactement ce que mesure la
// mission au niveau « système complet » (Phase 3, Mode 2).
//
// SÉCURITÉ :
//  - workspace jetable sous le dossier temporaire de l'OS, jamais le dépôt réel ;
//  - politique d'approbation LOCALE et journalisée (auto-approbation explicite
//    pour un run non interactif) ;
//  - outils dépendant de Tauri (navigateur, index codebase) NON déclarés : le
//    sidecar ne les crée pas → aucune fausse capacité ;
//  - clé d'API jamais journalisée ; timeout dur avec abort propre.

import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { ClineSidecarClient, type HeadlessRunMetrics } from "../headless/clineSidecar";

/** Sortie d'un run agent. */
export interface AgentRunResult {
  /** Texte final produit par l'agent (concaténation des blocs `content_end`). */
  text: string;
  metrics: HeadlessRunMetrics;
  /** Classe d'erreur d'orchestration, si détectée. */
  errorClass?: "provider" | "timeout" | "orchestration" | "tool";
  error?: string;
}

export interface AgentRunOptions {
  /** Chemin du bundle sidecar (`src-tauri/cline-sidecar/dist/index.mjs`). */
  sidecarPath: string;
  /** Dossier de données Cline isolé (SQLite). */
  dataDir: string;
  providerId: string;
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  instruction: string;
  /** Itérations maximum de la boucle d'outils. */
  maxIterations?: number;
  /** Timeout (ms) du run complet. Défaut : 10 min. */
  timeoutMs?: number;
  /** Journalisation (jamais un secret). */
  onLog?: (msg: string) => void;
}

/**
 * Classe l'issue d'un run agent côté orchestration à partir des métriques.
 * Ne décide PAS de la réussite de la tâche (c'est l'évaluateur qui tranche).
 */
export function classifyAgentRun(
  metrics: HeadlessRunMetrics,
  maxIterations: number,
): { errorClass?: AgentRunResult["errorClass"]; error?: string } {
  const e = metrics.error ?? "";
  if (metrics.totalMs === 0 && !e) return {};
  // Message d'erreur du moteur : on l'analyse sans le confondre avec un échec
  // d'évaluation. Un HTTP/429 est une erreur FOURNISSEUR, pas une erreur du modèle.
  if (/429|rate.?limit|too many requests/i.test(e)) return { errorClass: "provider", error: e };
  if (/\b(5\d\d)\b|http|network|ECONN|fetch failed/i.test(e)) return { errorClass: "provider", error: e };
  if (/timeout|aborted|timed out/i.test(e)) return { errorClass: "timeout", error: e };
  if (/iteration|max.?(iteration|steps)|limite d'it/i.test(e)) return { errorClass: "orchestration", error: e };
  if (/tool/i.test(e)) return { errorClass: "tool", error: e };
  // Le run a « terminé » à exactement maxIterations tours : l'agent n'a pas
  // conclu — c'est une limite d'orchestration, pas un échec de code.
  if (maxIterations > 0 && metrics.turns >= maxIterations) {
    return { errorClass: "orchestration", error: `limite d'itérations atteinte (${maxIterations})` };
  }
  return e ? { errorClass: "orchestration", error: e } : {};
}

/**
 * Exécute UN run agent sur une instruction. Ne lève jamais : toute erreur est
 * renvoyée classée. Le client sidecar est fourni par l'appelant (réutilisation
 * d'un process pour toute la campagne).
 */
export async function runAgentOnTask(
  client: ClineSidecarClient,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const maxIterations = opts.maxIterations ?? 20;
  const workspace = join(tmpdir(), `orvyx-gen-ws-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(workspace, { recursive: true });

  try {
    const run = await client.runTurn(
      {
        cwd: workspace,
        providerId: opts.providerId,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        modelId: opts.modelId,
        systemPrompt: opts.systemPrompt,
        mode: "act",
        maxIterations,
      },
      opts.instruction,
    );
    const timer = setTimeout(() => { void run.abort(); }, opts.timeoutMs ?? 10 * 60 * 1000);
    try {
      await run.finished;
    } finally {
      clearTimeout(timer);
    }
    const metrics = run.metrics;
    const cls = classifyAgentRun(metrics, maxIterations);
    return { text: run.finalText ?? "", metrics, ...cls };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      text: "",
      metrics: { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 0, error: msg },
      errorClass: /timeout|aborted/i.test(msg) ? "timeout" : "provider",
      error: msg,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
