import { describe, it, expect } from "vitest";
import {
  translateClineLine,
  translateClineControlLine,
  createClineRunState,
} from "../clineBridge";

// ── Contrat de transport du sidecar → pont ────────────────────────────────────
//
// Régression verrouillée : le sidecar n'émet PAS un `CoreSessionEvent` nu. Il
// enrobe chaque événement dans un message NDJSON
//   `{ kind: "event", event: <CoreSessionEvent> }`
// et le `CoreSessionEvent` a lui-même la forme
//   `{ type: "agent_event", payload: { sessionId, event, teamAgentId?, teamRole? } }`.
//
// Si le pont oublie de dépiauter le `kind`, `envelope.type` vaut `undefined` et
// AUCUN événement n'est traduit : l'UI reste muette alors que le moteur travaille.
// Ces tests verrouillent le chemin réel (transport sidecar), pas une forme idéale.

/** Construit la ligne NDJSON telle que le sidecar la produirait. */
function sidecarLine(agentEvent: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "event",
    event: {
      type: "agent_event",
      payload: { sessionId: "sess-1", event: agentEvent, ...extra },
    },
  });
}

describe("clineBridge — traduction de la forme réelle du sidecar", () => {
  it("traduit un token contenu dans l'enveloppe { kind, event } du sidecar", () => {
    const state = createClineRunState("glm-5.3-flash");
    const events = translateClineLine(
      sidecarLine({ type: "content_start", contentType: "text", text: "Bonjour" }),
      state,
    );
    expect(events).toEqual([{ type: "token", delta: "Bonjour", spawnId: undefined }]);
  });

  it("traduit un tool-call (contentType: 'tool')", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      sidecarLine({ type: "content_start", contentType: "tool", toolName: "read_files", toolCallId: "tc-1", input: { paths: ["a.ts"] } }),
      state,
    );
    expect(events).toEqual([
      { type: "tool-call", id: "tc-1", toolName: "read_files", args: { paths: ["a.ts"] }, spawnId: undefined },
    ]);
  });

  it("traduit un tool-result (content_end contentType: 'tool')", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      sidecarLine({ type: "content_end", contentType: "tool", toolName: "read_files", toolCallId: "tc-1", output: "contenu" }),
      state,
    );
    expect(events).toEqual([
      { type: "tool-result", id: "tc-1", toolName: "read_files", result: "contenu", spawnId: undefined },
    ]);
  });

  it("produit timing PUIS finish sur un `done` (ordre stable)", () => {
    const state = createClineRunState("glm-5.3-flash");
    // Un contenu d'abord, pour que le TTFT ne soit pas « -1 ».
    translateClineLine(sidecarLine({ type: "content_start", contentType: "text", text: "ok" }), state);
    const events = translateClineLine(
      sidecarLine({ type: "done", reason: "completed", usage: { inputTokens: 12, outputTokens: 3 } }),
      state,
    );
    expect(events.map(e => e.type)).toEqual(["timing", "finish"]);
    const finish = events.find(e => e.type === "finish");
    expect(finish).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it("route un flux de sous-agent via `teamAgentId` (mode IA / teams)", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      sidecarLine(
        { type: "content_start", contentType: "text", text: "rapport partiel" },
        { teamAgentId: "explorer", teamRole: "teammate" },
      ),
      state,
    );
    expect(events).toEqual([{ type: "token", delta: "rapport partiel", spawnId: "explorer" }]);
  });

  it("route un flux de sous-agent via `parentAgentId` (spawn d'agent hors team)", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      sidecarLine({ type: "content_start", contentType: "text", text: "x", parentAgentId: "agent-7" }),
      state,
    );
    expect(events).toEqual([{ type: "token", delta: "x", spawnId: "agent-7" }]);
  });

  it("accepte AUSSI un CoreSessionEvent nu (usage tests unitaires)", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      { type: "agent_event", payload: { sessionId: "s", event: { type: "content_start", contentType: "text", text: "nu" } } },
      state,
    );
    expect(events).toEqual([{ type: "token", delta: "nu", spawnId: undefined }]);
  });

  it("ignore silencieusement une ligne illisible", () => {
    const state = createClineRunState("m");
    expect(translateClineLine("{ pas du json", state)).toEqual([]);
  });

  it("ignore un `kind` inconnu (ex. chunk de transport)", () => {
    const state = createClineRunState("m");
    expect(translateClineLine(JSON.stringify({ kind: "ready", pid: 1 }), state)).toEqual([]);
  });
});

// ── Cycle de vie des coéquipiers (`team_progress`, mode IA) ───────────────────
//
// En mode IA, le SDK n'émet PAS de `spawn_agent` : le cycle de vie des
// coéquipiers arrive exclusivement par `team_progress.lifecycle`. Sans ce
// mapping, les sous-agents restent invisibles (0 carte, 0 progression) alors que
// le moteur travaille — c'est le bug « rien pour le suivi » qui a motivé le Lot 6.
// Formes verrouillées ici = celles observées sur banc réel (banc-lot6-dump.json).

describe("clineBridge — cycle de vie des équipes (`team_progress`)", () => {
  /** Construit la ligne NDJSON d'un `team_progress` telle qu'émise par le sidecar. */
  function teamLine(lifecycle: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      kind: "event",
      event: {
        type: "team_progress",
        payload: {
          sessionId: "sess-1",
          teamName: "team-WHZPY",
          lifecycle: { teamName: "team-WHZPY", sessionId: "sess-1", ...lifecycle },
          summary: { members: { total: 2, leadCount: 1, teammateCount: 1 } },
          ...extra,
        },
      },
    });
  }

  it("`teammate_spawned` → subagent-start (création de la carte)", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      teamLine({ eventType: "teammate_spawned", agentId: "explorer", ts: "t" }),
      state,
    );
    expect(events).toEqual([{ type: "subagent-start", spawnId: "explorer", role: "explorer", task: "" }]);
  });

  it("`run_started` → subagent-start avec `toolCallId = runId` (rattachement au tool-call parent)", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      teamLine({ eventType: "run_started", agentId: "explorer", runId: "run_00001", message: "Explorer la base de code" }),
      state,
    );
    expect(events).toEqual([
      { type: "subagent-start", spawnId: "explorer", role: "explorer", task: "Explorer la base de code", toolCallId: "run_00001" },
    ]);
  });

  it("`run_progress` → subagent-step avec l'itération extraite du message", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      teamLine({ eventType: "run_progress", agentId: "explorer", runId: "run_00001", message: "iteration_3_started" }),
      state,
    );
    expect(events).toEqual([{ type: "subagent-step", spawnId: "explorer", iteration: 3 }]);
  });

  it("`run_completed` → subagent-end completed", () => {
    const state = createClineRunState("m");
    const events = translateClineLine(
      teamLine({ eventType: "run_completed", agentId: "explorer", runId: "run_00001", message: "terminé" }),
      state,
    );
    expect(events).toEqual([
      { type: "subagent-end", spawnId: "explorer", status: "completed", report: "terminé", iterations: 0, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("`run_failed` → subagent-end error ; `run_cancelled` → cancelled", () => {
    const state = createClineRunState("m");
    const failed = translateClineLine(teamLine({ eventType: "run_failed", agentId: "a" }), state);
    const cancelled = translateClineLine(teamLine({ eventType: "run_cancelled", agentId: "a" }), state);
    expect(failed[0]).toMatchObject({ type: "subagent-end", status: "error" });
    expect(cancelled[0]).toMatchObject({ type: "subagent-end", status: "cancelled" });
  });

  it("`agent_event` (contenu du coéquipier) → aucun sous-événement (déjà routé par teamAgentId)", () => {
    const state = createClineRunState("m");
    expect(translateClineLine(teamLine({ eventType: "agent_event", agentId: "explorer" }), state)).toEqual([]);
  });

  it("ignore un lifecycle sans `agentId` (bruit d'orchestration du lead)", () => {
    const state = createClineRunState("m");
    expect(translateClineLine(teamLine({ eventType: "run_progress", message: "iteration_1_started" }), state)).toEqual([]);
  });

  it("ignore un `team_progress` sans lifecycle exploitable", () => {
    const state = createClineRunState("m");
    expect(translateClineLine(JSON.stringify({ kind: "event", event: { type: "team_progress", payload: {} } }), state)).toEqual([]);
  });

  it("un `done` de COÉQUIPIER clôt SA carte (subagent-end) — PAS le tour global", () => {
    const state = createClineRunState("m");
    // Régression : le coéquipier émet son propre `done`. S'il était traité comme
    // la fin du tour, l'UI se figerait au milieu de l'orchestration du root.
    const events = translateClineLine(
      sidecarLine(
        { type: "done", reason: "completed", text: "rapport du coéquipier", iterations: 2, usage: { inputTokens: 5, outputTokens: 3 } },
        { teamAgentId: "explorer", teamRole: "teammate" },
      ),
      state,
    );
    expect(events).toEqual([
      { type: "subagent-end", spawnId: "explorer", status: "completed", report: "rapport du coéquipier", iterations: 2, inputTokens: 5, outputTokens: 3 },
    ]);
    expect(events.some(e => e.type === "finish")).toBe(false);
  });
});

describe("clineBridge — reconnaissance des demandes bloquantes", () => {
  it("reconnaît une demande d'approbation (kind: 'tool_approval')", () => {
    const control = translateClineControlLine(
      JSON.stringify({ kind: "tool_approval", requestId: "r1", toolName: "run_commands", toolCallId: "tc-9", input: { command: "ls" } }),
    );
    expect(control).toMatchObject({
      kind: "tool_approval",
      request: { requestId: "r1", toolName: "run_commands", toolCallId: "tc-9", input: { command: "ls" } },
    });
  });

  it("reconnaît une notification d'écriture (kind: 'tool_write')", () => {
    const control = translateClineControlLine(
      JSON.stringify({ kind: "tool_write", requestId: "w1", paths: ["/ws/a.ts"] }),
    );
    expect(control).toMatchObject({ kind: "tool_write", request: { requestId: "w1", paths: ["/ws/a.ts"] } });
  });

  it("ne confond PAS une ligne d'événement avec une demande bloquante", () => {
    const control = translateClineControlLine(sidecarLine({ type: "content_start", contentType: "text", text: "x" }));
    expect(control).toBeNull();
  });
});
