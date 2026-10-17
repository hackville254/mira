/**
 * Tests — neutralisation de la marque interne (côté front).
 *
 * Verrouille la garantie produit « jamais cline à l'écran » au niveau du rendu.
 */
import { describe, it, expect } from "vitest";
import { neutralizeBrand, neutralizeForClient } from "../brand";

describe("brand (front) — neutralizeBrand", () => {
  it("remplace le mot seul, toutes casses", () => {
    expect(neutralizeBrand("cline")).toBe("Mira");
    expect(neutralizeBrand("Cline")).toBe("Mira");
    expect(neutralizeBrand("CLINE")).toBe("Mira");
  });

  it("remplace les chemins de config", () => {
    expect(neutralizeBrand(".cline/skills")).toBe(".mira/skills");
    expect(neutralizeBrand(".clinerules/skills")).toBe(".mira/skills");
    expect(neutralizeBrand("~/Documents/Cline/Plugins")).toBe("~/Documents/Mira/Plugins");
    expect(neutralizeBrand("cline_mcp_settings.json")).toBe("mira_mcp_settings.json");
  });

  it("remplace les identifiants collés", () => {
    expect(neutralizeBrand("@cline/core")).toBe("@Mira/core");
    expect(neutralizeBrand("ClineCore")).toBe("MiraCore");
    expect(neutralizeBrand("clineClient")).toBe("MiraClient");
  });

  it("laisse un texte neutre inchangé", () => {
    const s = "Extension mcp: serveur injoignable";
    expect(neutralizeBrand(s)).toBe(s);
  });

  it("ne laisse jamais passer la sous-chaîne interdite", () => {
    for (const s of ["clinerules", ".cline", "Documents/Cline/Hooks", "Erreur Cline @cline/shared"]) {
      expect(neutralizeBrand(s).toLowerCase()).not.toContain("cline");
    }
  });
});

describe("brand (front) — neutralizeForClient", () => {
  it("tolère null / undefined", () => {
    expect(neutralizeForClient(null)).toBe("");
    expect(neutralizeForClient(undefined)).toBe("");
  });

  it("convertit une Error", () => {
    expect(neutralizeForClient(new Error("échec .cline/hooks"))).toBe("Error: échec .mira/hooks");
  });

  it("convertit un objet", () => {
    expect(neutralizeForClient({ m: "cline" })).not.toContain("cline");
  });
});
