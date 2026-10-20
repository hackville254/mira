import { describe, it, expect } from "vitest";
import { sumDelta } from "../TurnReviewCard";
import type { TurnFileDelta } from "../../../lib/turnCheckpoint";

/** Fabrique un delta de fichier pour les tests. */
function delta(added: number, removed: number, created = false): TurnFileDelta {
  return { path: `/ws/f${added}_${removed}.ts`, added, removed, created };
}

describe("sumDelta", () => {
  it("somme les ajouts et suppressions de tous les fichiers", () => {
    const files = [delta(10, 2), delta(3, 5), delta(0, 7)];
    expect(sumDelta(files)).toEqual({ added: 13, removed: 14 });
  });

  it("renvoie zéro pour une liste vide", () => {
    expect(sumDelta([])).toEqual({ added: 0, removed: 0 });
  });

  it("gère un fichier créé (aucune suppression)", () => {
    expect(sumDelta([delta(38, 0, true)])).toEqual({ added: 38, removed: 0 });
  });
});
