import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { AgentEvent } from "./run";
import { runSubAgent } from "./subagent";
import { roleIds, resolveRole, rolesCatalogPrompt } from "./subagentRoles";
import { buildContextBlock, getProjectContext } from "./projectContext";

// ── Hôte du tool `spawn_agent` (orchestration, mode IA uniquement) ─────────────
//
// Contrat calqué sur Cline : l'outil n'est JAMAIS exposé au modèle tel quel. On
// remplace son `execute` côté hôte par un intercepteur qui :
//   1. résout le RÔLE demandé (l'entrée du modèle n'est jamais fiable) ;
//   2. assemble le contexte projet borné + les notes du root ;
//   3. lance un sous-agent read-only EN MARGE du stream du root ;
//   4. renvoie au root le SEUL rapport borné (jamais le transcript complet).
//
// Le schéma suit Claude Code / Cline : `{ role, task, context_notes }`. Le prompt
// système du sous-agent N'EST PAS fourni par le modèle — il vient du catalogue de
// rôles (`subagentRoles.ts`), ce qui empêche toute réécriture des règles.
//
// Anti-récursion : les outils du sous-agent sont dérivés côté hôte à partir de
// l'allowlist du rôle et ne contiennent jamais `spawn_agent`. Profondeur = 1.

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
    /** Cascade de modèles héritée du root (bascule 429 côté sous-agent). */
    modelChain?: LanguageModel[];
    modelIds?: string[];
    folderPath: string;
    cacheSystem?: boolean;
    /** Résumé borné du fil fourni au sous-agent (contexte « ce sur quoi on travaille »). */
    threadSummary?: string;
    /** Todos en cours du tour, transmis au sous-agent comme contexte. */
    todos?: string[];
    callbacks: SpawnCallbacks;
  },
): ToolSet {
  const original = tools.spawn_agent;
  if (!original) return tools;

  const def = original as { execute?: (input: unknown, opts: unknown) => unknown };
  if (typeof def.execute !== "function") return tools;

  const hostExecute = async (rawInput: unknown, execOpts: unknown): Promise<unknown> => {
    const input = (rawInput ?? {}) as { role?: string; task?: string; context_notes?: string };
    const task = (input.task ?? "").toString().trim();
    const toolCallId = (execOpts as { toolCallId?: string } | undefined)?.toolCallId;

    if (!task) {
      return { error: "spawn_agent requires a non-empty `task` string." };
    }

    // Le rôle est résolu côté hôte : une valeur inconnue retombe sur le défaut,
    // jamais une erreur (le modèle ne peut pas casser l'orchestration).
    const role = resolveRole(input.role);
    const contextNotes = (input.context_notes ?? "").toString().trim();

    // Le `spawnId` appartient à l'HÔTE : il est généré ICI, une seule fois, et
    // sert à la fois (a) à enregistrer la carte dans l'UI et (b) à router les
    // events du sous-agent. Le générer à deux endroits provoquait deux entrées
    // (spawnId "" + vrai id) et une carte bloquée « Working » pour toujours.
    const spawnId = `sub-${crypto.randomUUID()}`;

    // Le contexte projet est dérivé une fois par tour (cache) : il n'est PAS
    // recalculé à chaque sous-agent, et reste borné (coût en tokens prévisible).
    let contextBlock: string;
    try {
      const ctx = await getProjectContext(opts.folderPath || ".");
      contextBlock = buildContextBlock(ctx, { threadSummary: opts.threadSummary, todos: opts.todos });
    } catch {
      contextBlock = "";
    }

    // On prévient l'UI AVANT le lancement pour que la carte apparaisse immédiatement,
    // avec le MÊME `spawnId` que celui qui routera tous les events suivants.
    opts.callbacks.onEvent({
      type: "subagent-start", spawnId, role: role.label, task, toolCallId,
    });

    const result = await runSubAgent({
      model:        opts.model,
      modelChain:   opts.modelChain,
      modelIds:     opts.modelIds,
      folderPath:   opts.folderPath,
      spawnId,
      role:         role.id,
      task,
      contextNotes: contextNotes || undefined,
      contextBlock: contextBlock || undefined,
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
    "Delegate a read-only investigation to a specialized sub-agent and get back a single condensed " +
    "report. Use it when an investigation would otherwise flood your own context — broad searches, " +
    "understanding a flow, reviewing a change, mapping test coverage, or docs impact. Pick the `role` " +
    "that matches the investigation. The sub-agent is read-only (it cannot edit files or run commands) " +
    "and returns only a bounded report.\n\n" +
    rolesCatalogPrompt(),
  inputSchema: z.object({
    role: z.enum(roleIds())
      .describe("Which specialized sub-agent to use."),
    task: z.string()
      .describe("The concrete investigation task the sub-agent must accomplish. Be specific."),
    context_notes: z.string().optional()
      .describe("Optional extra context the sub-agent should know (constraints, what you already found)."),
  }),
  execute: async () => ({ error: "spawn_agent must be wrapped by wrapSpawnAgent before use." }),
});
