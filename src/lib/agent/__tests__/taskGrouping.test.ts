import { describe, it, expect } from "vitest";
import {
  taskGroupFor,
  groupTasks,
  isGroupFolded,
  type GroupableTask,
} from "../taskGrouping";

// Instant de référence : 2026-06-15 14:00 heure locale.
const NOW = new Date(2026, 5, 15, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function ts(daysAgo: number, hour = 12): number {
  const d = new Date(2026, 5, 15, hour, 0, 0);
  return d.getTime() - daysAgo * DAY;
}

describe("taskGroupFor", () => {
  it("classe une tâche du jour même dans today", () => {
    expect(taskGroupFor(ts(0, 9), NOW)).toBe("today");
    expect(taskGroupFor(ts(0, 23), NOW)).toBe("today");
  });

  it("classe la veille en jour calendaire dans yesterday", () => {
    expect(taskGroupFor(ts(1, 23), NOW)).toBe("yesterday");
  });

  it("classe 2 à 7 jours dans last7days", () => {
    expect(taskGroupFor(ts(2), NOW)).toBe("last7days");
    expect(taskGroupFor(ts(7), NOW)).toBe("last7days");
  });

  it("classe 8 à 30 jours dans last30days", () => {
    expect(taskGroupFor(ts(8), NOW)).toBe("last30days");
    expect(taskGroupFor(ts(30), NOW)).toBe("last30days");
  });

  it("classe au-delà de 30 jours dans older", () => {
    expect(taskGroupFor(ts(31), NOW)).toBe("older");
    expect(taskGroupFor(ts(400), NOW)).toBe("older");
  });

  it("traite un timestamp futur comme today", () => {
    expect(taskGroupFor(NOW + DAY, NOW)).toBe("today");
  });
});

describe("groupTasks", () => {
  const tasks: GroupableTask[] = [
    { id: "a", updated_at: ts(0, 10) },
    { id: "b", updated_at: ts(0, 13) },
    { id: "c", updated_at: ts(1) },
    { id: "d", updated_at: ts(3) },
    { id: "e", updated_at: ts(20) },
    { id: "f", updated_at: ts(90) },
  ];

  it("retourne les groupes dans l'ordre chronologique décroissant", () => {
    const groups = groupTasks(tasks, NOW);
    expect(groups.map(g => g.id)).toEqual([
      "today",
      "yesterday",
      "last7days",
      "last30days",
      "older",
    ]);
  });

  it("trie les éléments d'un groupe du plus récent au plus ancien", () => {
    const groups = groupTasks(tasks, NOW);
    const today = groups.find(g => g.id === "today")!;
    expect(today.items.map(t => t.id)).toEqual(["b", "a"]);
  });

  it("omet les groupes vides", () => {
    const groups = groupTasks([{ id: "x", updated_at: ts(0) }], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("today");
  });

  it("retourne un tableau vide pour une liste vide", () => {
    expect(groupTasks([], NOW)).toEqual([]);
  });

  it("expose un label lisible pour chaque groupe", () => {
    const groups = groupTasks(tasks, NOW);
    expect(groups.map(g => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "Last 30 days",
      "Older",
    ]);
  });
});

describe("isGroupFolded", () => {
  const doneGroup = groupTasks([{ id: "a", updated_at: ts(0), completed: true }], NOW)[0];

  it("ne replie jamais quand l'auto-fold est désactivé", () => {
    expect(isGroupFolded(doneGroup, false)).toBe(false);
  });

  it("replie un groupe entièrement terminé quand l'auto-fold est activé", () => {
    expect(isGroupFolded(doneGroup, true)).toBe(true);
  });

  it("considère `completed` absent comme terminé", () => {
    const g = groupTasks([{ id: "a", updated_at: ts(0) }], NOW)[0];
    expect(isGroupFolded(g, true)).toBe(true);
  });

  it("ne replie pas un groupe contenant une tâche active", () => {
    const g = groupTasks(
      [
        { id: "a", updated_at: ts(0), completed: true },
        { id: "b", updated_at: ts(0), completed: false },
      ],
      NOW,
    )[0];
    expect(isGroupFolded(g, true)).toBe(false);
  });
});
