import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { AgentEvent } from "./run";
import { runSubAgent, DEFAULT_SUBAGENT_ROLE } from "./subagent";

// ── Hôte du tool `spawn_agent` (orchestration, mode IA uniquement) ─────────────
//
// Contrat calqué sur Cline : l'outil n'est JAMAIS exposé au modèle tel quel. On
// remplace son `execute` côté hôte par un intercepteur qui :
//   1. abandonne le tool-call du root (résultat vide) ;
//   2. lance un sous-agent read-only EN MARGE du stream du root ;
//   3. renvoie au root le SEUL rapport borné (jamais le transcript complet).
//
// Le schéma reproduit `{ systemPrompt, task }` de Cline. `systemPrompt` est
// IGNORÉ (un modèle ne doit pas pouvoir réécrire les règles de son sous-agent) —
// il est accepté uniquement pour la compatibilité du contrat.
//
// Anti-récursion : les outils du sous-agent sont dérivés côté hôte
// (`createReadOnlyTools`) et ne contiennent jamais `spawn_agent`. Profondeur = 1.

export interface SpawnCallbacks {
  /** Émission vers l'UI — les events du sous-agent portent déjà leur `spawnId`. */
  onEvent: (event: AgentEvent) => void;
  /**
   * Enregistre la fonction d'annulation du sous-agent pour que l'hôte (le root)
   * puisse le couper (abort du tour, timeout global). L'hôte l'ajoute à sa liste
   * de cleanups.
   */
  onSpawn: (cancel: () => void) => void;
}

export function wrapSpawnAgent(
  tools: ToolSet,
  opts: {
    model: LanguageModel;
    folderPath: string;
    cacheSystem?: boolean;
    callbacks: SpawnCallbacks;
  },
): ToolSet {
  const original = tools.spawn_agent;
  if (!original) return tools;

  const def = original as { execute?: (input: unknown, opts: unknown) => unknown };
  if (typeof def.execute !== "function") return tools;

  const hostExecute = async (rawInput: unknown, execOpts: unknown): Promise<unknown> => {
    const input = (rawInput ?? {}) as { task?: string };
    const task = (input.task ?? "").toString().trim();
    const toolCallId = (execOpts as { toolCallId?: string } | undefined)?.toolCallId;

    if (!task) {
      return { error: "spawn_agent requires a non-empty `task` string." };
    }

    const role = DEFAULT_SUBAGENT_ROLE;
    // On prévient l'UI AVANT le lancement pour que la carte apparaisse immédiatement.
    opts.callbacks.onEvent({
      type: "subagent-start", spawnId: "", role, task, toolCallId,
    });

    const result = await runSubAgent({
      model:        opts.model,
      folderPath:   opts.folderPath,
      role,
      task,
      cacheSystem:  opts.cacheSystem,
      onEvent:      opts.callbacks.onEvent,
    });

    // Le root ne reçoit que le rapport borné, jamais le transcript.
    if (result.status !== "completed") {
      return { report: result.report, status: result.status };
    }
    return { report: result.report };
  };

  return {
    ...tools,
    spawn_agent: {
      ...(def as object),
      execute: hostExecute,
    } as ToolSet[string],
  };
}

/**
 * Définition du tool `spawn_agent`. IMPORTANT : à n'inclure que dans le toolset
 * du mode IA (jamais en mode IDE, où aucun sous-agent n'est autorisé). L'`execute`
 * réel est remplacé par `wrapSpawnAgent` côté hôte ; celui-ci n'est qu'un
 * placeholder pour que `runAgent`/`streamText` acceptent le tool-call du modèle.
 */
export const spawnAgentTool = tool({
  description:
    "Delegate a read-only exploration to a sub-agent and get back a single condensed report. " +
    "Use it for broad codebase investigations (finding where X is defined, how Y flows, which files " +
    "implement Z) so your own context stays focused on the actual task. " +
    "The sub-agent is read-only: it cannot edit files or run commands. " +
    "Provide the full investigation task in `task`; put any framing instructions in `systemPrompt`.",
  inputSchema: z.object({
    systemPrompt: z.string().describe("Optional framing/system instruction for the sub-agent."),
    task:         z.string().describe("The concrete exploration task the sub-agent must accomplish."),
  }),
  execute: async () => ({ error: "spawn_agent must be wrapped by wrapSpawnAgent before use." }),
});
