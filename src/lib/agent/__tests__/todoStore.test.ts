import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Clôture de tour de la todo list ───────────────────────────────────────────
//
// On mocke le magasin de réglages Tauri : en environnement de test il n'y a ni
// `window` ni backend Tauri, et la persistance est un effet de bord best-effort
// (le contrat testé ici est le comportement EN MÉMOIRE du store).

const persisted: Record<string, unknown> = {};
vi.mock("../../settings", () => ({
  getSetting: vi.fn(async (k: string) => persisted[k] ?? {}),
  setSetting: vi.fn(async (k: string, v: unknown) => { persisted[k] = v; }),
}));

import { getTodos, setTodos, finalizeTodos, clearTodos, hydrateAllTodos } from "../todoStore";

describe("finalizeTodos", () => {
  beforeEach(() => clearTodos("s1"));

  it("marque done les items pending et in_progress", () => {
    setTodos("s1", [
      { id: "t1", content: "a", status: "done" },
      { id: "t2", content: "b", status: "in_progress" },
      { id: "t3", content: "c", status: "pending" },
    ]);
    finalizeTodos("s1");
    expect(getTodos("s1").map(t => t.status)).toEqual(["done", "done", "done"]);
  });

  it("ne touche pas aux items cancelled", () => {
    setTodos("s1", [
      { id: "t1", content: "a", status: "cancelled" },
      { id: "t2", content: "b", status: "pending" },
    ]);
    finalizeTodos("s1");
    expect(getTodos("s1").map(t => t.status)).toEqual(["cancelled", "done"]);
  });

  it("ne fait rien si la session n'a pas de todo", () => {
    expect(() => finalizeTodos("inconnue")).not.toThrow();
    expect(getTodos("inconnue")).toEqual([]);
  });
});

describe("persistance des todo lists (suit la conversation)", () => {
  beforeEach(() => {
    for (const k of Object.keys(persisted)) delete persisted[k];
    clearTodos("s-persist");
  });

  it("écrit la liste dans le store quand elle change", () => {
    setTodos("s-persist", [{ id: "t1", content: "a", status: "pending" }]);
    const saved = persisted["todo.list"] as Record<string, unknown>;
    expect(saved["s-persist"]).toEqual([{ id: "t1", content: "a", status: "pending" }]);
  });

  it("retire la liste du store quand on l'efface", () => {
    setTodos("s-persist", [{ id: "t1", content: "a", status: "pending" }]);
    clearTodos("s-persist");
    const saved = persisted["todo.list"] as Record<string, unknown>;
    expect(saved["s-persist"]).toBeUndefined();
  });

  it("réhydrate une session absente de la mémoire depuis le disque", async () => {
    // Simule un reload : la mémoire est vide, mais le disque contient la liste.
    clearTodos("s-persist");
    persisted["todo.list"] = {
      "s-persist": [{ id: "t9", content: "repris", status: "in_progress" }],
    };
    await hydrateAllTodos();
    expect(getTodos("s-persist")).toEqual([{ id: "t9", content: "repris", status: "in_progress" }]);
  });

  it("n'écrase jamais une session déjà en mémoire (run en cours)", async () => {
    setTodos("s-persist", [{ id: "live", content: "en cours", status: "in_progress" }]);
    persisted["todo.list"] = {
      "s-persist": [{ id: "old", content: "périmé", status: "done" }],
    };
    await hydrateAllTodos();
    expect(getTodos("s-persist")).toEqual([{ id: "live", content: "en cours", status: "in_progress" }]);
  });
});
