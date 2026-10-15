import { describe, it, expect } from "vitest";
import {
  parseAllowedModels,
  buildModelChain,
  nextModelIndex,
  shouldFallback,
  shouldFallbackOnSlowTtft,
} from "../modelCascade";

describe("parseAllowedModels", () => {
  it("découpe une liste simple", () => {
    expect(parseAllowedModels("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trim chaque entrée et ignore les vides", () => {
    expect(parseAllowedModels(" a , , b ,")).toEqual(["a", "b"]);
  });

  it("déduplique en gardant l'ordre de priorité", () => {
    expect(parseAllowedModels("b,a,b,c,a")).toEqual(["b", "a", "c"]);
  });

  it("renvoie un tableau vide pour null / vague / chaîne vide", () => {
    expect(parseAllowedModels(null)).toEqual([]);
    expect(parseAllowedModels(undefined)).toEqual([]);
    expect(parseAllowedModels("")).toEqual([]);
    expect(parseAllowedModels("   ")).toEqual([]);
  });

  it("gère une seule entrée (pas de cascade)", () => {
    expect(parseAllowedModels("solo")).toEqual(["solo"]);
  });
});

describe("buildModelChain", () => {
  it("place toujours primary en tête", () => {
    expect(buildModelChain("main", ["fallback1", "fallback2"])).toEqual([
      "main",
      "fallback1",
      "fallback2",
    ]);
  });

  it("n'introduit pas de doublon si primary figure dans allowed", () => {
    expect(buildModelChain("main", ["main", "other"])).toEqual(["main", "other"]);
  });

  it("conserve primary même s'il est absent de la liste blanche", () => {
    expect(buildModelChain("custom", ["a", "b"])).toEqual(["custom", "a", "b"]);
  });

  it("se réduit à primary quand aucune liste autorisée n'est fournie", () => {
    expect(buildModelChain("main", [])).toEqual(["main"]);
  });

  it("trim primary et les entrées blanches", () => {
    expect(buildModelChain("  main  ", ["  a  ", "b"])).toEqual(["main", "a", "b"]);
  });

  it("ignore les entrées blanches vides", () => {
    expect(buildModelChain("main", ["", "  ", "a"])).toEqual(["main", "a"]);
  });
});

describe("nextModelIndex", () => {
  it("avance d'un cran tant qu'il reste des modèles", () => {
    expect(nextModelIndex(0, 3)).toBe(1);
    expect(nextModelIndex(1, 3)).toBe(2);
  });

  it("renvoie null quand la cascade est épuisée", () => {
    expect(nextModelIndex(2, 3)).toBeNull();
    expect(nextModelIndex(0, 1)).toBeNull();
    expect(nextModelIndex(0, 0)).toBeNull();
  });
});

describe("shouldFallback", () => {
  it("bascule sur un rate-limit sans contenu produit", () => {
    expect(shouldFallback("rate-limited", false)).toBe(true);
  });

  it("bascule sur un échec transient sans contenu produit", () => {
    expect(shouldFallback("transient", false)).toBe(true);
  });

  it("ne bascule jamais sur un échec permanent", () => {
    expect(shouldFallback("permanent", false)).toBe(false);
  });

  it("ne bascule jamais si du contenu a déjà été produit (anti-duplication)", () => {
    expect(shouldFallback("rate-limited", true)).toBe(false);
    expect(shouldFallback("transient", true)).toBe(false);
  });
});

describe("shouldFallbackOnSlowTtft", () => {
  it("bascule quand le TTFT dépasse le budget et qu'un autre modèle existe", () => {
    expect(shouldFallbackOnSlowTtft(9_000, 4_000, false, true)).toBe(true);
  });

  it("ne bascule pas si le TTFT reste sous le budget", () => {
    expect(shouldFallbackOnSlowTtft(1_200, 4_000, false, true)).toBe(false);
  });

  it("ne bascule pas si la garde est désactivée (budget ≤ 0)", () => {
    expect(shouldFallbackOnSlowTtft(9_000, 0, false, true)).toBe(false);
    expect(shouldFallbackOnSlowTtft(9_000, -1, false, true)).toBe(false);
  });

  it("ne bascule pas si du contenu a déjà été produit", () => {
    expect(shouldFallbackOnSlowTtft(9_000, 4_000, true, true)).toBe(false);
  });

  it("ne bascule pas si la cascade est épuisée (pas de modèle suivant)", () => {
    expect(shouldFallbackOnSlowTtft(9_000, 4_000, false, false)).toBe(false);
  });

  it("ne bascule pas quand aucun chunk n'est arrivé (cas flux muet, pas lent)", () => {
    expect(shouldFallbackOnSlowTtft(-1, 4_000, false, true)).toBe(false);
  });
});
