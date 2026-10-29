import { describe, it, expect } from "vitest";
import {
  collectTurnIdsFrom,
  keepFrom,
  revertableIndexesAfterKeep,
  hydrateTurns,
  keptReviewsBefore,
} from "../reviewState";
import type { TurnFileDelta } from "../../turnCheckpoint";

/** Construit la map de suivi des tours pour les tests. */
function mapOf(entries: Record<number, string[]>): Map<number, string[]> {
  return new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
}

function delta(added: number, removed: number): TurnFileDelta {
  return { path: `/ws/f${added}.ts`, added, removed, created: false };
}

describe("collectTurnIdsFrom", () => {
  it("rassemble les tours depuis l'index inclus", () => {
    const m = mapOf({ 0: ["a"], 2: ["b", "c"], 5: ["d"] });
    expect(collectTurnIdsFrom(m, 2)).toEqual(["b", "c", "d"]);
  });

  it("renvoie un tableau vide quand aucun tour ne suit l'index", () => {
    const m = mapOf({ 0: ["a"] });
    expect(collectTurnIdsFrom(m, 3)).toEqual([]);
  });

  it("inclut les tours de plusieurs messages (un run couvre plusieurs envois)", () => {
    const m = mapOf({ 1: ["x"], 4: ["y"] });
    expect(collectTurnIdsFrom(m, 1)).toEqual(["x", "y"]);
  });
});

describe("keepFrom (fin des tours fantômes)", () => {
  it("retire TOUS les tours depuis l'index, pas seulement l'index exact", () => {
    const m = mapOf({ 0: ["a"], 2: ["b"], 4: ["c"] });
    const next = keepFrom(m, 2);
    expect([...next.keys()]).toEqual([0]);
    expect(next.get(0)).toEqual(["a"]);
  });

  it("ne mute pas la map d'origine (immuabilité)", () => {
    const m = mapOf({ 0: ["a"], 2: ["b"] });
    keepFrom(m, 2);
    expect(m.has(2)).toBe(true);
  });

  it("conserve strictement les index antérieurs", () => {
    const m = mapOf({ 1: ["a"], 3: ["b"], 7: ["c"] });
    const next = keepFrom(m, 3);
    expect([...next.keys()]).toEqual([1]);
  });
});

describe("revertableIndexesAfterKeep", () => {
  it("ne garde que les index strictement antérieurs", () => {
    expect(revertableIndexesAfterKeep([0, 2, 5], 2)).toEqual([0]);
  });

  it("renvoie un tableau vide quand tout est acté", () => {
    expect(revertableIndexesAfterKeep([3, 4], 3)).toEqual([]);
  });
});

describe("hydrateTurns (reconstruction depuis le disque)", () => {
  it("rattache tous les tours survivants au dernier message utilisateur", () => {
    const { byUser, revertable } = hydrateTurns(["t1", "t2"], 4);
    expect(byUser.get(4)).toEqual(["t1", "t2"]);
    expect(revertable).toEqual([4]);
  });

  it("sans tour sur disque : suivi vide, rien d'annulable", () => {
    const { byUser, revertable } = hydrateTurns([], 4);
    expect(byUser.size).toBe(0);
    expect(revertable).toEqual([]);
  });

  it("sans message utilisateur : suivi vide même si des tours existent", () => {
    const { byUser, revertable } = hydrateTurns(["t1"], -1);
    expect(byUser.size).toBe(0);
    expect(revertable).toEqual([]);
  });

  it("ne partage pas la référence du tableau de tours", () => {
    const ids = ["t1"];
    const { byUser } = hydrateTurns(ids, 0);
    ids.push("t2");
    expect(byUser.get(0)).toEqual(["t1"]);
  });
});

describe("keptReviewsBefore", () => {
  it("ne conserve que les marqueurs des messages antérieurs", () => {
    const kept = { 0: [delta(1, 0)], 3: [delta(2, 1)], 6: [] };
    const next = keptReviewsBefore(kept, 3);
    expect(Object.keys(next)).toEqual(["0"]);
  });

  it("renvoie un objet vide quand tout est annulé", () => {
    expect(keptReviewsBefore({ 2: [] }, 2)).toEqual({});
  });
});
