/**
 * Instrument de MESURE des prompts système (analyse, sans jugement figé).
 *
 * ── But ───────────────────────────────────────────────────────────────────────
 * Après le dump (`prompts.dump.test.ts`), on veut des NOMBRES pour piloter les
 * décisions d'édition plutôt que des impressions. Ce fichier mesure, pour chaque
 * preset :
 *   - taille en caractères et estimation en tokens (proxy ~4 car./token) ;
 *   - nombre de sections et de puces ;
 *   - redites INTER-sections (lignes identiques ou très proches) : signal #1 de
 *     gaspillage de prompt ;
 *   - est-ce que chaque CONCEPT clé (outils, édition, todos, question, style)
 *     est présent, et une seule fois ;
 *   - densité : puces par section (une section trop grosse = mal factorisée).
 *
 * Lancer :
 *   npx vitest run src/lib/agent/__tests__/prompts.metrics.test.ts
 *
 * Biases évités : pas de seuil « magique ». On affiche les valeurs brutes et on
 * n'asserte QUE des invariants objectifs (unicité d'un concept, non-vacuité,
 * monotonie max >= normal). Le reste est destiné à la lecture humaine.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompts";

const PRESETS = [
  ["agent", true],
  ["agent", false],
  ["ask", true],
  ["ask", false],
  ["plan", true],
  ["plan", false],
] as const;

type Mode = "agent" | "ask" | "plan";

interface Metrics {
  label: string;
  chars: number;
  tokens: number;
  sections: number;
  bullets: number;
  dupLines: string[];
  concepts: Record<string, number>;
  bulletsPerSection: number;
}

/** Normalise une ligne pour comparer des énoncés « à la sémantique près ». */
function normLine(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Détecte les lignes normées présentes dans PLUSIEURS sections. */
function crossSectionDuplicates(prompt: string): string[] {
  const sections = prompt.split(/\n## /);
  const seen = new Map<string, number>();
  for (const sec of sections) {
    const local = new Set<string>();
    for (const raw of sec.split("\n")) {
      const n = normLine(raw);
      // On ignore le bruit : titres, lignes trop courtes, exemples de code.
      if (n.length < 25 || raw.trimStart().startsWith("##") || raw.includes("<")) continue;
      local.add(n);
    }
    for (const n of local) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, c]) => c > 1).map(([l, c]) => `${c}x  ${l}`);
}

/** Compte l'occurrence de mots-concept dans tout le prompt. */
function countConcept(prompt: string, re: RegExp): number {
  return (prompt.match(re) ?? []).length;
}

function measure(mode: Mode, isMax: boolean): Metrics {
  const p = buildSystemPrompt(mode, isMax);
  const sections = (p.match(/^## /gm) ?? []).length;
  const bullets = (p.match(/^- /gm) ?? []).length;
  return {
    label: `${mode}/${isMax ? "max" : "normal"}`,
    chars: p.length,
    tokens: Math.round(p.length / 4),
    sections,
    bullets,
    dupLines: crossSectionDuplicates(p),
    concepts: {
      tools: countConcept(p, /tool|`read_file`|`edit`/gi),
      editing: countConcept(p, /edit\b|editing|write_file|search\/replace/gi),
      todos: countConcept(p, /todo_write|checklist|progress tracking/gi),
      ask: countConcept(p, /ask_user|ask only|asking the user/gi),
      style: countConcept(p, /emoji|em dash|output style/gi),
      delegate: countConcept(p, /spawn_agent|sub-agent|delegat/gi),
    },
    bulletsPerSection: sections ? +(bullets / sections).toFixed(2) : 0,
  };
}

const isReport = true;

function report(rows: Metrics[]): void {
  if (!isReport) return;
  const w = (s: string | number, n: number) => String(s).padEnd(n);
  const line = "─".repeat(100);

  console.log(`\n${line}\nMÉTRIQUES DES PROMPTS\n${line}`);
  console.log(
    w("preset", 16) + w("chars", 8) + w("~tokens", 9) + w("sect", 6) + w("bullets", 9) + w("b/sect", 8) + "redites",
  );
  for (const r of rows) {
    console.log(
      w(r.label, 16) +
        w(r.chars, 8) +
        w(r.tokens, 9) +
        w(r.sections, 6) +
        w(r.bullets, 9) +
        w(r.bulletsPerSection, 8) +
        (r.dupLines.length === 0 ? "0" : String(r.dupLines.length)),
    );
  }

  console.log(`\n${line}\nCOUVERTURE DES CONCEPTS (occurrences ; 0 = absent)\n${line}`);
  console.log(
    w("preset", 16) + w("tools", 8) + w("editing", 9) + w("todos", 8) + w("ask", 7) + w("style", 8) + "deleg",
  );
  for (const r of rows) {
    const c = r.concepts;
    console.log(
      w(r.label, 16) +
        w(c.tools, 8) +
        w(c.editing, 9) +
        w(c.todos, 8) +
        w(c.ask, 7) +
        w(c.style, 8) +
        c.delegate,
    );
  }

  const withDup = rows.filter((r) => r.dupLines.length > 0);
  console.log(`\n${line}\nREDITES INTER-SECTIONS\n${line}`);
  if (withDup.length === 0) {
    console.log("aucune redite détectée.");
  } else {
    for (const r of withDup) {
      console.log(`\n● ${r.label}`);
      for (const d of r.dupLines) console.log(`   ${d}`);
    }
  }
  console.log(`${line}\n`);
}

describe("MÉTRIQUES — mesure objective des prompts", () => {
  const rows = PRESETS.map(([m, max]) => measure(m, max));

  it("rapport complet", () => {
    report(rows);
    expect(rows.length).toBe(6);
  });

  it("aucune redite inter-sections dans un même preset (invariant objectif)", () => {
    const offenders = rows.filter((r) => r.dupLines.length > 0);
    expect(offenders.map((r) => r.label)).toEqual([]);
  });

  it("le preset max n'est jamais plus léger que le preset normal", () => {
    for (const mode of ["agent", "ask", "plan"] as const) {
      const max = buildSystemPrompt(mode, true).length;
      const normal = buildSystemPrompt(mode, false).length;
      expect(max).toBeGreaterThanOrEqual(normal);
    }
  });

  // Budget de prompt : garde-fou ANTI-DÉRIVE, pas une cible. Le seuil est passé
  // de 6000 à 8000 quand le preset agent/max a gagné le bloc « Objective »
  // (poursuite de l'objectif), à 8600 avec le contrat des OUTILS DE COMPRÉHENSION
  // DU PROJET (`project_overview`, `git_status`, `git_diff`, `search_symbols`,
  // `find_imports`), puis à 10000 avec les blocs de PLAN structuré et de
  // COHÉRENCE DES RÉPONSES. Chaque palier ajoute des capacités RÉELLES
  // (compréhension, cadrage, robustesse des réponses), volontairement comprimées.
  // 10000 est un PLAFOND : au-delà, la prochaine addition devra COMPRESSER
  // l'existant au lieu de repousser le seuil.
  it("chaque preset reste sous 10000 caractères (~2500 tokens) — budget de prompt", () => {
    for (const r of rows) {
      expect(r.chars).toBeLessThan(10000);
    }
  });

  it("les concepts cœur sont présents selon le mode (pas de section fantôme)", () => {
    const agent = measure("agent", true);
    const ask = measure("ask", true);
    const plan = measure("plan", true);
    // Agent : outils + todos + question + édition.
    expect(agent.concepts.tools).toBeGreaterThan(0);
    expect(agent.concepts.todos).toBeGreaterThan(0);
    expect(agent.concepts.ask).toBeGreaterThan(0);
    // ASK ne doit avoir AUCUNE mention de délégation.
    expect(ask.concepts.delegate).toBe(0);
    // PLAN : outils read-only décrits, aucune délégation.
    expect(plan.concepts.delegate).toBe(0);
    expect(plan.concepts.tools).toBeGreaterThan(0);
  });

  it("la délégation n'apparaît QUE dans agent/max", () => {
    const withDelegate = rows.filter((r) => r.concepts.delegate > 0).map((r) => r.label);
    expect(withDelegate).toEqual(["agent/max"]);
  });
});
