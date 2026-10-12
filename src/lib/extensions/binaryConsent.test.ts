import { describe, it, expect } from "vitest";
import {
  normalizeBinaryPath,
  normalizeBinaryList,
  missingBinaryConsent,
  describeBinaries,
} from "./binaryConsent";

describe("normalizeBinaryPath", () => {
  it("uniformise les séparateurs et retire le préfixe ./", () => {
    expect(normalizeBinaryPath(".\\bin\\mytool")).toBe("bin/mytool");
    expect(normalizeBinaryPath("./bin/mytool")).toBe("bin/mytool");
    expect(normalizeBinaryPath("bin//mytool")).toBe("bin/mytool");
  });

  it("est idempotente sur un chemin déjà normalisé", () => {
    expect(normalizeBinaryPath("bin/tool")).toBe("bin/tool");
  });
});

describe("normalizeBinaryList", () => {
  it("dédoublonne après normalisation", () => {
    expect(normalizeBinaryList(["bin/tool", "./bin/tool", "bin\\tool"])).toEqual(["bin/tool"]);
  });

  it("ignore les entrées vides", () => {
    expect(normalizeBinaryList(["", "  ", "bin/tool"])).toEqual(["bin/tool"]);
  });
});

describe("missingBinaryConsent", () => {
  it("renvoie tout quand rien n'est approuvé", () => {
    expect(missingBinaryConsent(["bin/a", "bin/b"], [])).toEqual(["bin/a", "bin/b"]);
  });

  it("renvoie seulement ce qui manque", () => {
    expect(missingBinaryConsent(["bin/a", "bin/b"], ["bin/a"])).toEqual(["bin/b"]);
  });

  it("tolère des variantes de chemin pour un même binaire", () => {
    expect(missingBinaryConsent(["./bin/a"], ["bin/a"])).toEqual([]);
  });

  it("renvoie une liste vide sans binaire déclaré", () => {
    expect(missingBinaryConsent([], ["bin/a"])).toEqual([]);
  });
});

describe("describeBinaries", () => {
  it("liste les binaires manquants dans le message", () => {
    expect(describeBinaries(["bin/a", "bin/b"])).toBe(
      "Binaires tiers à approuver : bin/a, bin/b",
    );
  });

  it("renvoie une chaîne vide sans binaire manquant", () => {
    expect(describeBinaries([])).toBe("");
  });
});
