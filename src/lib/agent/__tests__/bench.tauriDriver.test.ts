// ── Tests déterministes du driver Tauri du benchmark (partie PURE) ─────────────
//
// `createTauriDriver` ne peut PAS s'exécuter hors de l'app Tauri (les outils de
// production utilisent `invoke` statique). En revanche, la LOGIQUE DE MESURE —
// `reduceEvent` — est pure et testable ici : c'est elle qui garantit la justesse
// des métriques (tours, appels d'outils, erreurs d'outil, tokens, TTFT).
//
// Ces tests ne remplacent PAS un run réel : ils valident que, lorsque les vrais
// événements arrivent, les chiffres reported sont corrects.

import { describe, it, expect } from "vitest";
import { reduceEvent } from "../../../../bench/coding/tauriDriver";
import type { AgentEvent } from "../../agent/run";

/** Agrégat minimal (miroir de la forme interne du driver). */
interface M {
  turns: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  totalMs: number;
  outputChars: number;
  tokPerSec: number;
  fallbacks: number;
  errorMessage?: string;
  callArgs: unknown[];
}

function empty(): M {
  return {
    turns: 0, toolCalls: 0, toolResults: 0, toolErrors: 0,
    inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 0,
    outputChars: 0, tokPerSec: 0, fallbacks: 0, callArgs: [],
  };
}

describe("Niveau C — driver Tauri (réduction d'événements, pure)", () => {
  it("compte les appels et résultats d'outils, et capture les arguments", () => {
    const m = empty();
    reduceEvent(m as never, { type: "tool-call", id: "1", toolName: "read_file", args: { path: "src/a.mjs" } } as AgentEvent);
    reduceEvent(m as never, { type: "tool-result", id: "1", toolName: "read_file", result: { ok: true } } as AgentEvent);
    expect(m.toolCalls).toBe(1);
    expect(m.toolResults).toBe(1);
    expect(m.toolErrors).toBe(0);
    expect(m.callArgs).toEqual([{ path: "src/a.mjs" }]);
  });

  it("marque un échec d'outil quand le résultat porte une erreur explicite", () => {
    const m = empty();
    reduceEvent(m as never, { type: "tool-result", id: "1", toolName: "editor", result: { error: "boom" } } as AgentEvent);
    expect(m.toolResults).toBe(1);
    expect(m.toolErrors).toBe(1);
  });

  it("ne compte PAS un résultat normal comme une erreur", () => {
    const m = empty();
    reduceEvent(m as never, { type: "tool-result", id: "1", toolName: "read_file", result: "contenu" } as AgentEvent);
    expect(m.toolErrors).toBe(0);
  });

  it("capture TTFT, total, débit et replis depuis `timing`", () => {
    const m = empty();
    reduceEvent(m as never, {
      type: "timing", ttftMs: 120, totalMs: 900, genMs: 780,
      outputChars: 400, tokPerSec: 12.5, model: "x", fallbacks: 2,
    } as AgentEvent);
    expect(m.ttftMs).toBe(120);
    expect(m.totalMs).toBe(900);
    expect(m.tokPerSec).toBe(12.5);
    expect(m.fallbacks).toBe(2);
    expect(m.turns).toBe(1);
  });

  it("agrège les tokens accumulés sur plusieurs `finish`", () => {
    const m = empty();
    reduceEvent(m as never, { type: "finish", usage: { inputTokens: 100, outputTokens: 20 } } as AgentEvent);
    reduceEvent(m as never, { type: "finish", usage: { inputTokens: 50, outputTokens: 10 } } as AgentEvent);
    expect(m.inputTokens).toBe(150);
    expect(m.outputTokens).toBe(30);
  });

  it("capture le message d'erreur du provider", () => {
    const m = empty();
    reduceEvent(m as never, { type: "error", message: "429 rate limited" } as AgentEvent);
    expect(m.errorMessage).toBe("429 rate limited");
  });

  it("ignore proprement les événements sans effet sur les métriques", () => {
    const m = empty();
    reduceEvent(m as never, { type: "token", delta: "a" } as AgentEvent);
    reduceEvent(m as never, { type: "step-finish" } as AgentEvent);
    expect(m).toEqual(empty());
  });
});
