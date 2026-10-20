// ── Tests — détection de NON-CONVERGENCE (Étape 3) ────────────────────────────
//
// Objectif : vérifier que le détecteur signale HONNÊTEMENT une exploration qui
// ne converge pas (boucle d'outil, stérilité sans écriture) et qu'il ne
// déclenche PAS de faux positif sur un run sain. Aucune dépendance au sidecar,
// au réseau ou au disque : la logique est pure.

import { describe, it, expect } from "vitest";

import {
  ConvergenceTracker,
  CONVERGENCE,
  resumeInstruction,
  type ConvergenceReport,
} from "../../../../bench/coding/headless/convergence";

/** Construit un rapport en simulant une suite d'appels d'outils. */
function reportFor(tools: string[], turns = tools.length): ConvergenceReport {
  const t = new ConvergenceTracker();
  for (const name of tools) t.observe(name);
  t.setTurns(turns);
  return t.report();
}

describe("ConvergenceTracker — boucle d'outil", () => {
  it("détecte une répétition consécutive au seuil", () => {
    const report = reportFor(Array(CONVERGENCE.REPEAT_THRESHOLD).fill("run_commands"));
    expect(report.maxConsecutiveSameTool).toBe(CONVERGENCE.REPEAT_THRESHOLD);
    expect(report.loopDetected).toBe(true);
  });

  it("ne signale PAS de boucle sous le seuil", () => {
    const report = reportFor(Array(CONVERGENCE.REPEAT_THRESHOLD - 1).fill("run_commands"));
    expect(report.loopDetected).toBe(false);
  });

  it("réinitialise la série quand l'outil change (alternance = pas une boucle)", () => {
    const report = reportFor(["run_commands", "editor", "run_commands", "editor", "run_commands", "editor"]);
    expect(report.maxConsecutiveSameTool).toBe(1);
    expect(report.loopDetected).toBe(false);
  });

  it("compte les appels par outil", () => {
    const report = reportFor(["run_commands", "run_commands", "editor", "read_file"]);
    expect(report.toolNameCounts).toEqual({ run_commands: 2, editor: 1, read_file: 1 });
  });

  it("ignore un nom d'outil vide (événement sans toolName)", () => {
    const report = reportFor(["run_commands", "", "editor"]);
    expect(report.toolNameCounts).toEqual({ run_commands: 1, editor: 1 });
    expect(report.maxConsecutiveSameTool).toBe(1);
  });
});

describe("ConvergenceTracker — stérilité (aucune écriture)", () => {
  it("signale l'exploration stérile au-delà du seuil de tours sans écriture", () => {
    const report = reportFor(Array(CONVERGENCE.STALL_TURNS).fill("run_commands"), CONVERGENCE.STALL_TURNS);
    expect(report.writeCalls).toBe(0);
    expect(report.stalled).toBe(true);
  });

  it("une SEULE écriture suffit à lever la stérilité", () => {
    const report = reportFor(
      [...Array(CONVERGENCE.STALL_TURNS + 4).fill("run_commands"), "editor"],
      CONVERGENCE.STALL_TURNS + 5,
    );
    expect(report.writeCalls).toBe(1);
    expect(report.stalled).toBe(false);
  });

  it("sous le seuil de tours, pas de verdict de stérilité", () => {
    const report = reportFor(Array(CONVERGENCE.STALL_TURNS - 1).fill("run_commands"), CONVERGENCE.STALL_TURNS - 1);
    expect(report.stalled).toBe(false);
  });
});

describe("resumeInstruction — décide (ou non) d'une reprise ciblée", () => {
  it("ne relance PAS un run sain terminé normalement", () => {
    const report = reportFor(["run_commands", "editor", "run_commands"]);
    expect(resumeInstruction(report, "completed")).toBeNull();
  });

  it("relance un run qui a épuisé ses tours sans écrire", () => {
    const report = reportFor(Array(CONVERGENCE.STALL_TURNS + 8).fill("run_commands"), CONVERGENCE.STALL_TURNS + 8);
    const instr = resumeInstruction(report, "max_iterations");
    expect(instr).not.toBeNull();
    expect(instr).toContain("STOP");
  });

  it("relance un run qui a bouclé même après avoir écrit (boucle explicite)", () => {
    const report = reportFor([...Array(CONVERGENCE.REPEAT_THRESHOLD + 2).fill("run_commands")]);
    expect(resumeInstruction(report, undefined)).not.toBeNull();
  });

  it("préserve un patch partiel : pas de reprise si l'agent a écrit et terminé (max_iterations sans boucle)", () => {
    const report = reportFor(["editor", "run_commands", "run_commands", "run_commands"], 20);
    // writeCalls > 0, pas de boucle : on rend la main pour ne pas écraser le patch.
    expect(resumeInstruction(report, "max_iterations")).toBeNull();
  });

  it("relance un run interrompu par une erreur de budget sans écriture", () => {
    const report = reportFor(Array(CONVERGENCE.STALL_TURNS).fill("run_commands"), CONVERGENCE.STALL_TURNS);
    expect(resumeInstruction(report, "max_iterations")).not.toBeNull();
  });
});
