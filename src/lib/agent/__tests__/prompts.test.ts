import { describe, it, expect } from "vitest";
import {
  identity,
  composeSystemPrompt,
  buildSystemPrompt,
  STYLE_GUARDRAIL,
  CONCISION,
  ASK_USER_RULES,
  ASK_ANSWER_RULES,
  TODO_RULES,
  EDIT_RULES_FULL,
  EDIT_RULES_LITE,
  DELEGATION_GUIDANCE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_LITE,
  DEFAULT_ASK_PROMPT,
  DEFAULT_PLAN_PROMPT,
} from "../prompts";
import { FULL_TOOLS_LIST, READ_ONLY_TOOLS_LIST } from "../toolPresentation";

// Séparateur utilisé par le composeur entre deux blocs.
const SEP = "\n\n---\n\n";

describe("identity", () => {
  it("rend une identité distincte et non vide par mode", () => {
    const agent = identity("agent");
    const ask = identity("ask");
    const plan = identity("plan");
    expect(agent).toContain("AGENT mode");
    expect(ask).toContain("ASK mode");
    expect(plan).toContain("PLAN mode");
    expect(new Set([agent, ask, plan]).size).toBe(3);
  });

  it("interdit l'initiative de modification en ASK et verrouille PLAN en lecture seule", () => {
    expect(identity("ask")).toMatch(/never start changing code on your own/i);
    expect(identity("plan")).toMatch(/READ-ONLY/i);
  });
});

describe("composeSystemPrompt", () => {
  it("assemble les blocs dans l'ordre, séparés par `---`", () => {
    const out = composeSystemPrompt({ blocks: ["A", "B"], style: "S" });
    expect(out).toBe(["A", "B", "S"].join(SEP));
  });

  it("ignore les blocs vides ou blancs sans créer de séparateur orphelin", () => {
    const out = composeSystemPrompt({ blocks: ["A", "", "   ", "B"], style: "" });
    expect(out).toBe(["A", "B"].join(SEP));
    expect(out.startsWith(SEP)).toBe(false);
    expect(out.endsWith(SEP)).toBe(false);
  });

  it("place la consigne de style en AVANT-dernière et `extra` en dernier", () => {
    const out = composeSystemPrompt({ blocks: ["A"], extra: "ORIGIN.md" });
    expect(out).toBe(["A", STYLE_GUARDRAIL, "ORIGIN.md"].join(SEP));
  });

  it("omet `extra` quand il est absent", () => {
    const out = composeSystemPrompt({ blocks: ["A"] });
    expect(out).toBe(["A", STYLE_GUARDRAIL].join(SEP));
  });

  it("accepte un style personnalisé qui remplace le garde-fou par défaut", () => {
    const out = composeSystemPrompt({ blocks: ["A"], style: "STYLE_X" });
    expect(out).toBe(["A", "STYLE_X"].join(SEP));
    expect(out).not.toContain("## Output style");
  });
});

describe("buildSystemPrompt — invariants par mode", () => {
  it("mode AGENT contient concision, outils complets, todos, question user", () => {
    const p = buildSystemPrompt("agent", true);
    expect(p).toContain(identity("agent"));
    expect(p).toContain(CONCISION);
    expect(p).toContain(FULL_TOOLS_LIST);
    expect(p).toContain(TODO_RULES);
    expect(p).toContain(ASK_USER_RULES);
    expect(p).toContain(STYLE_GUARDRAIL);
  });

  it("mode AGENT max inclut la délégation, l'effort normal non", () => {
    expect(buildSystemPrompt("agent", true)).toContain(DELEGATION_GUIDANCE);
    expect(buildSystemPrompt("agent", false)).not.toContain(DELEGATION_GUIDANCE);
  });

  it("mode AGENT max utilise les règles d'édition complètes, normal les condensées", () => {
    const max = buildSystemPrompt("agent", true);
    const lite = buildSystemPrompt("agent", false);
    expect(max).toContain(EDIT_RULES_FULL);
    expect(max).not.toContain(EDIT_RULES_LITE);
    expect(lite).toContain(EDIT_RULES_LITE);
    expect(lite).not.toContain(EDIT_RULES_FULL);
  });

  it("mode ASK n'expose PAS les outils d'écriture ni la délégation", () => {
    const p = buildSystemPrompt("ask", true);
    expect(p).toContain(identity("ask"));
    expect(p).toContain("## Changes in ASK mode");
    expect(p).not.toContain(DELEGATION_GUIDANCE);
    expect(p).not.toContain(TODO_RULES);
    expect(p).not.toContain(FULL_TOOLS_LIST);
  });

  it("mode PLAN expose en lecture seule et impose le format <origin-plan>", () => {
    const p = buildSystemPrompt("plan", true);
    expect(p).toContain(identity("plan"));
    expect(p).toContain(READ_ONLY_TOOLS_LIST);
    expect(p).toContain("<origin-plan>");
    expect(p).toContain("</origin-plan>");
    expect(p).not.toContain(FULL_TOOLS_LIST);
    expect(p).not.toContain(DELEGATION_GUIDANCE);
  });

  it("injecte workspaceNote en toute fin (après le style)", () => {
    const note = "## Workspace\n- root: /tmp/proj";
    const p = buildSystemPrompt("agent", true, note);
    expect(p.endsWith(note)).toBe(true);
    expect(p.indexOf(STYLE_GUARDRAIL)).toBeLessThan(p.indexOf(note));
  });

  it("applique le garde-fou de style à TOUS les modes (uniformité)", () => {
    for (const mode of ["agent", "ask", "plan"] as const) {
      for (const isMax of [true, false]) {
        expect(buildSystemPrompt(mode, isMax)).toContain(STYLE_GUARDRAIL);
      }
    }
  });

  it("ordonne PRINCIPES avant DÉTAILS D'OUTIL en mode AGENT", () => {
    const p = buildSystemPrompt("agent", true);
    // Les principes comportementaux précèdent les sections d'outils.
    expect(p.indexOf(TODO_RULES)).toBeLessThan(p.indexOf("## Available tools"));
    expect(p.indexOf(ASK_USER_RULES)).toBeLessThan(p.indexOf("## Editing"));
    expect(p.indexOf(DELEGATION_GUIDANCE)).toBeLessThan(p.indexOf("## Editing"));
  });

  it("mode ASK cadre COMMENT répondre (citer le code, ne pas inventer)", () => {
    const p = buildSystemPrompt("ask", true);
    expect(p).toContain(ASK_ANSWER_RULES);
    expect(p).toContain("## Changes in ASK mode");
  });

  it("mode ASK : `isMax` a un effet réel (presets non identiques)", () => {
    const max = buildSystemPrompt("ask", true);
    const normal = buildSystemPrompt("ask", false);
    expect(max).not.toBe(normal);
    expect(max.length).toBeGreaterThan(normal.length);
    // max ajoute la mécanique d'édition complète, normal non.
    expect(max).toContain(EDIT_RULES_FULL);
    expect(normal).not.toContain(EDIT_RULES_FULL);
  });
});

describe("compat — constantes exportées (délèguent au composeur)", () => {
  it("DEFAULT_SYSTEM_PROMPT est un agent max, la variante LITE un agent normal", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBe(buildSystemPrompt("agent", true));
    expect(DEFAULT_SYSTEM_PROMPT_LITE).toBe(buildSystemPrompt("agent", false));
  });

  it("DEFAULT_ASK_PROMPT correspond au preset ask max", () => {
    expect(DEFAULT_ASK_PROMPT).toBe(buildSystemPrompt("ask", true));
  });

  it("DEFAULT_PLAN_PROMPT correspond au preset plan max", () => {
    expect(DEFAULT_PLAN_PROMPT).toBe(buildSystemPrompt("plan", true));
  });
});

describe("anti-dérive — les noms d'outils cités existent", () => {
  it("la liste des outils de l'agent est bien injectée telle quelle", () => {
    expect(buildSystemPrompt("agent", true)).toContain(FULL_TOOLS_LIST);
  });

  it("la liste lecture seule est bien injectée en mode PLAN", () => {
    expect(buildSystemPrompt("plan", true)).toContain(READ_ONLY_TOOLS_LIST);
  });
});
