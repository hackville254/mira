// ── Benchmark de codage — tests déterministes du HARNAIS ──────────────────────
//
// Ces tests ne font AUCUN appel réseau : ils valident que l'évaluateur, le
// runner et la validation de tâches se comportent correctement, à l'aide de
// drivers factices déterministes (un qui corrige, un qui ne corrige pas).
//
// Ce qu'ils prouvent : le harnais mesure bien l'ÉTAT FINAL du dépôt par les
// tests, distingue un succès d'un échec, classe les erreurs et nettoie ses
// dossiers temporaires. Ce qu'ils NE prouvent PAS : la qualité d'un modèle.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, readFile, writeFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTaskOnce, runTask, type AgentDriver } from "../../../../bench/coding/runner";
import { loadTask, loadTasks, validateTask } from "../../../../bench/coding/tasks";
import { parseTestOutcomes, runTestCommand } from "../../../../bench/coding/evaluator";
import { summarize, formatTable, writeReport, type BenchReport } from "../../../../bench/coding/report";
import { validateInstance, toCodingTask } from "../../../../bench/coding/swebench/instance";
import type { AttemptResult } from "../../../../bench/coding/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(HERE, "..", "..", "..", "..", "bench", "coding", "tasks");

const tmpDirs: string[] = [];
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tmpDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Driver factice qui applique une transformation aux fichiers du workdir. */
function fakeDriver(
  id: string,
  patch: (workdir: string) => Promise<void>,
  meta: { turns?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number } = {},
): AgentDriver {
  return {
    id,
    async run({ workdir }) {
      await patch(workdir);
      return meta;
    },
  };
}

/** Driver factice qui échoue (simule une erreur d'agent). */
function failingDriver(id: string): AgentDriver {
  return { id, async run() { throw new Error("provider exploded"); } };
}

/** Driver factice qui ignore le signal et dépasse toujours son budget. */
function hangingDriver(id: string): AgentDriver {
  return {
    id,
    run({ timeoutMs }) {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`agent timeout after ${timeoutMs} ms`)), timeoutMs + 50);
      });
    },
  };
}

// Une correction déterministe de la tâche bugfix-sum-negatives.
const fixSum = (workdir: string): Promise<void> =>
  writeFile(join(workdir, "src/math.mjs"), "export function sum(a, b) { return a + b; }\n", "utf8");

// ── Chargement / validation des tâches ────────────────────────────────────────

describe("chargement des tâches", () => {
  it("charge toutes les tâches versionnées et respecte le contrat", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of tasks) {
      expect(t.id).toBeTruthy();
      expect(t.criteria.failToPass.length).toBeGreaterThan(0);
      expect(t.agentTimeoutMs).toBeGreaterThan(0);
      // Chaque tâche doit avoir une fixture présente.
      await expect(access(join(TASKS_DIR, t.id, "fixture"))).resolves.toBeUndefined();
    }
    // Tri stable par id.
    const ids = tasks.map(t => t.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });

  it("rejette une tâche invalide (failToPass vide)", () => {
    expect(() => validateTask({
      id: "x", title: "x", kind: "bugfix", instruction: "x",
      testCommand: "node --test", criteria: { failToPass: [], passToPass: [] },
      agentTimeoutMs: 1, testTimeoutMs: 1,
    }, "test")).toThrow(/failToPass/);
  });

  it("rejette une catégorie inconnue", () => {
    expect(() => validateTask({
      id: "x", title: "x", kind: "nope", instruction: "x",
      testCommand: "node --test", criteria: { failToPass: ["a"], passToPass: [] },
      agentTimeoutMs: 1, testTimeoutMs: 1,
    }, "test")).toThrow(/kind/);
  });
});

// ── Parseur de sortie de tests ────────────────────────────────────────────────

describe("parseTestOutcomes", () => {
  it("reconnaît le format symboles de node --test (✔/✖)", () => {
    const out = parseTestOutcomes(
      "✔ sum adds two positive numbers (0.29ms)\n✖ sum returns the arithmetic sum with a negative operand (0.37ms)",
      "",
    );
    expect(out.get("sum adds two positive numbers")).toBe(true);
    expect(out.get("sum returns the arithmetic sum with a negative operand")).toBe(false);
  });

  it("reconnaît le format TAP (ok / not ok)", () => {
    const out = parseTestOutcomes("ok 1 - alpha\nnot ok 2 - beta\n", "");
    expect(out.get("alpha")).toBe(true);
    expect(out.get("beta")).toBe(false);
  });

  it("reconnaît les marqueurs vitest (✓/×)", () => {
    const out = parseTestOutcomes("  ✓ does a thing 12ms\n  × does another 3ms", "");
    expect(out.get("does a thing")).toBe(true);
    expect(out.get("does another")).toBe(false);
  });

  it("reconnaît la sortie pytest -rA (PASSED/FAILED) et réduit le nom", () => {
    const out = parseTestOutcomes(
      [
        "PASSED astropy/modeling/tests/test_separable.py::test_coord_matrix",
        "PASSED astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]",
        "FAILED astropy/modeling/tests/test_separable.py::test_separable[compound_model9-result9]",
        "ERROR astropy/modeling/tests/test_separable.py::test_arith_oper - AttributeError",
      ].join("\n"),
      "",
    );
    expect(out.get("test_coord_matrix")).toBe(true);
    expect(out.get("test_separable[compound_model6-result6]")).toBe(true);
    expect(out.get("test_separable[compound_model9-result9]")).toBe(false);
    expect(out.get("test_arith_oper")).toBe(false);
  });
});

// ── SWE-bench réel : loader et convertisseur de tâche ─────────────────────────

describe("SWE-bench — instance réelle → CodingTask", () => {
  const SWE_DIR = join(HERE, "..", "..", "..", "..", "bench", "coding", "swebench", "instances");
  const ASTROPY = join(SWE_DIR, "astropy__astropy-12907.json");

  it("charge et valide une instance réelle du dataset", async () => {
    const raw = JSON.parse(await readFile(ASTROPY, "utf8"));
    const inst = validateInstance(raw, ASTROPY);
    expect(inst.instance_id).toBe("astropy__astropy-12907");
    expect(inst.repo).toBe("astropy/astropy");
    expect(inst.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(inst.FAIL_TO_PASS.length).toBeGreaterThan(0);
  });

  it("convertit en CodingTask aux critères fidèles (noms de tests réduits)", async () => {
    const raw = JSON.parse(await readFile(ASTROPY, "utf8"));
    const task = toCodingTask(validateInstance(raw, ASTROPY));
    expect(task.id).toBe("astropy__astropy-12907");
    expect(task.criteria.failToPass).toContain("test_separable[compound_model6-result6]");
    expect(task.criteria.failToPass).toContain("test_separable[compound_model9-result9]");
    expect(task.criteria.passToPass).toContain("test_coord_matrix");
    expect(task.testCommand).toMatch(/pytest/);
    // L'instruction ne doit JAMAIS divulguer le patch oracle.
    expect(task.instruction).not.toContain("cright");
  });

  it("refuse une instance au repo malformé", () => {
    expect(() => validateInstance({ instance_id: "x", repo: "pas-de-slash", base_commit: "abcdef1",
      problem_statement: "p", test_patch: "", FAIL_TO_PASS: ["a"], PASS_TO_PASS: [] }, "test")).toThrow();
  });

  it("refuse une instance sans FAIL_TO_PASS", () => {
    expect(() => validateInstance({ instance_id: "x", repo: "a/b", base_commit: "abcdef1",
      problem_statement: "p", test_patch: "", FAIL_TO_PASS: [], PASS_TO_PASS: [] }, "test")).toThrow();
  });
});

// ── Runner : succès, échec, erreurs, nettoyage ────────────────────────────────

describe("runTaskOnce — vérification objective par l'état du dépôt", () => {
  it("déclare « resolved » quand l'agent corrige réellement le bug", async () => {
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    const r = await runTaskOnce(task, fakeDriver("fixer", fixSum, { turns: 3, toolCalls: 2 }), { tasksDir: TASKS_DIR });
    expect(r.outcome).toBe("resolved");
    expect(r.failToPass.every(o => o.passed)).toBe(true);
    expect(r.passToPass.every(o => o.passed)).toBe(true);
    expect(r.turns).toBe(3);
    expect(r.toolCalls).toBe(2);
    expect(r.testMs).toBeGreaterThanOrEqual(0);
  });

  it("déclare « unresolved » quand l'agent ne touche à rien", async () => {
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    const r = await runTaskOnce(task, fakeDriver("noop", async () => {}), { tasksDir: TASKS_DIR });
    expect(r.outcome).toBe("unresolved");
    // Le FAIL_TO_PASS n'est pas satisfait ; le PASS_TO_PASS l'est.
    expect(r.failToPass.some(o => !o.passed)).toBe(true);
    expect(r.passToPass.every(o => o.passed)).toBe(true);
  });

  it("classe une exception du driver en « agent-error »", async () => {
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    const r = await runTaskOnce(task, failingDriver("boom"), { tasksDir: TASKS_DIR });
    expect(r.outcome).toBe("agent-error");
    expect(r.error).toMatch(/provider exploded/);
  });

  it("classe un dépassement de budget en « agent-error » avec message de timeout", async () => {
    const task = { ...(await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"))), agentTimeoutMs: 150 };
    const r = await runTaskOnce(task, hangingDriver("slow"), { tasksDir: TASKS_DIR });
    expect(r.outcome).toBe("agent-error");
    expect(r.error).toMatch(/timeout/);
  });

  it("nettoie le dossier temporaire après chaque tentative", async () => {
    const root = await mkdtemp(join(tmpdir(), "orvyx-bench-test-"));
    tmpDirs.push(root);
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    await runTaskOnce(task, fakeDriver("fixer", fixSum), { tasksDir: TASKS_DIR, tmpRoot: root });
    expect(await readdir(root)).toEqual([]);
  });

  it("repart d'un état initial frais à chaque répétition", async () => {
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    // Le driver de la 1re passe corrige, celui de la 2e ne fait rien :
    // si l'état était partagé, la 2e passe serait « resolved » à tort.
    let call = 0;
    const toggling: AgentDriver = {
      id: "toggle",
      async run({ workdir }) {
        call += 1;
        if (call === 1) await fixSum(workdir);
      },
    };
    const rs = await runTask(task, toggling, { tasksDir: TASKS_DIR, runs: 2 });
    expect(rs.map(r => r.run)).toEqual([1, 2]);
    expect(rs[0].error).toBeUndefined();
    expect(rs[0].outcome).toBe("resolved");
    expect(rs[1].outcome).toBe("unresolved");
  });
});

// ── Isolation : la fixture n'est jamais modifiée sur disque ───────────────────

describe("runTaskOnce — la fixture source reste intacte", () => {
  it("ne modifie pas la fixture d'origine", async () => {
    const fixtureFile = join(TASKS_DIR, "bugfix-sum-negatives", "fixture", "src", "math.mjs");
    const before = await readFile(fixtureFile, "utf8");
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    await runTaskOnce(task, fakeDriver("fixer", fixSum), { tasksDir: TASKS_DIR });
    expect(await readFile(fixtureFile, "utf8")).toBe(before);
  });
});

// ── Exécution réelle des tests (node --test local, sans réseau) ───────────────

describe("runTestCommand — exécution réelle hors ligne", () => {
  it("exécute node --test et renvoie un code de sortie exploitable", async () => {
    const task = await loadTask(join(TASKS_DIR, "bugfix-sum-negatives", "task.json"));
    const res = await runTestCommand(task, join(TASKS_DIR, "bugfix-sum-negatives", "fixture"));
    // État initial buggé : au moins un test échoue → exit != 0.
    expect(res.exitCode).not.toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Agrégation du rapport ─────────────────────────────────────────────────────

describe("summarize / formatTable / writeReport", () => {
  const attempts: AttemptResult[] = [
    { taskId: "a", modelId: "m1", run: 1, outcome: "resolved", agentMs: 100, testMs: 10, failToPass: [], passToPass: [], turns: 2, toolCalls: 1, inputTokens: 50, outputTokens: 20 },
    { taskId: "b", modelId: "m1", run: 1, outcome: "unresolved", agentMs: 200, testMs: 12, failToPass: [], passToPass: [], turns: 3, toolCalls: 2, inputTokens: 60, outputTokens: 30 },
    { taskId: "a", modelId: "m2", run: 1, outcome: "agent-error", agentMs: 0, testMs: 0, failToPass: [], passToPass: [], error: "timeout" },
    { taskId: "b", modelId: "m2", run: 1, outcome: "resolved", agentMs: 300, testMs: 15, failToPass: [], passToPass: [] },
  ];

  it("calcule les taux de résolution et ventile les erreurs par modèle", () => {
    const rep = summarize(attempts);
    const m1 = rep.models.find(m => m.modelId === "m1")!;
    const m2 = rep.models.find(m => m.modelId === "m2")!;
    expect(m1.resolved).toBe(1);
    expect(m1.resolvedRate).toBeCloseTo(0.5);
    expect(m1.tokens).toEqual({ input: 110, output: 50 });
    expect(m1.toolCalls).toBe(3);
    expect(m2.byOutcome["agent-error"]).toBe(1);
    expect(m2.resolvedRate).toBeCloseTo(0.5);
    // m1 (50%) et m2 (50%) : tri stable, les deux présents.
    expect(rep.models.map(m => m.modelId).sort()).toEqual(["m1", "m2"]);
    expect(rep.note).toMatch(/PAS un score SWE-bench officiel/);
  });

  it("produit un tableau lisible et écrit un JSON valide", async () => {
    const rep = summarize(attempts, () => "bugfix");
    expect(formatTable(rep)).toContain("modèle");
    const dir = await mkdtemp(join(tmpdir(), "orvyx-rep-"));
    tmpDirs.push(dir);
    const file = join(dir, "nested", "bench.json");
    await writeReport(rep, file);
    const parsed = JSON.parse(await readFile(file, "utf8")) as BenchReport;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.attempts).toHaveLength(4);
  });
});
