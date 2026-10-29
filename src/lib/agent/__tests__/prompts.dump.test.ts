/**
 * Banc de lecture des prompts système.
 *
 * ── But ───────────────────────────────────────────────────────────────────────
 * Ce fichier N'EST PAS un test de correction au sens strict : c'est un INSTRUMENT
 * de revue. Il compose chaque preset réel (agent / ask / plan, effort normal / max,
 * avec et sans workspace) et l'IMPRIME intégralement dans le terminal, section par
 * section. On lit le raisonnement, on repère ce qui doit être amélioré, on édite
 * `prompts.ts`, on relance.
 *
 * Lancer :
 *   npx vitest run src/lib/agent/__tests__/prompts.dump.test.ts
 *
 * Les assertions en fin de fichier sont volontairement LÉGÈRES : elles ne
 * verrouillent que des invariants structurels (non-vacuité, ordre des sections).
 * Le contenu, lui, est fait pour être lu et critiqué, pas figé ici — les
 * invariants forts vivent dans `prompts.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, composeSystemPrompt } from "../prompts";

// `console` est autorisé dans cet instrument (sortie voulue) ; on évite toute
// dépendance à `process`/`@types/node` en gardant l'impression toujours active.
const isDump = true;

/** Affiche un prompt entier, encadré, sans échappement ni troncature. */
function dump(label: string, prompt: string): void {
  if (!isDump) return;
  const line = "═".repeat(78);
  const chars = prompt.length;
  const sections = (prompt.match(/^## /gm) ?? []).length;
  console.log(
    `\n${line}\n█ ${label}   [${chars} car., ${sections} sections]\n${line}\n\n${prompt}\n${line}`,
  );
}

/** Extrait les titres de sections (`## …`) dans l'ordre d'apparition. */
function headings(prompt: string): string[] {
  return (prompt.match(/^## .+$/gm) ?? []).map((h) => h.slice(3).trim());
}

describe("DUMP — lecture des prompts générés", () => {
  it("mode AGENT — effort max (délégation activée)", () => {
    const p = buildSystemPrompt("agent", true);
    dump("AGENT / max", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode AGENT — effort normal", () => {
    const p = buildSystemPrompt("agent", false);
    dump("AGENT / normal", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode ASK — effort max", () => {
    const p = buildSystemPrompt("ask", true);
    dump("ASK / max", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode ASK — effort normal", () => {
    const p = buildSystemPrompt("ask", false);
    dump("ASK / normal", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode PLAN — effort max", () => {
    const p = buildSystemPrompt("plan", true);
    dump("PLAN / max", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode PLAN — effort normal", () => {
    const p = buildSystemPrompt("plan", false);
    dump("PLAN / normal", p);
    expect(p.length).toBeGreaterThan(0);
  });

  it("mode AGENT + contexte workspace (note injectée en fin)", () => {
    const note = "## Workspace context\n- root: /Users/user/code/proj\n- stack: React 19 + TypeScript";
    const p = buildSystemPrompt("agent", true, note);
    dump("AGENT / max + workspace", p);
    expect(p.endsWith(note)).toBe(true);
  });

  it("prompt personnalisé via le composeur (habillage style + ORIGIN.md)", () => {
    const custom = "## Custom\n- Tu es un agent spécialisé sur le code Rust.";
    const p = composeSystemPrompt({ blocks: [custom], extra: "## ORIGIN.md\n- Toujours répondre en français." });
    dump("CUSTOM / habillage", p);
    expect(p).toContain(custom);
  });

  it("RAPPORT — ordre des sections par mode (lisible d'un coup d'œil)", () => {
    const rows = [
      ["agent/max", buildSystemPrompt("agent", true)],
      ["agent/normal", buildSystemPrompt("agent", false)],
      ["ask/max", buildSystemPrompt("ask", true)],
      ["plan/max", buildSystemPrompt("plan", true)],
    ] as const;

    if (isDump) {
      const line = "─".repeat(78);
      console.log(`\n${line}\nRAPPORT — ordre des sections\n${line}`);
      for (const [label, p] of rows) {
        console.log(`\n● ${label}\n  ${headings(p).join("  →  ")}`);
      }
      console.log(`${line}\n`);
    }

    expect(headings(buildSystemPrompt("agent", true)).length).toBeGreaterThan(3);
  });

  it("RAPPORT — uniformité : la consigne de style est présente partout", () => {
    const modes = ["agent", "ask", "plan"] as const;
    const missing: string[] = [];
    for (const m of modes) {
      for (const max of [true, false]) {
        if (!buildSystemPrompt(m, max).includes("## Output style")) missing.push(`${m}/${max ? "max" : "normal"}`);
      }
    }
    if (isDump) {
      console.log(
        missing.length === 0
          ? "\n✓ Uniformité OK : « ## Output style » présent dans les 6 presets.\n"
          : `\n✗ Style MANQUANT dans : ${missing.join(", ")}\n`,
      );
    }
    expect(missing).toEqual([]);
  });
});
