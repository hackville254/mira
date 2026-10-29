/**
 * Regroupement chronologique des tâches (sessions) pour le TaskRail, façon Trae.
 *
 * Ce module est **pur** : il ne touche ni au DOM ni au localStorage, ce qui le
 * rend trivialement testable. Il répond à deux questions :
 *   1. Dans quel « bucket » temporel tombe une tâche (Aujourd'hui, Hier, …) ?
 *   2. Ce bucket doit-il être replié par défaut (auto-fold des tâches terminées) ?
 */

/** Buckets ordonnés du plus récent au plus ancien (ordre d'affichage). */
export type TaskGroupId = "today" | "yesterday" | "last7days" | "last30days" | "older";

export interface TaskGroup {
  id: TaskGroupId;
  label: string;
  items: GroupableTask[];
}

/**
 * Forme minimale attendue par le groupement. On ne dépend pas de `DbSession`
 * pour garder le module testable sans la couche SQLite.
 */
export interface GroupableTask {
  id: string;
  updated_at: number;
  /** `false` tant que la tâche est en cours. Absent = considéré comme terminé. */
  completed?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const GROUP_LABELS: Record<TaskGroupId, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7days: "Last 7 days",
  last30days: "Last 30 days",
  older: "Older",
};

/** Ordre canonique d'affichage des groupes. */
const GROUP_ORDER: TaskGroupId[] = ["today", "yesterday", "last7days", "last30days", "older"];

/**
 * Calcule le début du jour local (`00:00:00.000`) pour un timestamp donné.
 * On raisonne en jour calendaire local : une tâche de 23 h n'est « aujourd'hui »
 * que le jour même, pas 24 h plus tard.
 */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Détermine le bucket temporel d'une tâche par rapport à `now`.
 * L'écart est mesuré en jours calendaires locaux, pas en millisecondes brutes.
 */
export function taskGroupFor(updatedAt: number, now: number = Date.now()): TaskGroupId {
  const today = startOfLocalDay(now);
  const taskDay = startOfLocalDay(updatedAt);
  const diffDays = Math.round((today - taskDay) / DAY_MS);

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "last7days";
  if (diffDays <= 30) return "last30days";
  return "older";
}

/**
 * Groupe des tâches par bucket temporel.
 *
 * - Les groupes vides sont omis (pas d'en-tête « Hier » sans élément).
 * - À l'intérieur d'un groupe, les tâches sont triées du plus récent au plus ancien.
 * - L'ordre des groupes est chronologique (voir `GROUP_ORDER`).
 */
export function groupTasks<T extends GroupableTask>(tasks: T[], now: number = Date.now()): TaskGroup[] {
  const buckets = new Map<TaskGroupId, T[]>();
  for (const task of tasks) {
    const id = taskGroupFor(task.updated_at, now);
    const list = buckets.get(id);
    if (list) list.push(task);
    else buckets.set(id, [task]);
  }

  const groups: TaskGroup[] = [];
  for (const id of GROUP_ORDER) {
    const items = buckets.get(id);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => b.updated_at - a.updated_at);
    groups.push({ id, label: GROUP_LABELS[id], items });
  }
  return groups;
}

/**
 * Un groupe doit-il être replié par défaut ?
 *
 * Règle alignée sur Trae : quand l'auto-fold est activé, **tout groupe dont
 * toutes les tâches sont terminées** est replié. Dès qu'une tâche est encore
 * active, le groupe reste ouvert (on ne veut jamais masquer le travail en cours).
 */
export function isGroupFolded(group: TaskGroup, autoFold: boolean): boolean {
  if (!autoFold) return false;
  return group.items.every(t => t.completed !== false);
}
