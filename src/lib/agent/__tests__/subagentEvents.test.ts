import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Contrat d'émission d'events du sous-agent ──────────────────────────────────
//
// Régression verrouillée : le `spawnId` appartient à l'HÔTE. Le moteur du
// sous-agent ne doit PAS ré-émettre `subagent-start` (sinon deux entrées dans
// le store → carte fantôme bloquée « Working », suivi cassé). Il doit en
// revanche router ses events avec le `spawnId` fourni, et émettre un
// `subagent-step` à chaque tour pour que la progression soit visible.

// Le mock capture les events que `runSubAgent` re-route vers l'hôte.
const emitted: Array<Record<string, unknown>> = [];

vi.mock("../run", () => ({
  runAgent: (opts: { onEvent: (e: unknown) => void; onSettled?: (s: string) => void }) => {
    // Simule deux tours : un step-finish puis du texte, puis la fin.
    queueMicrotask(() => {
      opts.onEvent({ type: "step-finish" });
      opts.onEvent({ type: "token", delta: "un rapport concret et exploitable avec des détails" });
      opts.onEvent({ type: "finish", usage: { inputTokens: 10, outputTokens: 5 } });
      opts.onSettled?.("completed");
    });
    return { cancel: () => {}, status: () => "completed" as const };
  },
}));

import { runSubAgent } from "../subagent";

beforeEach(() => { emitted.length = 0; });

describe("runSubAgent — contrat d'events", () => {
  it("n'émet JAMAIS subagent-start (réservé à l'hôte)", async () => {
    await runSubAgent({
      model: {} as never, folderPath: "/ws", spawnId: "sub-42",
      role: "explore", task: "trouve X", onEvent: (e) => emitted.push(e as never),
    });
    expect(emitted.some(e => e.type === "subagent-start")).toBe(false);
  });

  it("route ses events avec le spawnId FOURNI par l'hôte", async () => {
    await runSubAgent({
      model: {} as never, folderPath: "/ws", spawnId: "sub-42",
      role: "explore", task: "trouve X", onEvent: (e) => emitted.push(e as never),
    });
    const routed = emitted.filter(e => e.type === "token" || e.type === "subagent-end");
    expect(routed.length).toBeGreaterThan(0);
    for (const e of routed) expect(e.spawnId).toBe("sub-42");
  });

  it("émet un subagent-step routé à chaque tour (suivi de progression)", async () => {
    await runSubAgent({
      model: {} as never, folderPath: "/ws", spawnId: "sub-42",
      role: "explore", task: "trouve X", onEvent: (e) => emitted.push(e as never),
    });
    const steps = emitted.filter(e => e.type === "subagent-step");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toMatchObject({ spawnId: "sub-42", iteration: 1 });
  });

  it("clôt par un subagent-end portant le bon spawnId et le rapport", async () => {
    await runSubAgent({
      model: {} as never, folderPath: "/ws", spawnId: "sub-42",
      role: "explore", task: "trouve X", onEvent: (e) => emitted.push(e as never),
    });
    const end = emitted.find(e => e.type === "subagent-end");
    expect(end).toMatchObject({ spawnId: "sub-42" });
    expect(String(end?.report)).toContain("rapport concret");
  });
});
