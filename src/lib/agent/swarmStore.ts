import { useSyncExternalStore } from "react";
import type { SubAgentStatus } from "./run";

// ── Registre des sous-agents (mode IA uniquement) ──────────────────────────────
//
// En mode IDE, aucun sous-agent ne tourne (choix volontaire : économie de tokens).
// En mode IA, le root peut déléguer des explorations à des sous-agents read-only.
// Ce store observable expose leur état à l'UI :
//   - la carte « Sub-agent » dans le fil de chat (rendue via les parts du message) ;
//   - l'onglet « Agents » (vue d'ensemble des sous-agents actifs).
//
// Contrat : la référence de `snapshot` ne change QUE si la liste change réellement
// (exigence `useSyncExternalStore`), sinon React boucle à l'infini.

export interface SubAgentSnapshot {
  spawnId:     string;
  role:        string;
  task:        string;
  /** Id du tool-call `spawn_agent` correspondant (pour rattacher la carte). */
  toolCallId?: string;
  startedAt:   number;
  iterations:  number;
  /** Renseigné une seule fois, à la fin du sous-agent. */
  status?:     SubAgentStatus;
  inputTokens: number;
  outputTokens: number;
  /** Rapport final borné (vide tant que le sous-agent n'a pas terminé). */
  report:      string;
}

const registry = new Map<string, SubAgentSnapshot>();
const listeners = new Set<() => void>();

// Cache de snapshot : instance stable tant qu'aucune mutation n'a eu lieu.
let cachedList: SubAgentSnapshot[] = [];
let cacheValid = true;

function emit(): void {
  cacheValid = false;
  for (const cb of listeners) cb();
}

export function startSubAgent(meta: {
  spawnId: string; role: string; task: string; toolCallId?: string;
}): void {
  registry.set(meta.spawnId, {
    spawnId: meta.spawnId,
    role: meta.role,
    task: meta.task,
    toolCallId: meta.toolCallId,
    startedAt: Date.now(),
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    report: "",
  });
  emit();
}

export function stepSubAgent(spawnId: string, iteration: number): void {
  const entry = registry.get(spawnId);
  if (!entry) return;
  registry.set(spawnId, { ...entry, iterations: iteration });
  emit();
}

export function endSubAgent(
  spawnId: string,
  result: { status: SubAgentStatus; report: string; iterations: number; inputTokens: number; outputTokens: number },
): void {
  const entry = registry.get(spawnId);
  if (!entry) return;
  registry.set(spawnId, {
    ...entry,
    status: result.status,
    report: result.report,
    iterations: result.iterations,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  emit();
}

/** Instantané complet (du plus récent au plus ancien). */
export function listSubAgents(): SubAgentSnapshot[] {
  if (!cacheValid) {
    cachedList = Array.from(registry.values()).sort((a, b) => b.startedAt - a.startedAt);
    cacheValid = true;
  }
  return cachedList;
}

/** Seuls les sous-agents encore en cours (status non renseigné). */
export function listActiveSubAgents(): SubAgentSnapshot[] {
  return listSubAgents().filter(s => s.status === undefined);
}

/** Purge le registre à la fin d'un tour parent (les cartes du chat restent, elles,
 *  persistées dans les parts du message). */
export function clearSubAgents(): void {
  if (registry.size === 0) return;
  registry.clear();
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Abonnement réactif à la liste complète des sous-agents. */
export function useSubAgents(): SubAgentSnapshot[] {
  return useSyncExternalStore(subscribe, listSubAgents, listSubAgents);
}

/** Abonnement réactif aux sous-agents actifs (onglet Agents). */
export function useActiveSubAgents(): SubAgentSnapshot[] {
  return useSyncExternalStore(subscribe, listActiveSubAgents, listActiveSubAgents);
}
