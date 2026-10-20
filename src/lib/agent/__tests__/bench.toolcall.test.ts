import { describe, it, expect } from "vitest";
import { tool, type ToolSet, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgent, type AgentEvent, type SubAgentStatus } from "../run";
import {
  scriptedModel, flakyModel, finalText, toolCallTurn,
  streamCallCount,
} from "./support/mockModel";

// ── Niveau A — Benchmark déterministe SANS API ─────────────────────────────────
//
// Exerce la VRAIE boucle de `runAgent` (streamText de `ai@6`) avec un modèle
// simulé et des outils factices. Vérifie les APPELS réellement émis, les
// résultats d'outils et l'état final — pas seulement « ça ne lève pas ».
//
// Les gardes de temps sont neutralisées par défaut (firstChunkMs:0,
// stallTimeoutMs:0, ttftBudgetMs:0) pour que les scénarios soient instantanés et
// déterministes ; seuls les scénarios de timeout les réactivent volontairement.

// ── Outils factices (AUCUN `invoke` Tauri) ─────────────────────────────────────

interface Harness {
  tools: ToolSet;
  /** Journal des appels d'outils réellement exécutés. */
  calls: Array<{ name: string; input: unknown }>;
}

function makeHarness(overrides?: {
  /** Remplacer le comportement d'un outil (ex. jeter une erreur). */
  behavior?: Record<string, (input: unknown) => unknown | Promise<unknown>>;
  /** Ajouter des outils au-delà du jeu standard. */
  extra?: ToolSet;
}): Harness {
  const calls: Array<{ name: string; input: unknown }> = [];
  const behavior = overrides?.behavior ?? {};

  const mk = (name: string, schema: z.ZodTypeAny, defaultResult: unknown) =>
    tool({
      description: `Fake ${name}`,
      inputSchema: schema,
      execute: async (input: unknown) => {
        calls.push({ name, input });
        const fn = behavior[name];
        if (fn) return await fn(input);
        return defaultResult;
      },
    });

  const tools: ToolSet = {
    read_file:       mk("read_file", z.object({ path: z.string() }), { content: "file body", lines: 1 }),
    list_directory:  mk("list_directory", z.object({ path: z.string() }), { entries: ["a.ts", "b.ts"] }),
    grep:            mk("grep", z.object({ query: z.string() }), { results: [{ path: "a.ts", line: 3, text: "match" }] }),
    glob:            mk("glob", z.object({}), { files: ["a.ts", "b.ts", "c.ts"] }),
    write_file:      mk("write_file", z.object({ path: z.string(), content: z.string() }), { ok: true }),
    ...(overrides?.extra ?? {}),
  };
  return { tools, calls };
}

/** Collecte tous les events d'un run et attend sa fin (via onSettled). */
function runToCompletion(
  model: Parameters<typeof runAgent>[0]["model"],
  tools: ToolSet,
  opts?: Partial<Parameters<typeof runAgent>[0]>,
): Promise<{ events: AgentEvent[]; status: SubAgentStatus; tokens: string }> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    let status: SubAgentStatus = "completed";
    const messages: ModelMessage[] = opts?.messages ?? [{ role: "user", content: "go" }];
    runAgent({
      model,
      messages,
      tools,
      systemPrompt: "You are a test agent.",
      // Gardes désactivées par défaut : déterministe et instantané.
      maxSteps: 24,
      firstChunkMs: 0,
      stallTimeoutMs: 0,
      ttftBudgetMs: 0,
      ...opts,
      onEvent: (e) => { events.push(e); opts?.onEvent?.(e); },
      onSettled: (s) => { status = s; resolve({ events, status, tokens: textOf(events) }); },
    });
  });
}

function textOf(events: AgentEvent[]): string {
  return events.filter(e => e.type === "token").map(e => (e as { delta: string }).delta).join("");
}
function toolCallsOf(events: AgentEvent[]) {
  return events.filter(e => e.type === "tool-call") as Array<{ id: string; toolName: string; args: unknown }>;
}
function toolResultsOf(events: AgentEvent[]) {
  return events.filter(e => e.type === "tool-result") as Array<{ id: string; toolName: string; result: unknown }>;
}

// ── Scénarios ──────────────────────────────────────────────────────────────────

describe("Niveau A — boucle runAgent (modèle simulé)", () => {

  // 1. Réponse simple sans appel d'outil.
  it("1. réponse texte simple, aucun outil appelé", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([() => ({ chunks: finalText("Bonjour.") })]);
    const { events, status } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    expect(textOf(events)).toBe("Bonjour.");
    expect(calls).toHaveLength(0);
    expect(events.some(e => e.type === "finish")).toBe(true);
  });

  // 2. Appel d'un outil, réception du résultat, puis réponse finale.
  it("2. cycle outil → résultat → réponse finale", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]) }),
      () => ({ chunks: finalText("Fichier lu, il contient du code.") }),
    ]);
    const { events, status, tokens } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    expect(calls).toEqual([{ name: "read_file", input: { path: "a.ts" } }]);
    const results = toolResultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "c1", toolName: "read_file" });
    expect(tokens).toContain("Fichier lu");
    // Un tour d'outil + un tour final = 2 appels au modèle.
    expect(streamCallCount(model)).toBe(2);
  });

  // 3. Plusieurs appels d'outils successifs (dans le même tour et sur 2 tours).
  it("3. appels d'outils multiples et successifs", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([
        { id: "c1", name: "glob", input: {} },
        { id: "c2", name: "grep", input: { query: "foo" } },
      ]) }),
      () => ({ chunks: toolCallTurn([{ id: "c3", name: "read_file", input: { path: "b.ts" } }]) }),
      () => ({ chunks: finalText("Terminé.") }),
    ]);
    const { events, status } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    expect(calls.map(c => c.name)).toEqual(["glob", "grep", "read_file"]);
    expect(toolResultsOf(events)).toHaveLength(3);
    expect(streamCallCount(model)).toBe(3);
  });

  // 4. Lecture, recherche et modification de plusieurs fichiers.
  it("4. lecture + recherche + modification multi-fichiers", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "grep", input: { query: "TODO" } }]) }),
      () => ({ chunks: toolCallTurn([{ id: "c2", name: "read_file", input: { path: "a.ts" } }]) }),
      () => ({ chunks: toolCallTurn([
        { id: "c3", name: "write_file", input: { path: "a.ts", content: "fixed" } },
        { id: "c4", name: "write_file", input: { path: "b.ts", content: "fixed2" } },
      ]) }),
      () => ({ chunks: finalText("Les deux fichiers sont corrigés.") }),
    ]);
    const { status, events } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    const writes = calls.filter(c => c.name === "write_file");
    expect(writes).toHaveLength(2);
    expect(writes.map(w => (w.input as { path: string }).path)).toEqual(["a.ts", "b.ts"]);
    expect(toolResultsOf(events)).toHaveLength(4);
  });

  // 5. Gestion d'un appel d'outil invalide (nom inconnu / args non conformes).
  it("5. appel d'outil invalide → erreur remontée, pas de crash", async () => {
    const { tools } = makeHarness();
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "outil_inexistant", input: { x: 1 } }]) }),
      () => ({ chunks: finalText("Je corrige mon approche.") }),
    ]);
    const { events, status } = await runToCompletion(model, tools);
    // Le run ne doit pas planter : soit le SDK ignore l'outil inconnu, soit il
    // remonte une erreur de validation — dans tous les cas le tour se termine.
    expect(["completed", "error", "max_iterations"]).toContain(status);
    const invalid = events.find(e => e.type === "tool-call" && e.toolName === "outil_inexistant");
    expect(invalid).toBeDefined();
  });

  // 6. Erreur d'outil + récupération (le modèle continue après un échec d'outil).
  it("6a. l'outil jette une erreur → le run récupère et produit une réponse", async () => {
    const { tools } = makeHarness({
      behavior: { read_file: () => { throw new Error("EACCES: permission denied"); } },
    });
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "read_file", input: { path: "secret.ts" } }]) }),
      () => ({ chunks: finalText("Impossible de lire le fichier, je change de méthode.") }),
    ]);
    const { status, tokens, events } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    expect(tokens).toContain("change de méthode");
    // LACUNE CONSTATÉE (run.ts) : le SDK émet une part `tool-error` (pas
    // `tool-result`) quand `execute` lève. `run.ts` ne traite PAS ce cas → aucun
    // event n'est remonté à l'hôte pour les outils en échec. Le modèle, lui,
    // reçoit bien l'erreur et poursuit (le run ne casse pas). Documenté ici pour
    // éviter une fausse régression : on asserte l'absence d'event, pas sa présence.
    expect(toolResultsOf(events)).toHaveLength(0);
    // Le cycle continue néanmoins : 2 appels au modèle.
    expect(streamCallCount(model)).toBe(2);
  });

  // 6b. Timeout d'outil (toolTimeoutMs) → résultat d'erreur, le tour continue.
  it("6b. timeout d'outil coupé par toolTimeoutMs", async () => {
    const { tools } = makeHarness({
      behavior: { read_file: () => new Promise(() => { /* ne résout jamais */ }) },
    });
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "read_file", input: { path: "slow.ts" } }]) }),
      () => ({ chunks: finalText("L'outil a expiré, je poursuis.") }),
    ]);
    const { status, events } = await runToCompletion(model, tools, { toolTimeoutMs: 30 });
    expect(status).toBe("completed");
    const res = toolResultsOf(events);
    expect(res).toHaveLength(1);
    expect(JSON.stringify(res[0].result)).toContain("timed out");
  });

  // 6c. Garde anti-flux-muet : le provider n'émet rien → abandon + bascule.
  it("6c. flux muet (firstChunkMs) → tentative coupée et bascule sur le repli", async () => {
    const { tools } = makeHarness();
    // Le modèle principal ne produit AUCUN chunk avant la garde firstChunkMs.
    // Le délai simulé est plus long que la garde ; l'abort de runAgent réveille
    // le flux (abortableDelay) → la tentative est coupée proprement.
    const primary = scriptedModel(
      [() => ({ chunks: finalText("trop tard"), initialDelayInMs: 5_000 })],
      "primary",
    );
    // Repli immédiat : AUCUN backoff (la cascade prime sur le retry du même
    // modèle), donc le scénario reste rapide malgré le délai simulé de 5 s.
    const fallback = scriptedModel([() => ({ chunks: finalText("réponse du repli") })], "fallback");
    const { status, tokens } = await runToCompletion(primary, tools, {
      firstChunkMs: 30,
      modelChain: [primary, fallback],
      modelIds: ["primary", "fallback"],
    });
    // Le run aboutit grâce au repli, qui répond instantanément.
    expect(status).toBe("completed");
    expect(tokens).toContain("réponse du repli");
  }, 10_000);

  // 6d. Garde d'inactivité : un chunk de CONTENU puis silence → la tentative est
  // coupée sans attendre la fin du flux (pas de blocage jusqu'au prochain chunk).
  it("6d. flux bloqué en cours (stallTimeoutMs) → abandon rapide de la tentative", async () => {
    const { tools } = makeHarness();
    // Le stall ne s'arme qu'APRÈS un premier contenu réel (`text-delta`), pas
    // sur les parts d'échafaudage (`text-start`). Le PREMIER chunk est donc
    // directement un `text-delta` (émis immédiatement) ; le chunk suivant
    // n'arrive qu'après 5 s de silence, bien au-delà du stall. NB : comme un
    // contenu a été produit, la cascade est INTERDITE (garde anti-duplication) :
    // runAgent reprend le MÊME modèle après backoff. On vérifie donc uniquement
    // que la tentative est coupée tôt (pas d'attente des 5 s du flux), puis on
    // annule pour ne pas subir les 3 backoffs.
    const primary = scriptedModel([() => ({
      chunks: [
        { type: "text-delta", id: "t", delta: "début" },
        { type: "text-end", id: "t" },
      ],
      chunkDelayInMs: 5_000, // delta immédiat, puis silence de 5 s
    })], "primary");
    const t0 = Date.now();
    const events: AgentEvent[] = [];
    await new Promise<void>((resolve) => {
      const h = runAgent({
        model: primary, tools, systemPrompt: "sys",
        messages: [{ role: "user", content: "go" }],
        maxSteps: 24, firstChunkMs: 0, ttftBudgetMs: 0, stallTimeoutMs: 30,
        onEvent: (e) => {
          events.push(e);
          // Dès que la tentative est abandonnée (notice de retry), on annule :
          // on ne veut pas subir les backoffs 3 s / 6 s / 12 s du même modèle.
          if (e.type === "notice") { h.cancel(); }
        },
        onSettled: () => resolve(),
      });
    });
    const elapsed = Date.now() - t0;
    // La coupure doit être bien plus rapide que le délai de 5 s du flux : c'est
    // la preuve que le garde d'inactivité a coupé le flux bloqué.
    expect(elapsed).toBeLessThan(2_000);
    // Aucun `finish` : la tentative n'a jamais abouti.
    expect(events.some(e => e.type === "finish")).toBe(false);
  }, 10_000);

  // 7. Limite maximale d'itérations (stopWhen) → statut max_iterations.
  it("7. limite d'itérations atteinte → max_iterations (jamais « completed »)", async () => {
    const { tools, calls } = makeHarness();
    // Le modèle appelle un outil à CHAQUE tour, sans jamais conclure.
    const model = scriptedModel([(i) => ({
      chunks: toolCallTurn([{ id: `c${i}`, name: "glob", input: {} }]),
    })]);
    const { status } = await runToCompletion(model, tools, { maxSteps: 3 });
    expect(status).toBe("max_iterations");
    expect(calls.length).toBe(3);
  });

  // 8. Le modèle refuse d'appeler un outil alors que la tâche le permet.
  it("8. modèle qui n'appelle aucun outil malgré des outils disponibles", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([() => ({ chunks: finalText("Je réponds sans outil.") })]);
    const { status, events } = await runToCompletion(model, tools);
    expect(status).toBe("completed");
    expect(calls).toHaveLength(0);
    expect(toolCallsOf(events)).toHaveLength(0);
  });

  // 9. Le modèle doit s'abstenir d'appeler un outil inutile (irrelevance).
  it("9. abstention correcte : aucun appel quand les outils sont inutiles", async () => {
    const { tools, calls } = makeHarness();
    const model = scriptedModel([() => ({ chunks: finalText("2 + 2 = 4.") })]);
    const { events } = await runToCompletion(model, tools);
    expect(calls).toHaveLength(0);
    expect(toolCallsOf(events)).toHaveLength(0);
    expect(textOf(events)).toBe("2 + 2 = 4.");
  });

  // 10. Fallback après indisponibilité du provider (429 → cascade).
  it("10. 429 sur le modèle principal → bascule sur le repli", async () => {
    const { tools } = makeHarness();
    const primary = flakyModel(99, "429 rate limit exceeded", () => ({ chunks: finalText("jamais") }), "primary");
    const fallback = scriptedModel([() => ({ chunks: finalText("réponse du repli") })], "fallback");
    const { events, status, tokens } = await runToCompletion(primary, tools, {
      modelChain: [primary, fallback],
      modelIds: ["primary", "fallback"],
    });
    expect(status).toBe("completed");
    expect(tokens).toContain("réponse du repli");
    // Une notice de bascule doit être émise.
    expect(events.some(e => e.type === "notice" && e.kind === "retry")).toBe(true);
    // La trace timing doit compter la bascule.
    const timing = events.find(e => e.type === "timing") as { fallbacks: number } | undefined;
    expect(timing?.fallbacks).toBe(1);
  });

  // 11. Annulation : aucun event après cancel, statut cancelled, pas de boucle.
  it("11. annulation → cancelled, et le run s'arrête proprement", async () => {
    const { tools, calls } = makeHarness();
    // Le modèle appellerait un outil à l'infini ; on annule dès le 1er step.
    const model = scriptedModel([() => ({ chunks: toolCallTurn([{ id: "c", name: "glob", input: {} }]) })]);
    const events: AgentEvent[] = [];
    let status: SubAgentStatus = "completed";
    await new Promise<void>((resolve) => {
      const handle = runAgent({
        model, tools, systemPrompt: "sys",
        messages: [{ role: "user", content: "go" }],
        maxSteps: 24, firstChunkMs: 0, stallTimeoutMs: 0, ttftBudgetMs: 0,
        onEvent: (e) => {
          events.push(e);
          if (e.type === "step-finish") handle.cancel();
        },
        onSettled: (s) => { status = s; resolve(); },
      });
    });
    expect(status).toBe("cancelled");
    // Une fois annulé, plus aucun event émis (la garde `emit` coupe tout).
    const lastIndex = events.length - 1;
    expect(events[lastIndex].type).not.toBe("finish");
    // Aucune boucle infinie : le nombre de tours reste STRICTEMENT borné, même
    // si l'annulation n'est pas instantanée au niveau du SDK (un step déjà
    // engagé peut se terminer, d'où 2 au lieu de 1). L'essentiel est que ça
    // s'arrête tout seul, très en deçà de `maxSteps` (24).
    expect(streamCallCount(model)).toBeLessThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  // 12. Conservation correcte du contexte entre les étapes.
  it("12. le contexte (résultat d'outil) est réinjecté au tour suivant", async () => {
    const { tools } = makeHarness({
      behavior: { read_file: () => ({ content: "CONTENU_UNIQUE_42" }) },
    });
    const model = scriptedModel([
      () => ({ chunks: toolCallTurn([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]) }),
      () => ({ chunks: finalText("Vu.") }),
    ]);
    await runToCompletion(model, tools);
    // Le 2e appel au modèle doit contenir le résultat de l'outil dans ses messages.
    const callsLog = (model as unknown as { _doStreamCalls: Array<{ prompt?: unknown }> })._doStreamCalls;
    expect(callsLog.length).toBe(2);
    const secondCall = JSON.stringify(callsLog[1]);
    expect(secondCall).toContain("CONTENU_UNIQUE_42");
  });
});