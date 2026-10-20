// ── Tests unitaires — benchmark de génération de fonctions (EvalPlus) ─────────
//
// Ces tests utilisent des FIXTURES DÉTERMINISTES uniquement : aucun appel réseau,
// aucun appel modèle, aucune exécution Docker. Ils ne produisent donc JAMAIS de
// « résultat de benchmark » — ils vérifient la mécanique interne (chargement,
// ventilation, métriques, persistance, garde-fous de sécurité).

import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractCode,
  buildTestFile,
  classifyOutcome,
  type GenEvalResult,
} from "../../../../bench/coding/generation/evaluator";
import { classifyAgentRun } from "../../../../bench/coding/generation/agent";
import {
  attemptKey,
  containsApiKey,
  appendAttempt,
  loadExisting,
  loadDoneKeys,
  rewriteAll,
} from "../../../../bench/coding/generation/results";
import {
  summarizeGeneration,
  formatErrorBreakdown,
  type TokenTariff,
} from "../../../../bench/coding/generation/report";
import { selectTasks, DATASET_VERSIONS } from "../../../../bench/coding/generation/dataset";
import type {
  GenerationAttempt,
  GenerationTask,
  ErrorClass,
} from "../../../../bench/coding/generation/types";

const tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orvyx-gen-test-"));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── Fixtures déterministes ────────────────────────────────────────────────────

function task(id: string, benchmark: GenerationTask["benchmark"] = "humanevalplus"): GenerationTask {
  return {
    taskId: id,
    benchmark,
    datasetVersion: DATASET_VERSIONS[benchmark],
    prompt: `def f_${id.replace(/\W/g, "_")}():\n    """spec"""\n`,
    entryPoint: "f",
    test: "def check(candidate):\n    assert candidate() == 1\n\ncheck(f)\n",
    testImports: [],
  };
}

function attempt(over: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    taskId: "HumanEval/0",
    benchmark: "humanevalplus",
    datasetVersion: DATASET_VERSIONS.humanevalplus,
    evalMode: "model-only",
    modelId: "orvyx-code/test-model",
    provider: "orvyx",
    run: 1,
    subset: true,
    resolved: false,
    metrics: { totalMs: 1000, generationMs: 800, evalMs: 200, modelCalls: 1, toolCalls: 0 },
    ...over,
  };
}

function evalRes(over: Partial<GenEvalResult> = {}): GenEvalResult {
  return { passed: true, stdout: "", stderr: "", ...over };
}

// ── extraction de code ────────────────────────────────────────────────────────

describe("extractCode", () => {
  it("extrait le premier bloc python clôturé", () => {
    const r = "Voici :\n```python\ndef f():\n    return 1\n```\nfin";
    expect(extractCode(r)).toBe("def f():\n    return 1");
  });

  it("accepte la fence sans langage", () => {
    expect(extractCode("```\ndef f(): pass\n```")).toBe("def f(): pass");
  });

  it("retombe sur le texte brut sans bloc", () => {
    expect(extractCode("def f(): pass")).toBe("def f(): pass");
  });

  it("ne répare jamais le code (renvoie tel quel)", () => {
    const broken = "```python\ndef f(:\n```";
    expect(extractCode(broken)).toBe("def f(:");
  });
});

// ── assemblage du fichier de test ──────────────────────────────────────────────

describe("buildTestFile", () => {
  it("assemble imports + code candidat + programme officiel", () => {
    const t: GenerationTask = { ...task("MBPP/2", "mbppplus"), testImports: ["import math"], test: "check(f)" };
    const out = buildTestFile(t, "def f(): return 1");
    expect(out).toContain("import math");
    expect(out).toContain("def f(): return 1");
    expect(out).toContain("check(f)");
    // Le programme officiel doit apparaître APRÈS le code candidat.
    expect(out.indexOf("def f(): return 1")).toBeLessThan(out.indexOf("check(f)"));
  });

  it("ignore les imports vides", () => {
    const t: GenerationTask = { ...task("MBPP/3", "mbppplus"), testImports: ["", "  ", "import math"] };
    const out = buildTestFile(t, "x=1");
    // Un seul import non vide doit être conservé.
    expect(out.match(/^import /gm) ?? []).toHaveLength(1);
  });
});

// ── ventilation honnête des erreurs ───────────────────────────────────────────

describe("classifyOutcome — ventilation par origine", () => {
  it("résolu quand les tests officiels passent", () => {
    expect(classifyOutcome({ evalResult: evalRes({ passed: true }), hadCode: true }).resolved).toBe(true);
  });

  it("échec du MODÈLE quand le code s'exécute mais échoue aux tests", () => {
    const r = classifyOutcome({
      evalResult: evalRes({ passed: false, stderr: "AssertionError: 2 != 1" }),
      hadCode: true,
    });
    expect(r.resolved).toBe(false);
    expect(r.errorClass).toBe("model");
  });

  it("N'IMPUTE JAMAIS une erreur fournisseur au modèle", () => {
    const r = classifyOutcome({
      evalResult: evalRes({ passed: false, stderr: "AssertionError" }),
      hadCode: true,
      providerErrorClass: "provider",
      providerError: "HTTP 429",
    });
    expect(r.errorClass).toBe("provider");
  });

  it("classe un timeout d'orchestration comme timeout, pas comme modèle", () => {
    const r = classifyOutcome({ evalResult: evalRes({ passed: false }), hadCode: true, providerErrorClass: "timeout" });
    expect(r.errorClass).toBe("timeout");
  });

  it("classe une réponse tronquée comme truncated", () => {
    const r = classifyOutcome({ evalResult: evalRes({ passed: false }), hadCode: true, providerErrorClass: "truncated" });
    expect(r.errorClass).toBe("truncated");
  });

  it("classe l'absence de sortie comme no-output", () => {
    const r = classifyOutcome({ evalResult: evalRes({ passed: false }), hadCode: false });
    expect(r.errorClass).toBe("no-output");
  });

  it("classe un échec de construction d'image comme harness, pas modèle", () => {
    const r = classifyOutcome({
      evalResult: evalRes({ passed: false, error: "construction de l'image d'évaluation impossible : docker" }),
      hadCode: true,
    });
    expect(r.errorClass).toBe("harness");
  });

  it("classe un dépassement de délai de notation comme timeout", () => {
    const r = classifyOutcome({
      evalResult: evalRes({ passed: false, error: "timeout/limite d'exécution" }),
      hadCode: true,
    });
    expect(r.errorClass).toBe("timeout");
  });
});

// ── classification d'un run agent ─────────────────────────────────────────────

describe("classifyAgentRun — orchestration vs fournisseur", () => {
  const base = { turns: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, ttftMs: 0, totalMs: 10 };

  it("détecte un 429 comme erreur fournisseur", () => {
    expect(classifyAgentRun({ ...base, error: "HTTP 429 rate limit" }, 15).errorClass).toBe("provider");
  });

  it("détecte un timeout", () => {
    expect(classifyAgentRun({ ...base, error: "request aborted" }, 15).errorClass).toBe("timeout");
  });

  it("détecte l'épuisement des itérations comme échec d'orchestration", () => {
    expect(classifyAgentRun({ ...base, turns: 15, maxIterations: 15 } as never, 15).errorClass).toBe("orchestration");
  });

  it("renvoie vide pour un run sain sans erreur", () => {
    expect(classifyAgentRun(base, 15).errorClass).toBeUndefined();
  });
});

// ── persistance JSONL + reprise ────────────────────────────────────────────────

describe("results — persistance et reprise", () => {
  it("attemptKey est stable et discriminant", () => {
    const k1 = attemptKey({ benchmark: "humanevalplus", evalMode: "model-only", modelId: "m", run: 1, taskId: "HumanEval/0" });
    const k2 = attemptKey({ benchmark: "humanevalplus", evalMode: "agent", modelId: "m", run: 1, taskId: "HumanEval/0" });
    expect(k1).not.toBe(k2);
    expect(k1).toBe("humanevalplus::model-only::m::1::HumanEval/0");
  });

  it("écrit puis relit une tentative (append + loadExisting)", async () => {
    const dir = await mkTmp();
    const file = join(dir, "r.jsonl");
    await appendAttempt(file, attempt({ taskId: "HumanEval/1" }));
    const back = await loadExisting(file);
    expect(back).toHaveLength(1);
    expect(back[0].taskId).toBe("HumanEval/1");
  });

  it("reprend une campagne : loadDoneKeys saute les tentatives déjà faites", async () => {
    const dir = await mkTmp();
    const file = join(dir, "r.jsonl");
    await appendAttempt(file, attempt({ taskId: "HumanEval/1" }));
    await appendAttempt(file, attempt({ taskId: "HumanEval/2" }));
    const done = await loadDoneKeys(file);
    expect(done.size).toBe(2);
    expect(done.has(attemptKey({ benchmark: "humanevalplus", evalMode: "model-only", modelId: "orvyx-code/test-model", run: 1, taskId: "HumanEval/2" }))).toBe(true);
  });

  it("ignore les lignes corrompues sans échouer", async () => {
    const dir = await mkTmp();
    const file = join(dir, "r.jsonl");
    await appendAttempt(file, attempt({ taskId: "HumanEval/1" }));
    await writeFile(file, `${await readFile(file, "utf8")}{ ceci n'est pas du JSON\n`, "utf8");
    const back = await loadExisting(file);
    expect(back).toHaveLength(1);
  });

  it("loadExisting renvoie [] si le fichier n'existe pas", async () => {
    expect(await loadExisting(join(await mkTmp(), "absent.jsonl"))).toEqual([]);
  });

  it("rewriteAll réécrit intégralement", async () => {
    const dir = await mkTmp();
    const file = join(dir, "r.jsonl");
    await rewriteAll(file, [attempt({ taskId: "A" }), attempt({ taskId: "B" })]);
    expect((await loadExisting(file)).map(a => a.taskId)).toEqual(["A", "B"]);
  });
});

// ── protection des clés d'API ─────────────────────────────────────────────────

describe("results — garde-fou anti-clé-API", () => {
  /** Enveloppe une tentative dans une ligne de résultat (ce que le garde-fou inspecte). */
  const asLine = (a: GenerationAttempt) => ({
    schemaVersion: 1 as const,
    recordedAt: new Date().toISOString(),
    attempt: a,
  });

  it("détecte une clé orvyx", () => {
    expect(containsApiKey(asLine(attempt({ error: "Bearer oryx_abcdefghijklmnop" })))).toBe(true);
  });

  it("détecte une clé openai sk-", () => {
    expect(containsApiKey(asLine(attempt({ error: "sk-abcdefghijklmnopqrstuvwx" })))).toBe(true);
  });

  it("ne déclenche pas sur un résultat légitime", () => {
    expect(containsApiKey(asLine(attempt({ error: "AssertionError" })))).toBe(false);
  });

  it("REFUSE d'écrire une ligne contenant une clé d'API", async () => {
    const dir = await mkTmp();
    const file = join(dir, "r.jsonl");
    await expect(appendAttempt(file, attempt({ error: "oryx_leaked_key_123456" } as never))).rejects.toThrow(/clé d'API/);
    expect(existsSync(file)).toBe(false);
  });
});

// ── métriques et rapport ──────────────────────────────────────────────────────

describe("summarizeGeneration — métriques", () => {
  it("calcule Pass@1 par groupe", () => {
    const list = [
      attempt({ taskId: "A", resolved: true }),
      attempt({ taskId: "B", resolved: true }),
      attempt({ taskId: "C", resolved: false, errorClass: "model" }),
      attempt({ taskId: "D", resolved: false, errorClass: "model" }),
    ];
    const rep = summarizeGeneration(list);
    expect(rep.groups).toHaveLength(1);
    expect(rep.groups[0].passAt1).toBe(0.5);
    expect(rep.groups[0].byErrorClass.model).toBe(2);
  });

  it("sépare model-only et agent en groupes distincts", () => {
    const rep = summarizeGeneration([
      attempt({ evalMode: "model-only", resolved: true }),
      attempt({ evalMode: "agent", resolved: false, errorClass: "orchestration" }),
    ]);
    expect(rep.groups).toHaveLength(2);
    expect(rep.groups.map(g => g.evalMode).sort()).toEqual(["agent", "model-only"]);
  });

  it("ne fabrique jamais un p95 sous 20 échantillons (renvoie null)", () => {
    const list = Array.from({ length: 5 }, (_, i) => attempt({ taskId: `T${i}`, resolved: true, metrics: { totalMs: 100 + i, generationMs: 100 + i, evalMs: 10, modelCalls: 1, toolCalls: 0 } }));
    const g = summarizeGeneration(list).groups[0];
    expect(g.totalMs.p95).toBeNull();
    expect(g.totalMs.median).toBeGreaterThan(0);
  });

  it("calcule un p95 dès 20 échantillons", () => {
    const list = Array.from({ length: 20 }, (_, i) => attempt({ taskId: `T${i}`, resolved: true, metrics: { totalMs: (i + 1) * 10, generationMs: 1, evalMs: 1, modelCalls: 1, toolCalls: 0 } }));
    expect(summarizeGeneration(list).groups[0].totalMs.p95).not.toBeNull();
  });

  it("laisse le coût INCONNU (null) sans tarif — jamais 0", () => {
    const g = summarizeGeneration([attempt({ resolved: true, metrics: { totalMs: 1, generationMs: 1, evalMs: 0, modelCalls: 1, toolCalls: 0, inputTokens: 100, outputTokens: 50 } })]).groups[0];
    expect(g.estimatedCostUsd).toBeNull();
    expect(g.costPerResolvedUsd).toBeNull();
    expect(g.costSource).toBeNull();
  });

  it("estime le coût quand un tarif explicite est fourni", () => {
    const tariff: TokenTariff = { inputPerMillion: 1, outputPerMillion: 2, source: "test-fixture" };
    const g = summarizeGeneration(
      [attempt({ resolved: true, metrics: { totalMs: 1, generationMs: 1, evalMs: 0, modelCalls: 1, toolCalls: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 } })],
      tariff,
    ).groups[0];
    expect(g.estimatedCostUsd).toBeCloseTo(3, 5);
    expect(g.costPerResolvedUsd).toBeCloseTo(3, 5);
    expect(g.costSource).toBe("test-fixture");
  });

  it("compte les tentatives où les tokens sont absents", () => {
    const g = summarizeGeneration([
      attempt({ taskId: "A", metrics: { totalMs: 1, generationMs: 1, evalMs: 0, modelCalls: 1, toolCalls: 0 } }),
      attempt({ taskId: "B", metrics: { totalMs: 1, generationMs: 1, evalMs: 0, modelCalls: 1, toolCalls: 0, inputTokens: 5, outputTokens: 5 } }),
    ]).groups[0];
    expect(g.tokensMissing).toBe(1);
  });

  it("formate la ventilation des échecs", () => {
    const g = summarizeGeneration([
      attempt({ taskId: "A", resolved: false, errorClass: "model" as ErrorClass }),
      attempt({ taskId: "B", resolved: false, errorClass: "provider" as ErrorClass }),
    ]).groups[0];
    const s = formatErrorBreakdown(g);
    expect(s).toContain("model=1");
    expect(s).toContain("provider=1");
  });

  it("signale l'absence d'échec", () => {
    const g = summarizeGeneration([attempt({ resolved: true })]).groups[0];
    expect(formatErrorBreakdown(g)).toBe("aucun échec");
  });

  it("rappelle la méthode (jamais un score officiel clef en main)", () => {
    const rep = summarizeGeneration([attempt({ resolved: true })]);
    expect(rep.note).toMatch(/sous-ensemble|officiel/i);
  });
});

// ── sélection reproductible des tâches ────────────────────────────────────────

describe("selectTasks — sous-ensembles reproductibles", () => {
  const tasks = [task("A"), task("B"), task("C"), task("D")];

  it("prend les N premières (déterministe)", () => {
    expect(selectTasks(tasks, { limit: 2 }).map(t => t.taskId)).toEqual(["A", "B"]);
    expect(selectTasks(tasks, { limit: 2 }).map(t => t.taskId)).toEqual(["A", "B"]);
  });

  it("sélectionne par identifiants explicites", () => {
    expect(selectTasks(tasks, { taskIds: ["C", "A"] }).map(t => t.taskId)).toEqual(["A", "C"]);
  });

  it("échoue clairement sur un identifiant inexistant", () => {
    expect(() => selectTasks(tasks, { taskIds: ["Z"] })).toThrow(/introuvables/);
  });

  it("renvoie tout si aucune limite", () => {
    expect(selectTasks(tasks)).toHaveLength(4);
  });
});
