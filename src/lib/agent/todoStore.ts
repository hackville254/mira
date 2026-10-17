import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../settings";

// ── Todo scratchpad (réactif + persistant) ─────────────────────────────────────
//
// Liste de tâches par session, maintenue par l'agent tout au long d'un run
// multi-étapes. Contrairement à l'ancien `Map` inerte, ce store est observable :
// l'UI (TodoList épinglée au-dessus de l'input) s'y abonne et se rafraîchit en
// direct dès que l'agent appelle `todo_write`.
//
// PERSISTANCE (parité Trae) : la todo list suit la CONVERSATION. Elle survit au
// reload et à la bascule IDE↔AI, car c'est un artefact de la tâche, pas un état
// éphémère de layout. On la persiste donc dans le Tauri store, groupée par
// session sous la clé typée `todo.list.
//
// Le magasin disque est ASYNCHRONE, mais l'API publique (`setTodos` / `getTodos`)
// reste SYNCHRONE pour ne pas perturber la boucle d'événements de l'agent : les
// écritures sont « fire-and-forget » (best-effort, jamais bloquantes) et
// `hydrateTodos` réalimente le store au montage / à la sélection d'une conv.

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

/** Écriture best-effort de la map complète sur disque (jamais bloquante). */
function persistStore(): void {
  const snapshot = Object.fromEntries(store.entries());
  void setSetting("todo.list", snapshot).catch(err =>
    console.error("[todoStore] persist failed:", err),
  );
}

export function getTodos(sessionId: string | null | undefined): TodoItem[] {
  if (!sessionId) return EMPTY;
  return store.get(sessionId) ?? EMPTY;
}

export function setTodos(sessionId: string, todos: TodoItem[]): void {
  store.set(sessionId, todos);
  emit(sessionId);
  persistStore();
}

export function clearTodos(sessionId: string): void {
  if (!store.has(sessionId)) return;
  store.delete(sessionId);
  emit(sessionId);
  persistStore();
}

/**
 * Réhydrate l'ensemble des todo lists depuis le disque (idempotent).
 *
 * Appelé une fois au démarrage : le disque est la source de vérité pour les
 * conversations reprises, la mémoire pour celles en cours. Une session déjà
 * présente en mémoire (run en cours) n'est JAMAIS écrasée par le disque.
 */
export async function hydrateAllTodos(): Promise<void> {
  try {
    const persisted = await getSetting("todo.list");
    if (!persisted || typeof persisted !== "object") return;
    for (const [sessionId, todos] of Object.entries(persisted)) {
      if (store.has(sessionId)) continue;       // run en cours : ne pas écraser
      if (!Array.isArray(todos) || todos.length === 0) continue;
      store.set(sessionId, todos as TodoItem[]);
      emit(sessionId);
    }
  } catch (err) {
    console.error("[todoStore] hydrate failed:", err);
  }
}

/**
 * Efface du disque les todo lists de sessions qui n'existent plus.
 *
 * Évite que le store grossisse sans borne au fil des suppressions de
 * conversations. `keep` = ids de sessions encore vivants.
 */
export async function pruneTodos(keep: Set<string>): Promise<void> {
  let changed = false;
  for (const sessionId of [...store.keys()]) {
    if (keep.has(sessionId)) continue;
    store.delete(sessionId);
    changed = true;
  }
  if (changed) persistStore();
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
