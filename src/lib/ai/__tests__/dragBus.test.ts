import { describe, it, expect, beforeEach } from "vitest";
import {
  getPathDrag,
  subscribePathDrag,
  beginPathDrag,
  endPathDrag,
} from "../dragBus";

describe("dragBus — drag de chemins vers l'input du chat", () => {
  beforeEach(() => {
    endPathDrag(); // état propre entre les tests (module singleton)
  });

  it("démarre sans payload", () => {
    expect(getPathDrag()).toBeNull();
  });

  it("publie les chemins au début d'un drag", () => {
    beginPathDrag(["/a/b", "/a/c"]);
    expect(getPathDrag()).toEqual({ paths: ["/a/b", "/a/c"] });
  });

  it("un drag vide (aucun chemin) termine le drag au lieu de publier", () => {
    beginPathDrag(["/a"]);
    beginPathDrag([]);
    expect(getPathDrag()).toBeNull();
  });

  it("notifie les abonnés des transitions", () => {
    const seen: Array<string[] | null> = [];
    const unsub = subscribePathDrag((p) => seen.push(p ? p.paths : null));
    beginPathDrag(["/x"]);
    endPathDrag();
    expect(seen).toEqual([null, ["/x"], null]);
    unsub();
  });

  it("livre l'état courant à un abonné monté pendant un drag", () => {
    beginPathDrag(["/y"]);
    const seen: Array<string[] | null> = [];
    const unsub = subscribePathDrag((p) => seen.push(p ? p.paths : null));
    expect(seen).toEqual([["/y"]]);
    unsub();
  });

  it("désabonne proprement (plus de notification après unsub)", () => {
    const seen: Array<string[] | null> = [];
    const unsub = subscribePathDrag((p) => seen.push(p ? p.paths : null));
    unsub();
    beginPathDrag(["/z"]);
    // 1 seule entrée : l'état initial (null) livré à l'abonnement.
    expect(seen).toEqual([null]);
  });

  it("endPathDrag est idempotent", () => {
    endPathDrag();
    expect(getPathDrag()).toBeNull();
  });
});
