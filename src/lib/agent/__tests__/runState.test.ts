import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getRun,
  resetRun,
  forgetRun,
  listLiveRuns,
  setRunMessages,
  getRunMessages,
  runDebugSnapshot,
} from "../runState";

const IDS = ["s1", "s2", "s3"];

beforeEach(() => {
  for (const id of IDS) forgetRun(id);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runState — état de run par session (multitasking)", () => {
  it("renvoie un run vierge pour une session inconnue", () => {
    const st = getRun("s1");
    expect(st.cleanup).toBeNull();
    expect(st.seq).toBe(0);
    expect(st.pendingContent).toBe("");
    expect(st.pendingParts).toEqual([]);
    expect(st.dirty).toBe(false);
    expect(st.spawned).toBe(0);
    expect(st.messages).toBeNull();
  });

  it("renvoie TOUJOURS la même instance pour une session (identité stable)", () => {
    expect(getRun("s1")).toBe(getRun("s1"));
  });

  it("isole les états de deux sessions", () => {
    const a = getRun("s1");
    const b = getRun("s2");
    expect(a).not.toBe(b);
    a.seq = 5;
    a.pendingContent = "bonjour";
    expect(b.seq).toBe(0);
    expect(b.pendingContent).toBe("");
  });

  it("tolère null/undefined sans jeter (clé vide)", () => {
    expect(getRun(null).seq).toBe(0);
    expect(getRun(undefined).seq).toBe(0);
    expect(getRun(null)).toBe(getRun(undefined));
  });

  it("resetRun remet à zéro UNE session, sans toucher les autres", () => {
    getRun("s1").seq = 3;
    getRun("s2").seq = 7;
    resetRun("s1");
    expect(getRun("s1").seq).toBe(0);
    expect(getRun("s2").seq).toBe(7);
  });

  it("forgetRun coupe le moteur vivant et supprime l'entrée", () => {
    const st = getRun("s1");
    const abort = vi.fn();
    st.cleanup = abort;
    forgetRun("s1");
    expect(abort).toHaveBeenCalledTimes(1);
    // Nouvelle entrée, vierge.
    expect(getRun("s1").cleanup).toBeNull();
  });

  it("forgetRun libère le timer de flush en attente", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    getRun("s1").flushTimer = setTimeout(() => {}, 10_000);
    forgetRun("s1");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("forgetRun est un no-op sur une session inconnue", () => {
    expect(() => forgetRun("inconnue")).not.toThrow();
  });

  it("listLiveRuns ne liste que les runs au cleanup non nul", () => {
    getRun("s1").cleanup = () => {};
    getRun("s2").cleanup = null;
    expect(listLiveRuns()).toEqual(["s1"]);
  });

  it("mémorise et relit le miroir de messages d'une session", () => {
    expect(getRunMessages("s1")).toBeNull();
    setRunMessages("s1", [{ role: "assistant", content: "hi", streaming: true }]);
    expect(getRunMessages("s1")?.[0].content).toBe("hi");
    // Session distincte : pas de fuite.
    expect(getRunMessages("s2")).toBeNull();
  });

  it("runDebugSnapshot reflète l'état réel", () => {
    const st = getRun("s1");
    st.seq = 4;
    st.dirty = true;
    st.spawned = 2;
    st.cleanup = () => {};
    expect(runDebugSnapshot("s1")).toEqual({ seq: 4, alive: true, dirty: true, spawned: 2 });
  });
});
