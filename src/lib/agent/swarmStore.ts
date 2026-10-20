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
// MULTITASKING : le registre est désormais CLÉ PAR SESSION DE CHAT. Plusieurs
// tâches peuvent tourner en parallèle dans le même projet ; chacune a son propre
// jeu de sous-agents. Sans cette clé, un second run purgerait l'état du premier
// (les sous-agents de la tâche A disparaîtraient du panneau Agents dès que la
// tâche B démarre un tour).
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

/** Clé de session utilisée quand l'appelant n'en fournit pas (rétrocompat). */
export const GLOBAL_SESSION_KEY = "__global__";

/** Registre : sessionId → (spawnId → snapshot). */
const registry = new Map<string, Map<string, SubAgentSnapshot>>();
const listeners = new Set<() => void>();

// Cache de snapshot : instance stable tant qu'aucune mutation n'a eu lieu.
// Une entrée par clé demandée (y compris la clé globale agrégée).
const cache = new Map<string, SubAgentSnapshot[]>();

// Cache séparé pour la vue « actifs » : `listActiveSubAgents` filtre la liste,
// ce qui produirait un NOUVEAU tableau à chaque appel → `useSyncExternalStore`
// boucle à l'infini. On met donc le résultat filtré en cache, invalidé à chaque
// `emit` comme le cache principal.
const activeCache = new Map<string, SubAgentSnapshot[]>();
const ACTIVE_CACHE_PREFIX = "active::";

function emit(): void {
  cache.clear();
  activeCache.clear();
  for (const cb of listeners) cb();
}

function bucket(sessionKey: string): Map<string, SubAgentSnapshot> {
  let m = registry.get(sessionKey);
  if (!m) { m = new Map(); registry.set(sessionKey, m); }
  return m;
}

export function startSubAgent(sessionKey: string, meta: {
  spawnId: string; role: string; task: string; toolCallId?: string;
}): void {
  bucket(sessionKey).set(meta.spawnId, {
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

export function stepSubAgent(sessionKey: string, spawnId: string, iteration: number): void {
  const entry = bucket(sessionKey).get(spawnId);
  if (!entry) return;
  bucket(sessionKey).set(spawnId, { ...entry, iterations: iteration });
  emit();
}

export function endSubAgent(
  sessionKey: string,
  spawnId: string,
  result: { status: SubAgentStatus; report: string; iterations: number; inputTokens: number; outputTokens: number },
): void {
  const entry = bucket(sessionKey).get(spawnId);
  if (!entry) return;
  bucket(sessionKey).set(spawnId, {
    ...entry,
    status: result.status,
    report: result.report,
    iterations: result.iterations,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  emit();
}

/**
 * Instantané complet (du plus récent au plus ancien).
 * - `sessionKey` fourni → sous-agents de CETTE session uniquement.
 * - `sessionKey` omis → agrégat de TOUTES les sessions (vue globale multi-tâches).
 */
export function listSubAgents(sessionKey?: string): SubAgentSnapshot[] {
  const key = sessionKey ?? GLOBAL_SESSION_KEY;
  const hit = cache.get(key);
  if (hit) return hit;

  let list: SubAgentSnapshot[];
  if (sessionKey) {
    list = Array.from(bucket(sessionKey).values());
  } else {
    list = [];
    for (const m of registry.values()) list.push(...m.values());
  }
  list.sort((a, b) => b.startedAt - a.startedAt);
  cache.set(key, list);
  return list;
}

/** Seuls les sous-agents encore en cours (status non renseigné). */
export function listActiveSubAgents(sessionKey?: string): SubAgentSnapshot[] {
  const key = ACTIVE_CACHE_PREFIX + (sessionKey ?? GLOBAL_SESSION_KEY);
  const hit = activeCache.get(key);
  if (hit) return hit;
  const list = listSubAgents(sessionKey).filter(s => s.status === undefined);
  activeCache.set(key, list);
  return list;
}

/** Purge les sous-agents d'UNE session à la fin d'un tour parent (les cartes du
 *  chat restent, elles, persistées dans les parts du message). Sans clé : purge
 *  globale (utile aux tests et à la remise à zéro complète). */
export function clearSubAgents(sessionKey?: string): void {
  if (sessionKey === undefined) {
    if (registry.size === 0) return;
    registry.clear();
    emit();
    return;
  }
  const m = registry.get(sessionKey);
  if (!m || m.size === 0) return;
  registry.delete(sessionKey);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Abonnement réactif à la liste des sous-agents. Sans clé : vue globale. */
export function useSubAgents(sessionKey?: string): SubAgentSnapshot[] {
  return useSyncExternalStore(
    subscribe,
    () => listSubAgents(sessionKey),
    () => listSubAgents(sessionKey),
  );
}

/** Abonnement réactif aux sous-agents actifs (onglet Agents). */
export function useActiveSubAgents(sessionKey?: string): SubAgentSnapshot[] {
  return useSyncExternalStore(
    subscribe,
    () => listActiveSubAgents(sessionKey),
    () => listActiveSubAgents(sessionKey),
  );
}
