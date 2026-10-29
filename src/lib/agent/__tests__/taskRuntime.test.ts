import { describe, it, expect, beforeEach } from "vitest";
import {
  setTaskStatus,
  getTaskStatus,
  getTaskSnapshot,
  beginTaskRun,
  markTaskWaiting,
  markTaskRunning,
  abortTaskRun,
  isTaskActive,
  listActiveTasks,
  listTaskSnapshots,
  forgetTask,
} from "../taskRuntime";

// Le registre est un singleton module-level : on purge les sessions utilisées
// avant chaque test pour garantir l'isolation.
const IDS = ["s1", "s2", "s3"];

beforeEach(() => {
  for (const id of IDS) forgetTask(id);
});

describe("setTaskStatus / getTaskStatus", () => {
  it("renvoie `idle` pour une session inconnue", () => {
    expect(getTaskStatus("s1")).toBe("idle");
    expect(getTaskStatus(null)).toBe("idle");
    expect(getTaskStatus(undefined)).toBe("idle");
  });

  it("enregistre une transition de statut", () => {
    setTaskStatus("s1", "running");
    expect(getTaskStatus("s1")).toBe("running");
  });

  it("conserve waitingTool en statut waiting", () => {
    setTaskStatus("s1", "waiting", "run_commands");
    expect(getTaskSnapshot("s1").waitingTool).toBe("run_commands");
    expect(getTaskSnapshot("s1").status).toBe("waiting");
  });

  it("efface waitingTool quand on quitte waiting", () => {
    setTaskStatus("s1", "waiting", "run_commands");
    setTaskStatus("s1", "running");
    expect(getTaskSnapshot("s1").waitingTool).toBeUndefined();
  });
});

describe("beginTaskRun", () => {
  it("passe la session en `running`", () => {
    beginTaskRun("s1");
    expect(getTaskStatus("s1")).toBe("running");
  });

  it("`complete` marque completed et libère le handle d'abort", () => {
    const run = beginTaskRun("s1");
    let aborted = false;
    run.setAbort(() => { aborted = true; });
    run.complete();
    expect(getTaskStatus("s1")).toBe("completed");
    // Le handle étant libéré, un abort ultérieur ne doit rien couper.
    abortTaskRun("s1");
    expect(aborted).toBe(false);
  });

  it("`interrupt` marque interrupted et libère le handle d'abort", () => {
    const run = beginTaskRun("s1");
    run.setAbort(() => {});
    run.interrupt();
    expect(getTaskStatus("s1")).toBe("interrupted");
  });
});

describe("abortTaskRun", () => {
  it("appelle l'abort enregistré puis marque interrupted", () => {
    const run = beginTaskRun("s1");
    let aborted = false;
    run.setAbort(() => { aborted = true; });
    abortTaskRun("s1");
    expect(aborted).toBe(true);
    expect(getTaskStatus("s1")).toBe("interrupted");
  });

  it("ne jette pas pour une session inconnue", () => {
    expect(() => abortTaskRun("s1")).not.toThrow();
  });
});

describe("isTaskActive / listActiveTasks", () => {
  it("considère running et waiting comme actifs", () => {
    setTaskStatus("s1", "running");
    setTaskStatus("s2", "waiting", "editor");
    setTaskStatus("s3", "completed");
    expect(isTaskActive("s1")).toBe(true);
    expect(isTaskActive("s2")).toBe(true);
    expect(isTaskActive("s3")).toBe(false);
  });

  it("plusieurs tâches peuvent tourner en parallèle", () => {
    beginTaskRun("s1");
    beginTaskRun("s2");
    const active = listActiveTasks().map(t => t.sessionId).sort();
    expect(active).toEqual(["s1", "s2"]);
  });

  it("exclut completed / interrupted / idle de la liste active", () => {
    setTaskStatus("s1", "completed");
    setTaskStatus("s2", "interrupted");
    setTaskStatus("s3", "idle");
    expect(listActiveTasks()).toHaveLength(0);
  });
});

describe("markTaskWaiting / markTaskRunning", () => {
  it("bascule running → waiting → running sans perdre le suivi", () => {
    beginTaskRun("s1");
    markTaskWaiting("s1", "run_commands");
    expect(getTaskStatus("s1")).toBe("waiting");
    expect(isTaskActive("s1")).toBe(true);
    markTaskRunning("s1");
    expect(getTaskStatus("s1")).toBe("running");
  });
});

describe("forgetTask", () => {
  it("coupe un run vivant et supprime la session du registre", () => {
    const run = beginTaskRun("s1");
    let aborted = false;
    run.setAbort(() => { aborted = true; });
    forgetTask("s1");
    expect(aborted).toBe(true);
    expect(getTaskStatus("s1")).toBe("idle");
  });
});

describe("listTaskSnapshots", () => {
  it("trie du plus récent au plus ancien", () => {
    setTaskStatus("s1", "running");
    setTaskStatus("s2", "running");
    // La plus récente mutation (s2) doit arriver en tête.
    const ids = listTaskSnapshots().map(t => t.sessionId);
    expect(ids.indexOf("s2")).toBeLessThan(ids.indexOf("s1"));
  });

  it("renvoie une référence stable tant que rien ne change", () => {
    setTaskStatus("s1", "running");
    expect(listTaskSnapshots()).toBe(listTaskSnapshots());
  });

  it("change de référence après une mutation", () => {
    setTaskStatus("s1", "running");
    const before = listTaskSnapshots();
    setTaskStatus("s1", "completed");
    expect(listTaskSnapshots()).not.toBe(before);
  });
});
