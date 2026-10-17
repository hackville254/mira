import { useSyncExternalStore } from "react";

// ── Registre des runs d'agent, par session (multitasking, parité Trae) ─────────
//
// PROBLÈME RÉSOLU : avant ce module, l'état d'un run vivait ENTIÈREMENT dans les
// refs locales d'`AiPanel` (un seul run possible) et `handleSessionSelect`
// interrompait systématiquement le stream courant. Basculer de tâche = tuer le
// travail en cours. Impossible de faire tourner deux tâches en parallèle.
//
// Ici, l'état « qui tourne » est extrait dans un registre MODULE-LEVEL clé par
// `sessionId`. Conséquences :
//   - un run continue de produire ses événements même si l'UI affiche une autre
//     tâche (le composant ne fait que s'abonner / se désabonner à l'affichage) ;
//   - plusieurs sessions peuvent être simultanément « running » ;
//   - le rail de tâches lit un STATUT RÉEL par session (plus de « Completed »
//     codé en dur), ce qui rend le multitâche lisible.
//
// Ce module reste volontairement PUR côté données : il ne connaît ni React (hors
// le hook d'abonnement) ni le moteur Cline. Il ne fait que tenir un état
// observable, ce qui le rend testable sans DOM ni sidecar.

/** Statut d'exécution live d'une tâche (session). */
export type TaskRunStatus =
  | "idle"       // rien n'a encore tourné dans cette session
  | "running"    // l'agent génère (root) — l'utilisateur peut basculer sans couper
  | "waiting"    // l'agent attend un outil / une approbation — toujours vivant
  | "completed"  // dernier tour terminé proprement
  | "interrupted"; // dernier tour arrêté (stop utilisateur, erreur, bascule projet)

export interface TaskRunSnapshot {
  sessionId: string;
  status: TaskRunStatus;
  /** Outil en cours (renseigné en `waiting`), pour un libellé informatif. */
  waitingTool?: string;
  /** Horodatage de la dernière transition (ms epoch). */
  updatedAt: number;
}

/** État d'un run vivant, détenu par le registre (jamais par le composant). */
interface RunEntry {
  snapshot: TaskRunSnapshot;
  /** Compteur monotone d'insertion : départage deux mutations de même milliseconde. */
  seq: number;
  /** Coupe le run : abort SDK + détache l'écouteur d'événements. */
  abort?: () => void;
}

const registry = new Map<string, RunEntry>();
const listeners = new Set<() => void>();
let seqCounter = 0;

// Snapshot stable tant qu'aucune mutation n'a eu lieu (contrat useSyncExternalStore).
let cachedAll: TaskRunSnapshot[] = [];
let cacheValid = true;

function emit(): void {
  cacheValid = false;
  for (const cb of listeners) cb();
}

function ensure(sessionId: string): RunEntry {
  let entry = registry.get(sessionId);
  if (!entry) {
    entry = { snapshot: { sessionId, status: "idle", updatedAt: Date.now() }, seq: ++seqCounter };
    registry.set(sessionId, entry);
  }
  return entry;
}

/** Transition de statut (n'émet que si quelque chose change réellement). */
export function setTaskStatus(
  sessionId: string,
  status: TaskRunStatus,
  waitingTool?: string,
): void {
  const entry = ensure(sessionId);
  const prev = entry.snapshot;
  if (prev.status === status && prev.waitingTool === waitingTool) return;
  entry.snapshot = { sessionId, status, waitingTool, updatedAt: Date.now() };
  entry.seq = ++seqCounter;
  emit();
}

/** Statut courant d'une session (jamais `undefined` : `idle` par défaut). */
export function getTaskStatus(sessionId: string | null | undefined): TaskRunStatus {
  if (!sessionId) return "idle";
  return registry.get(sessionId)?.snapshot.status ?? "idle";
}

/** Instantané complet d'une session (ou un `idle` synthétique). */
export function getTaskSnapshot(sessionId: string): TaskRunSnapshot {
  return registry.get(sessionId)?.snapshot
    ?? { sessionId, status: "idle", updatedAt: 0 };
}

export interface RegisterRunHandle {
  /** Enregistre le handle d'abort du run courant (appelé par AiPanel). */
  setAbort: (abort: (() => void) | null) => void;
  /** Marque la tâche comme terminée proprement et libère le handle. */
  complete: () => void;
  /** Marque la tâche comme interrompue et libère le handle. */
  interrupt: () => void;
}

/**
 * Ouvre (ou remplace) le run d'une session. Renvoie un handle d'enregistrement
 * que `AiPanel` tient à jour au fil du run. Le run devient « running » : il
 * continue de vivre même si l'UI affiche une autre tâche.
 */
export function beginTaskRun(sessionId: string): RegisterRunHandle {
  const entry = ensure(sessionId);
  setTaskStatus(sessionId, "running");
  return {
    setAbort: (abort) => { entry.abort = abort ?? undefined; },
    complete: () => {
      entry.abort = undefined;
      setTaskStatus(sessionId, "completed");
    },
    interrupt: () => {
      entry.abort = undefined;
      setTaskStatus(sessionId, "interrupted");
    },
  };
}

/** L'agent attend un outil : la tâche reste vivante (donc basculable sans perte). */
export function markTaskWaiting(sessionId: string, tool?: string): void {
  setTaskStatus(sessionId, "waiting", tool);
}

/** L'agent reprend après un outil : retour en « running ». */
export function markTaskRunning(sessionId: string): void {
  setTaskStatus(sessionId, "running");
}

/**
 * Interrompt le run d'une session : coupe le moteur (abort) puis marque
 * `interrupted`. Utilisé par « Stop » et par la fermeture / suppression d'une
 * tâche. Ne fait rien si aucun run n'est enregistré.
 */
export function abortTaskRun(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.abort?.();
  entry.abort = undefined;
  setTaskStatus(sessionId, "interrupted");
}

/** Un run est-il vivant (running ou waiting) pour cette session ? */
export function isTaskActive(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const s = registry.get(sessionId)?.snapshot.status;
  return s === "running" || s === "waiting";
}

/** Liste des sessions en cours (running | waiting), du plus récent au plus ancien. */
export function listActiveTasks(): TaskRunSnapshot[] {
  return listTaskSnapshots().filter(
    t => t.status === "running" || t.status === "waiting",
  );
}

/** Instantané complet, trié du plus récent au plus ancien (stable tant que rien ne change). */
export function listTaskSnapshots(): TaskRunSnapshot[] {
  if (!cacheValid) {
    cachedAll = Array.from(registry.values())
      // Tri par `seq` décroissant : départage deux mutations de même date (ms).
      .sort((a, b) => b.seq - a.seq)
      .map(e => e.snapshot);
    cacheValid = true;
  }
  return cachedAll;
}

/** Purge l'entrée d'une session supprimée (abort au passage si un run vivait). */
export function forgetTask(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.abort?.();
  registry.delete(sessionId);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Abonnement réactif au statut d'une session donnée. */
export function useTaskStatus(sessionId: string | null | undefined): TaskRunStatus {
  return useSyncExternalStore(
    subscribe,
    () => getTaskStatus(sessionId),
    () => "idle" as TaskRunStatus,
  );
}

/** Abonnement réactif à la liste complète des instantanés de tâches. */
export function useTaskSnapshots(): TaskRunSnapshot[] {
  return useSyncExternalStore(subscribe, listTaskSnapshots, listTaskSnapshots);
}

/** Abonnement réactif aux tâches actives (running | waiting). */
export function useActiveTasks(): TaskRunSnapshot[] {
  return useSyncExternalStore(subscribe, listActiveTasks, listActiveTasks);
}
