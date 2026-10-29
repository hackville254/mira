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
  DELEGATION_GUIDANCE_TEAMS,
  LINK_SOURCING_RULES,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_LITE,
  DEFAULT_ASK_PROMPT,
  DEFAULT_PLAN_PROMPT,
} from "../prompts";
import { TOOL_CONTRACT_FULL, TOOL_CONTRACT_READ_ONLY, SKILLS_CONTRACT_LINE } from "../toolPresentation";

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
    expect(p).toContain(TOOL_CONTRACT_FULL);
    expect(p).toContain(TODO_RULES);
    expect(p).toContain(ASK_USER_RULES);
    expect(p).toContain(STYLE_GUARDRAIL);
  });

  it("mode AGENT max inclut la délégation, l'effort normal non", () => {
    expect(buildSystemPrompt("agent", true)).toContain(DELEGATION_GUIDANCE);
    expect(buildSystemPrompt("agent", false)).not.toContain(DELEGATION_GUIDANCE);
  });

  it("les trois modes portent la politique de liens (anti-404)", () => {
    for (const mode of ["agent", "ask", "plan"] as const) {
      expect(buildSystemPrompt(mode, true)).toContain(LINK_SOURCING_RULES);
    }
  });

  it("mode IA (withTeams) annonce TOUJOURS les coéquipiers team_*, quel que soit l'effort", () => {
    const lite = buildSystemPrompt("agent", false, "", true);
    const max = buildSystemPrompt("agent", true, "", true);
    expect(lite).toContain(DELEGATION_GUIDANCE_TEAMS);
    expect(max).toContain(DELEGATION_GUIDANCE_TEAMS);
    // La variante `spawn_agent` (outil absent en IA) ne doit pas s'y trouver.
    expect(lite).not.toContain(DELEGATION_GUIDANCE);
    // Et les outils d'équipe sont nommés explicitement.
    expect(lite).toContain("team_spawn_teammate");
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
    expect(p).not.toContain(TOOL_CONTRACT_FULL);
  });

  it("mode PLAN expose en lecture seule et impose le format <origin-plan>", () => {
    const p = buildSystemPrompt("plan", true);
    expect(p).toContain(identity("plan"));
    expect(p).toContain(TOOL_CONTRACT_READ_ONLY);
    expect(p).toContain("<origin-plan>");
    expect(p).toContain("</origin-plan>");
    expect(p).not.toContain(TOOL_CONTRACT_FULL);
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
    expect(p.indexOf(TODO_RULES)).toBeLessThan(p.indexOf("## Tools"));
    expect(p.indexOf(ASK_USER_RULES)).toBeLessThan(p.indexOf("## Editing"));
    expect(p.indexOf(DELEGATION_GUIDANCE)).toBeLessThan(p.indexOf("## Editing"));
  });

  it("mode ASK cadre COMMENT répondre (citer le code, ne pas inventer)", () => {
    const p = buildSystemPrompt("ask", true);
    expect(p).toContain(ASK_ANSWER_RULES);
    expect(p).toContain("## Changes in ASK mode");
  });

  it("mode ASK est en LECTURE SEULE : aucun outil d'édition, quel que soit l'effort", () => {
    const max = buildSystemPrompt("ask", true);
    const normal = buildSystemPrompt("ask", false);
    // ASK ne modifie jamais de fichiers : on n'y annonce aucun outil d'écriture,
    // ni `editor` ni les règles d'édition (l'effort ne change pas les outils).
    for (const p of [max, normal]) {
      expect(p).not.toContain("`editor`");
      expect(p).not.toContain(EDIT_RULES_FULL);
      expect(p).not.toContain(EDIT_RULES_LITE);
      expect(p).toContain("read-only");
    }
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
  it("le contrat d'outils agent est bien injecté", () => {
    expect(buildSystemPrompt("agent", true)).toContain(TOOL_CONTRACT_FULL);
  });

  it("le contrat lecture seule est bien injecté en mode PLAN", () => {
    expect(buildSystemPrompt("plan", true)).toContain(TOOL_CONTRACT_READ_ONLY);
  });

  // Invariants verrouillés sur les flags RÉELS du SDK Cline (voir
  // `toolPresentation.ts`) : les réintroduire serait un bug silencieux.
  it("n'annonce JAMAIS `apply_patch` (désactivé par le SDK dans tous les modes)", () => {
    expect(buildSystemPrompt("agent", true)).not.toContain("apply_patch");
    expect(buildSystemPrompt("ask", true)).not.toContain("apply_patch");
    expect(buildSystemPrompt("plan", true)).not.toContain("apply_patch");
  });

  it("n'annonce `editor` QUE en mode AGENT (désactivé en plan/ask)", () => {
    expect(buildSystemPrompt("agent", true)).toContain("`editor`");
    expect(buildSystemPrompt("ask", true)).not.toContain("`editor`");
    expect(buildSystemPrompt("plan", true)).not.toContain("`editor`");
  });

  // Invariants verrouillés sur le comportement RÉEL de `editor` (SDK Cline) :
  // sans ces distinctions, le modèle mélange création et remplacement et prend
  // des erreurs « text not found » / « already exists, but old_text was omitted ».
  it("distingue CREATE (sans old_text), REPLACE (avec old_text) et APPEND (insert_line)", () => {
    for (const p of [buildSystemPrompt("agent", true), buildSystemPrompt("agent", false)]) {
      expect(p).toMatch(/CREATE/i);
      expect(p).toMatch(/REPLACE/i);
      expect(p).toMatch(/APPEND/i);
      // La forme d'ajout en fin doit être nommée explicitement avec sa formule.
      expect(p).toContain("insert_line");
      expect(p).toContain("line_count + 1");
    }
  });

  it("rappelle la limite dure de 6000 caractères de `editor`", () => {
    expect(buildSystemPrompt("agent", true)).toContain("6000");
    expect(buildSystemPrompt("agent", false)).toContain("6000");
  });

  // Invariant verrouillé sur l'outil `skills` (SDK Cline) : le SDK appende la
  // liste `Available skills: …` à la description de l'outil, mais une puce
  // PASSIVE suffisait à ce que le modèle réponde sans jamais invoquer de skill.
  // Les deux modes doivent donc porter la consigne ACTIVE, identique.
  it("pousse à VÉRIFIER puis INVOQUER les skills, dans les deux modes", () => {
    expect(SKILLS_CONTRACT_LINE).toContain("Available skills");
    for (const p of [buildSystemPrompt("agent", true), buildSystemPrompt("plan", true)]) {
      expect(p).toContain(SKILLS_CONTRACT_LINE);
    }
    // Aucune trace de l'ancienne formulation passive.
    expect(buildSystemPrompt("agent", true)).not.toContain(
      "- `skills`: invoke a configured skill by name when it matches the task.",
    );
  });
});
