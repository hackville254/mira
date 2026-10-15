import { describe, it, expect, beforeEach } from "vitest";
import { getTodos, setTodos, finalizeTodos, clearTodos } from "../todoStore";

// ── Clôture de tour de la todo list ───────────────────────────────────────────

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
