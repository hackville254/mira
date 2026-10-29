/**
 * Étape 4 — Tests de classification de la terminaison d'un run.
 *
 * Vérifie qu'un incident d'INFRASTRUCTURE (erreur fournisseur, réponse
 * tronquée, aucun tour) n'est JAMAIS confondu avec un échec de programmation,
 * et qu'une fin normale n'est jamais sur-classée.
 */

import { describe, it, expect } from "vitest";

import {
  classifyTermination,
  isInconclusive,
  isHarnessCapped,
  looksTransient,
} from "../../../../bench/coding/headless/termination";

describe("classifyTermination — motifs du moteur prioritaires", () => {
  it("`completed` → fin normale", () => {
    expect(classifyTermination({ stopReason: "completed", turns: 5 })).toBe("completed");
  });

  it("`max_iterations` → budget épuisé (harnais, pas un incident)", () => {
    const c = classifyTermination({ stopReason: "max_iterations", turns: 40 });
    expect(c).toBe("max_iterations");
    expect(isHarnessCapped(c)).toBe(true);
    expect(isInconclusive(c)).toBe(false);
  });

  it("`aborted` → arrêt demandé, compté mais signalé", () => {
    expect(classifyTermination({ stopReason: "aborted", turns: 3 })).toBe("aborted");
  });

  it("`mistake_limit` → coupure moteur, pas un incident fournisseur", () => {
    expect(classifyTermination({ stopReason: "mistake_limit", turns: 12 })).toBe("mistake_limit");
  });
});

describe("classifyTermination — erreurs transitoires vs troncature", () => {
  it("erreur réseau → provider-error (non concluant)", () => {
    const c = classifyTermination({ error: "ECONNRESET: socket hang up", turns: 4 });
    expect(c).toBe("provider-error");
    expect(isInconclusive(c)).toBe(true);
  });

  it("quota/429 → provider-error", () => {
    expect(classifyTermination({ error: "429 Too Many Requests", turns: 2 })).toBe("provider-error");
  });

  it("limite de sortie → truncated", () => {
    const c = classifyTermination({ error: "provider: max_tokens reached", turns: 6 });
    expect(c).toBe("truncated");
    expect(isInconclusive(c)).toBe(true);
  });

  it("fin de streaming anormale → truncated", () => {
    expect(classifyTermination({ error: "stream ended unexpectedly (truncated)", turns: 3 })).toBe("truncated");
  });

  it("drapeau recoverable → provider-error même sans motif textuel", () => {
    expect(classifyTermination({ error: "erreur agent", recoverable: true, turns: 2 })).toBe("provider-error");
  });

  it("aucun tour produit → provider-error (le modèle n'a pas été évalué)", () => {
    expect(classifyTermination({ turns: 0 })).toBe("provider-error");
  });

  it("erreur d'agent réelle (tours produits, non transitoire) → failed", () => {
    const c = classifyTermination({ error: "tool_output_validation_failed", turns: 9 });
    expect(c).toBe("failed");
    expect(isInconclusive(c)).toBe(false);
  });
});

describe("classifyTermination — notices du SDK", () => {
  it("notice de type stop avec reason de troncature → truncated", () => {
    const c = classifyTermination({ noticeReason: "max_tokens reached", turns: 5 });
    expect(c).toBe("truncated");
  });

  it("notice de troncature prime sur une erreur générique", () => {
    const c = classifyTermination({ noticeReason: "max_tokens reached", error: "erreur agent", turns: 5 });
    expect(c).toBe("truncated");
  });

  it("notice recovery suivie d'une erreur fournisseur → provider-error", () => {
    expect(classifyTermination({ noticeMessage: "récupération après erreur réseau", error: "fetch failed", turns: 3 })).toBe("provider-error");
  });

  it("notice recovery SANS erreur terminale → completed (le run a récupéré)", () => {
    expect(classifyTermination({ noticeMessage: "récupération", turns: 8 })).toBe("completed");
  });
});

describe("classifyTermination — robustesse", () => {
  it("`done` sans motif mais avec des tours → completed (les tests tranchent)", () => {
    expect(classifyTermination({ turns: 7 })).toBe("completed");
  });

  it("erreur fournisseur sans tour ne produit jamais `failed`", () => {
    expect(classifyTermination({ error: "fetch failed", turns: 0 })).toBe("provider-error");
  });
});

describe("looksTransient — motifs reconnus", () => {
  it("reconnaît les motifs transitoires courants", () => {
    for (const t of ["timeout", "503 Service Unavailable", "rate limit exceeded", "fetch failed", "truncated"]) {
      expect(looksTransient(t)).toBe(true);
    }
  });

  it("ignore un texte vide ou neutre", () => {
    expect(looksTransient(undefined)).toBe(false);
    expect(looksTransient("assertion Failed: expected 3")).toBe(false);
  });
});
