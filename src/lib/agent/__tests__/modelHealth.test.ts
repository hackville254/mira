import { describe, it, expect } from "vitest";
import {
  ModelHealth,
  rankModelChain,
  RATE_LIMIT_COOLDOWN_MS,
  TTFT_SAMPLES,
  UNKNOWN_TTFT_MS,
} from "../modelHealth";

describe("ModelHealth", () => {
  it("ignore un id vide ou un TTFT non plausible", () => {
    const h = new ModelHealth();
    h.noteTtft("", 100);
    h.noteTtft("a", 0);
    h.noteTtft("a", -5);
    h.noteTtft("a", Number.NaN);
    expect(h.ttftScore("a")).toBe(UNKNOWN_TTFT_MS);
  });

  it("moyenne glissante bornée à TTFT_SAMPLES", () => {
    const h = new ModelHealth();
    for (let i = 1; i <= TTFT_SAMPLES + 3; i++) h.noteTtft("a", i * 100);
    // Seules les 5 dernières mesures sont retenues : 400..800 → moyenne 600.
    expect(h.ttftScore("a")).toBe(600);
  });

  it("met un modèle en cooldown après un 429, puis expire", () => {
    const h = new ModelHealth();
    const now = 1_000_000;
    h.noteRateLimit("a", now);
    expect(h.isCoolingDown("a", now + 1)).toBe(true);
    expect(h.isCoolingDown("a", now + RATE_LIMIT_COOLDOWN_MS)).toBe(false);
  });

  it("prolonge le cooldown sans le raccourcir", () => {
    const h = new ModelHealth();
    const now = 1_000_000;
    h.noteRateLimit("a", now, 60_000);          // jusqu'à now+60s
    h.noteRateLimit("a", now + 30_000, 10_000); // now+40s — plus court : ignoré
    expect(h.isCoolingDown("a", now + 50_000)).toBe(true);
  });

  it("un score TTFT inconnu est neutre", () => {
    const h = new ModelHealth();
    expect(h.ttftScore("jamais-vu")).toBe(UNKNOWN_TTFT_MS);
  });
});

describe("rankModelChain", () => {
  it("chaîne vide ou singleton inchangée", () => {
    const h = new ModelHealth();
    expect(rankModelChain([], h)).toEqual([]);
    expect(rankModelChain(["a"], h)).toEqual(["a"]);
  });

  it("garde le primary en tête s'il est sain", () => {
    const h = new ModelHealth();
    expect(rankModelChain(["primary", "b", "c"], h)).toEqual(["primary", "b", "c"]);
  });

  it("relègue le primary en cooldown derrière les modèles sains", () => {
    const h = new ModelHealth();
    h.noteRateLimit("primary", 0, 60_000);
    const ranked = rankModelChain(["primary", "b", "c"], h, 1_000);
    expect(ranked[0]).not.toBe("primary");
    expect(ranked[ranked.length - 1]).toBe("primary");
  });

  it("trie les modèles sains du plus réactif au plus lent", () => {
    const h = new ModelHealth();
    h.noteTtft("lent", 3_000);
    h.noteTtft("rapide", 500);
    h.noteTtft("primary", 1_000);
    const ranked = rankModelChain(["primary", "lent", "rapide"], h);
    // primary sain → tête ; puis rapide (500) avant lent (3000).
    expect(ranked).toEqual(["primary", "rapide", "lent"]);
  });

  it("est stable à score égal (conserve l'ordre déclaré)", () => {
    const h = new ModelHealth();
    expect(rankModelChain(["a", "b", "c"], h)).toEqual(["a", "b", "c"]);
  });

  it("ne mute pas la chaîne d'entrée", () => {
    const h = new ModelHealth();
    const chain = ["primary", "b", "c"];
    h.noteRateLimit("primary", 0, 60_000);
    rankModelChain(chain, h, 1_000);
    expect(chain).toEqual(["primary", "b", "c"]);
  });
});

describe("contrat d'intégration run↔routage", () => {
  it("un 429 enregistré dépriorise le modèle au tour suivant", () => {
    const now = 10_000;
    const h = new ModelHealth();
    // Tour 1 : le modèle UI est saturé.
    h.noteRateLimit("ui-model", now);
    // Tour 2 : la chaîne statique le mettait en tête — le routage le rétrograde.
    const ranked = rankModelChain(["ui-model", "fallback-rapide"], h, now + 1_000);
    expect(ranked[0]).toBe("fallback-rapide");
  });
});
