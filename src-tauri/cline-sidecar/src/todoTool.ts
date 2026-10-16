/**
 * Origin — Outils CUSTOM `todo_write` / `todo_read` (sidecar Cline).
 *
 * RÔLE
 * ----
 * Le SDK Cline n'expose AUCUN outil de checklist de progression (son outil
 * `tasks` est un agenda durable, pas la todo list type Trae). Pour que l'agent
 * puisse maintenir une liste de tâches visible au-dessus de l'input, on
 * INJECTE nos propres outils dans la session via `extraTools` (option de
 * démarrage du runtime local — cf. `localRuntime.extraTools`).
 *
 * POURQUOI ICI (Node) ET PAS CÔTÉ FRONT
 * -------------------------------------
 * Les outils sont exécutés par le MOTEUR d'agent : leur implémentation doit
 * donc vivre dans le même process que lui, sinon le modèle n'aurait jamais leur
 * définition. En revanche, leur EFFET observable (la liste) appartient à l'UI :
 * chaque mutation est ré-émise sur stdout sous `{ kind: "tool_event", ... }`,
 * que le front (`clineClient` → `todoStore`) applique.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucune entrée n'est exécutée** : les items sont validés (forme, taille)
 *     puis re-sérialisés. On ne transporte que des données.
 *   - **Bornage strict** : nombre d'items et longueur de contenu plafonnés, pour
 *     qu'un modèle (ou un prompt hostile) ne puisse pas saturer la mémoire du
 *     webview avec une todo list géante.
 *   - **Auto-approuvés côté politique** (`todo_write`/`todo_read` ne touchent
 *     PAS le disque) : les inscrire dans `TOOL_POLICIES` évite une carte de
 *     confirmation à chaque mise à jour (le joker `"*"` les refuserait sinon).
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Nombre maximal d'items d'une todo list (borne mémoire UI). */
const MAX_ITEMS = 50;
/** Longueur maximale du texte d'un item. */
const MAX_CONTENT = 500;

/** Callback émis à chaque mutation de la liste (relayé tel quel à l'UI). */
export type TodoEmit = (
  sessionId: string,
  todos: { id: string; content: string; status: string }[],
) => void;

const STATUSES = ["pending", "in_progress", "done", "cancelled"] as const;

/**
 * Construit les outils todo d'une session.
 *
 * @param uiSessionId id de session UI (pour attribuer la liste côté front).
 * @param emit        callback de remontée (voir `TodoEmit`).
 */
export function buildTodoTools(uiSessionId: string, emit: TodoEmit) {
  // État local de la liste : sert au `todo_read` (le modèle peut avoir perdu la
  // vue de la liste après une compaction de contexte).
  let lastTodos: { id: string; content: string; status: string }[] = [];
  // Émetteur unique : mémorise l'état AVANT de relayer à l'UI. `todo_write`
  // passe par lui, ce qui garantit que `todo_read` voit toujours la dernière
  // liste réellement appliquée.
  const wrappedEmit: TodoEmit = (sessionId, todos) => {
    lastTodos = todos;
    emit(sessionId, todos);
  };

  /**
   * `todo_write` : remplace intégralement la liste courante.
   *
   * On préfère un REMPLACEMENT complet (comme le `todo_write` du front) à des
   * mutations incrémentales : le modèle raisonne sur la liste entière à chaque
   * étape, ce qui évite les états incohérents (item modifié par un patch partiel
   * alors que sa position a changé).
   */
  const todoWrite = createTool({
    name: "todo_write",
    description:
      "Create or update the task checklist for the current run. Pass the FULL list of " +
      "tasks, each with an id, content and status (pending | in_progress | done | cancelled). " +
      "Exactly one task should be in_progress at a time. Use this to plan multi-step work " +
      "and keep the user informed of progress.",
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            content: z.string().min(1).max(MAX_CONTENT),
            status: z.enum(STATUSES),
          }),
        )
        .max(MAX_ITEMS),
    }),
    // Checklist = outil de raisonnement, pas d'action système : on déclare
    // qu'il ne complète PAS le run (le modèle continue d'agir après l'avoir posé).
    lifecycle: { completesRun: false },
    async execute(input: { todos: { id: string; content: string; status: (typeof STATUSES)[number] }[] }) {
      // Re-sérialisation défensive : on ne propage QUE des champs connus.
      const todos = input.todos.map((t) => ({
        id: String(t.id).slice(0, 64),
        content: String(t.content).slice(0, MAX_CONTENT),
        status: t.status,
      }));
      wrappedEmit(uiSessionId, todos);
      const done = todos.filter((t) => t.status === "done").length;
      return {
        output: `Checklist updated (${done}/${todos.length} done).`,
        isError: false,
      };
    },
  });

  /**
   * `todo_read` : relit la liste courante.
   *
   * Le modèle reçoit déjà la liste dans l'historique de ses propres appels,
   * mais un `read` explicite lui évite de « deviner » l'état après une
   * compaction de contexte — cas réel sur les runs longs.
   */
  const todoRead = createTool({
    name: "todo_read",
    description:
      "Read the current task checklist. Returns an empty list if no checklist has been " +
      "created yet for this run.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      return {
        output:
          lastTodos.length === 0
            ? "No checklist yet."
            : lastTodos
                .map((t) => `- [${t.status}] ${t.content}`)
                .join("\n"),
        isError: false,
      };
    },
  });

  return { tools: [todoWrite, todoRead], onEmit: wrappedEmit };
}
