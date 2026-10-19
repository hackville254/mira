// ── Évaluateur — CŒUR PUR (aucune dépendance Node) ────────────────────────────
//
// Ce module contient UNIQUEMENT la logique pure d'évaluation (parsing de la
// sortie de test + application des critères FAIL_TO_PASS / PASS_TO_PASS). Il est
// séparé de `evaluator.ts` — qui, lui, exécute un process via `node:child_process`
// — afin de pouvoir être réutilisé dans la webview Tauri (où `node:*` est
// interdit). La webview exécute les tests via une commande Tauri, puis applique
// EXACTEMENT la même logique de notation : une seule source de vérité.

import type { TestOutcome } from "./types";

export interface TestRunResult {
  /** Code de sortie du processus de test (null si tué par timeout/signal). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Vrai si le processus a dépassé `testTimeoutMs`. */
  timedOut: boolean;
  durationMs: number;
}

/**
 * Extrait les résultats par nom de test depuis la sortie d'un runner.
 *
 * Cherche les lignes marquées `✓`/`√` (succès) ou `✗`/`×`/`✕` (échec), telles
 * qu'émises par vitest/jest/mocha, et renvoie un index nom → passé.
 */
export function parseTestOutcomes(stdout: string, stderr: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const text = `${stdout}\n${stderr}`;
  // Séquence ANSI SGR (échappement) construite sans caractère de contrôle littéral.
  const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const PASS_MARK = "✓√✔";
  const FAIL_MARK = "✗×✕✖";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(ANSI_SGR, "").trim();

    // Format TAP : « ok 1 - nom » / « not ok 1 - nom ».
    const tap = line.match(/^(not ok|ok)\s+\d+\s*-\s*(.*?)(?:\s+\d+(?:\.\d+)?\s*ms)?$/);
    if (tap) {
      const name = tap[2].trim();
      if (name) out.set(name, tap[1] === "ok");
      continue;
    }

    // Format symbole : « ✔ nom (0.3ms) », « ✖ nom (0.4ms) », « ✓ nom 12ms ».
    const m = line.match(/^(.)\s+(.+)$/);
    if (!m) continue;
    const mark = m[1];
    if (!PASS_MARK.includes(mark) && !FAIL_MARK.includes(mark)) continue;
    const passed = PASS_MARK.includes(mark);
    const name = m[2]
      .replace(/\s*\(\d+(?:\.\d+)?\s*ms\)\s*$/, "")
      .replace(/\s+\d+(?:\.\d+)?\s*ms\s*$/, "")
      .trim()
      .replace(/\s*>\s*/g, " > ")
      .trim();
    if (name) out.set(name, passed);
  }
  return out;
}

/**
 * Convertit un résultat de test en `TestOutcome[]` pour la liste de critères.
 * Repli sur le code de sortie si la sortie n'est pas reconnue : jamais de succès
 * sans preuve.
 */
export function evaluateCriteria(
  names: string[],
  parsed: Map<string, boolean>,
  run: TestRunResult,
): TestOutcome[] {
  const globalPass = run.exitCode === 0 && !run.timedOut;

  return names.map((name) => {
    const key = [...parsed.keys()].find(k => k === name || k.includes(name) || name.includes(k));
    if (key != null) {
      return { name, passed: parsed.get(key) === true, detail: key };
    }
    return {
      name,
      passed: globalPass,
      detail: globalPass
        ? "non parsé — succès déduit du code de sortie 0"
        : `non parsé — sortie non reconnue (exit=${String(run.exitCode)})`,
    };
  });
}

/** FAIL_TO_PASS et PASS_TO_PASS doivent tous passer après modification. */
export function criteriaSatisfied(outcomes: TestOutcome[]): boolean {
  return outcomes.every(o => o.passed);
}
