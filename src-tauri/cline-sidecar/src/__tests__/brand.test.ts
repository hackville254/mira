/**
 * Tests — neutralisation de la marque interne (règle produit Mira).
 *
 * Runner : `node --test` (natif, zéro dépendance) — le sidecar n'embarque pas de
 * framework de test. Lancer : `npm test` dans `cline-sidecar/`.
 *
 * Ces tests verrouillent la garantie « le client ne voit jamais cline » : si une
 * future modification laisse passer le mot, ils échouent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { neutralizeBrand, neutralizeForClient } from "../brand.ts";

test("neutralizeBrand — mot seul, toutes casses", () => {
  assert.equal(neutralizeBrand("cline"), "Mira");
  assert.equal(neutralizeBrand("Cline"), "Mira");
  assert.equal(neutralizeBrand("CLINE"), "Mira");
});

test("neutralizeBrand — chemins de config par défaut", () => {
  assert.equal(neutralizeBrand(".cline/skills"), ".mira/skills");
  assert.equal(neutralizeBrand(".clinerules/skills"), ".mira/skills");
  assert.equal(neutralizeBrand("~/Documents/Cline/Plugins"), "~/Documents/Mira/Plugins");
  assert.equal(neutralizeBrand("cline_mcp_settings.json"), "mira_mcp_settings.json");
});

test("neutralizeBrand — identifiants collés du SDK", () => {
  assert.equal(neutralizeBrand("@cline/core"), "@Mira/core");
  assert.equal(neutralizeBrand("ClineCore"), "MiraCore");
  assert.equal(neutralizeBrand("clineClient"), "MiraClient");
});

test("neutralizeBrand — texte neutre inchangé", () => {
  const s = "Extension skills: fichier SKILL.md introuvable";
  assert.equal(neutralizeBrand(s), s);
});

test("neutralizeBrand — aucune sous-chaîne interdite en sortie", () => {
  const samples = [
    "clinerules",
    ".cline",
    "Documents/Cline/Hooks",
    "Erreur Cline: plugin invalide @cline/shared",
  ];
  for (const s of samples) {
    assert.ok(!neutralizeBrand(s).toLowerCase().includes("cline"), `fuite dans: ${s}`);
  }
});

test("neutralizeForClient — tolère null / undefined", () => {
  assert.equal(neutralizeForClient(null), "");
  assert.equal(neutralizeForClient(undefined), "");
});

test("neutralizeForClient — Error neutralisée", () => {
  assert.equal(neutralizeForClient(new Error("échec .cline/hooks")), "Error: échec .mira/hooks");
});

test("neutralizeForClient — objet quelconque", () => {
  assert.ok(!neutralizeForClient({ m: "cline" }).includes("cline"));
});
