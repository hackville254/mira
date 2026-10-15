import { useSyncExternalStore } from "react";

// ── Todo scratchpad (réactif) ──────────────────────────────────────────────────
//
// Liste de tâches par session, maintenue par l'agent tout au long d'un run
// multi-étapes. Contrairement à l'ancien `Map` inerte, ce store est observable :
// l'UI (TodoList épinglée au-dessus de l'input) s'y abonne et se rafraîchit en
// direct dès que l'agent appelle `todo_write`.
//
// En mémoire uniquement — pas de persistance disque (même contrat que Cline /
// jcode : la todo list est un artefact de raisonnement du tour courant).

export interface TodoItem {
  id:      string;                              // short unique id, e.g. "t1", "t2"
  content: string;                              // description of the task
  status:  "pending" | "in_progress" | "done" | "cancelled";
}

const EMPTY: TodoItem[] = [];

const store = new Map<string, TodoItem[]>();
const listeners = new Map<string, Set<() => void>>();

function emit(sessionId: string) {
  const subs = listeners.get(sessionId);
  if (subs) for (const cb of subs) cb();
}

export function getTodos(sessionId: string | null | undefined): TodoItem[] {
  if (!sessionId) return EMPTY;
  return store.get(sessionId) ?? EMPTY;
}

export function setTodos(sessionId: string, todos: TodoItem[]): void {
  store.set(sessionId, todos);
  emit(sessionId);
}

export function clearTodos(sessionId: string): void {
  if (!store.has(sessionId)) return;
  store.delete(sessionId);
  emit(sessionId);
}

/**
 * Clôture un tour : marque `done` tout item encore `pending`/`in_progress`.
 *
 * Filet de sécurité déterministe : le prompt demande au modèle de cocher chaque
 * tâche au fur et à mesure, mais un run peut se terminer avec des items restés
 * ouverts (le modèle a oublié la mise à jour finale). Comme le tour est terminé,
 * laisser des items « en cours » induirait l'utilisateur en erreur. On ne touche
 * jamais aux items `cancelled` (abandon volontaire de l'agent).
 */
export function finalizeTodos(sessionId: string): void {
  const todos = store.get(sessionId);
  if (!todos || todos.length === 0) return;
  let changed = false;
  const next = todos.map(t => {
    if (t.status === "pending" || t.status === "in_progress") {
      changed = true;
      return { ...t, status: "done" as const };
    }
    return t;
  });
  if (changed) setTodos(sessionId, next);
}

function subscribe(sessionId: string, cb: () => void): () => void {
  let subs = listeners.get(sessionId);
  if (!subs) { subs = new Set(); listeners.set(sessionId, subs); }
  subs.add(cb);
  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Abonnement réactif à la todo list d'une session. Renvoie la même référence
 * tant que la liste n'a pas changé (contrat `useSyncExternalStore`).
 */
export function useTodos(sessionId: string | null | undefined): TodoItem[] {
  return useSyncExternalStore(
    (cb) => (sessionId ? subscribe(sessionId, cb) : () => {}),
    () => getTodos(sessionId),
    () => EMPTY,
  );
}
