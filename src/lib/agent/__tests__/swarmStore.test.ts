import { describe, it, expect, beforeEach } from "vitest";
import {
  startSubAgent,
  stepSubAgent,
  endSubAgent,
  listSubAgents,
  listActiveSubAgents,
  clearSubAgents,
  GLOBAL_SESSION_KEY,
} from "../swarmStore";

// Le registre est un singleton module-level : on purge entre les tests.
beforeEach(() => {
  clearSubAgents();
});

function start(sessionKey: string, spawnId: string, task = "t") {
  startSubAgent(sessionKey, { spawnId, role: "explorer", task });
}

describe("swarmStore — isolation par session (multitasking)", () => {
  it("ne mélange pas les sous-agents de deux sessions", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    start("sess-B", "b2");

    expect(listSubAgents("sess-A").map(s => s.spawnId)).toEqual(["a1"]);
    expect(listSubAgents("sess-B").map(s => s.spawnId).sort()).toEqual(["b1", "b2"]);
  });

  it("la vue globale agrège toutes les sessions", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    expect(listSubAgents().map(s => s.spawnId).sort()).toEqual(["a1", "b1"]);
    expect(listSubAgents(GLOBAL_SESSION_KEY).length).toBe(2);
  });

  it("clearSubAgents(session) ne purge QUE cette session", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    clearSubAgents("sess-A");

    expect(listSubAgents("sess-A")).toEqual([]);
    expect(listSubAgents("sess-B").map(s => s.spawnId)).toEqual(["b1"]);
  });

  it("clearSubAgents() sans clé purge tout", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    clearSubAgents();
    expect(listSubAgents().length).toBe(0);
    expect(listSubAgents("sess-A").length).toBe(0);
  });

  it("stepSubAgent n'affecte que la session ciblée", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    stepSubAgent("sess-B", "b1", 5);

    expect(listSubAgents("sess-A")[0].iterations).toBe(0);
    expect(listSubAgents("sess-B")[0].iterations).toBe(5);
  });

  it("stepSubAgent ignore un spawnId inconnu (pas de création fantôme)", () => {
    stepSubAgent("sess-A", "ghost", 3);
    expect(listSubAgents("sess-A")).toEqual([]);
  });

  it("endSubAgent marque le statut dans la bonne session", () => {
    start("sess-A", "a1");
    start("sess-B", "b1");
    endSubAgent("sess-A", "a1", {
      status: "completed", report: "ok", iterations: 2, inputTokens: 10, outputTokens: 20,
    });

    const a = listSubAgents("sess-A")[0];
    expect(a.status).toBe("completed");
    expect(a.report).toBe("ok");
    expect(a.inputTokens).toBe(10);
    // La session B reste intacte.
    expect(listSubAgents("sess-B")[0].status).toBeUndefined();
  });

  it("endSubAgent sur une session sans l'agent est un no-op", () => {
    start("sess-A", "a1");
    endSubAgent("sess-B", "a1", {
      status: "completed", report: "x", iterations: 0, inputTokens: 0, outputTokens: 0,
    });
    expect(listSubAgents("sess-A")[0].status).toBeUndefined();
    expect(listSubAgents("sess-B")).toEqual([]);
  });

  it("listActiveSubAgents filtre par session et exclut les terminés", () => {
    start("sess-A", "a1");
    start("sess-A", "a2");
    endSubAgent("sess-A", "a1", {
      status: "completed", report: "", iterations: 0, inputTokens: 0, outputTokens: 0,
    });
    expect(listActiveSubAgents("sess-A").map(s => s.spawnId)).toEqual(["a2"]);
    expect(listActiveSubAgents("sess-B")).toEqual([]);
  });

  it("référence de liste stable tant qu'aucune mutation (contrat useSyncExternalStore)", () => {
    start("sess-A", "a1");
    const first = listSubAgents("sess-A");
    const second = listSubAgents("sess-A");
    expect(second).toBe(first);

    // Une mutation invalide le cache → nouvelle référence.
    start("sess-A", "a2");
    const third = listSubAgents("sess-A");
    expect(third).not.toBe(first);
  });

  it("le cache global et le cache par session sont indépendants", () => {
    start("sess-A", "a1");
    const bySession = listSubAgents("sess-A");
    const global = listSubAgents();
    expect(bySession).not.toBe(global);
    expect(global.map(s => s.spawnId)).toEqual(["a1"]);

    start("sess-B", "b1");
    // Le cache global a été invalidé ; celui de A reste cohérent (A n'a pas muté).
    expect(listSubAgents("sess-A")).toEqual(bySession);
    expect(listSubAgents().length).toBe(2);
  });
});
