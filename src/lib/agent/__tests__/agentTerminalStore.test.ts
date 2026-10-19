import { describe, it, expect, beforeEach } from "vitest";
import {
  agentTerminalCommandStart,
  agentTerminalOutput,
  agentTerminalCommandEnd,
  clearAgentTerminal,
  forgetAgentTerminal,
  getAgentTerminal,
} from "../agentTerminalStore";

const S = "s1";

describe("agentTerminalStore", () => {
  beforeEach(() => {
    forgetAgentTerminal(S);
    forgetAgentTerminal("s2");
  });

  it("démarre vide", () => {
    const snap = getAgentTerminal(S);
    expect(snap.transcript).toBe("");
    expect(snap.commands).toEqual([]);
    expect(snap.running).toBe(false);
  });

  it("enregistre une commande, sa sortie et sa fin", () => {
    agentTerminalCommandStart(S, "npm test");
    agentTerminalOutput(S, "running tests...\n");
    agentTerminalOutput(S, "ok\n");
    agentTerminalCommandEnd(S, 0);

    const snap = getAgentTerminal(S);
    expect(snap.commands).toHaveLength(1);
    expect(snap.commands[0].command).toBe("npm test");
    expect(snap.commands[0].done).toBe(true);
    expect(snap.commands[0].exitCode).toBe(0);
    expect(snap.transcript).toContain("npm test");
    expect(snap.transcript).toContain("running tests...");
    expect(snap.running).toBe(false);
  });

  it("marque running=true tant que la commande tourne", () => {
    agentTerminalCommandStart(S, "sleep 1");
    expect(getAgentTerminal(S).running).toBe(true);
    agentTerminalCommandEnd(S, 0);
    expect(getAgentTerminal(S).running).toBe(false);
  });

  it("signale un code de sortie non nul", () => {
    agentTerminalCommandStart(S, "false");
    agentTerminalCommandEnd(S, 1);
    expect(getAgentTerminal(S).transcript).toContain("exit code 1");
  });

  it("accumule plusieurs commandes dans l'ordre", () => {
    agentTerminalCommandStart(S, "a");
    agentTerminalCommandEnd(S, 0);
    agentTerminalCommandStart(S, "b");
    agentTerminalCommandEnd(S, 0);
    const cmds = getAgentTerminal(S).commands;
    expect(cmds.map(c => c.command)).toEqual(["a", "b"]);
  });

  it("garde les sessions isolées (multitâche)", () => {
    agentTerminalCommandStart(S, "task A");
    agentTerminalCommandStart("s2", "task B");
    expect(getAgentTerminal(S).commands[0].command).toBe("task A");
    expect(getAgentTerminal("s2").commands[0].command).toBe("task B");
  });

  it("ignore une sortie vide sans créer de session", () => {
    agentTerminalOutput(S, "");
    // pas de mutation : le snapshot reste la référence vide partagée
    expect(getAgentTerminal(S).transcript).toBe("");
  });

  it("clear vide le transcript mais conserve la session", () => {
    agentTerminalCommandStart(S, "x");
    agentTerminalOutput(S, "out");
    clearAgentTerminal(S);
    const snap = getAgentTerminal(S);
    expect(snap.transcript).toBe("");
    expect(snap.commands).toEqual([]);
  });

  it("forget supprime la session", () => {
    agentTerminalCommandStart(S, "x");
    forgetAgentTerminal(S);
    expect(getAgentTerminal(S).transcript).toBe("");
  });

  it("expose une référence stable tant que rien ne change", () => {
    const a = getAgentTerminal(S);
    const b = getAgentTerminal(S);
    expect(a).toBe(b);
    agentTerminalCommandStart(S, "y");
    expect(getAgentTerminal(S)).not.toBe(a);
  });
});
