/**
 * Origin — Outil CUSTOM `escalate_to_team` (sidecar Cline).
 *
 * RÔLE
 * ----
 * En mode IA, exposer d'emblée les 18 outils d'orchestration `team_*` alourdit
 * CHAQUE requête (coût de TTFT fixe imposé par le SDK). Pour garder une réponse
 * rapide sur les demandes simples tout en gardant la pleine puissance sur les
 * demandes larges, on démarre la session SANS équipes et on offre au modèle un
 * SEUL outil léger : `escalate_to_team`.
 *
 * POURQUOI UN OUTIL ET PAS UN CLASSIFICATEUR DE TEXTE
 * ---------------------------------------------------
 * La complexité d'une tâche est une propriété du TRAVAIL (nombre de fichiers,
 * dépendances, inconnues découvertes en lisant), pas de la FORMULATION du
 * message. Un classificateur de mots-clés se trompe dans les deux sens : court
 * mais profond (« corrige ce bug »), ou long mais trivial (« refactorise cette
 * fonction »). En laissant le MODÈLE demander l'escalade, la décision repose sur
 * ce qu'il a réellement observé — pas sur la forme de la demande.
 *
 * Le modèle n'appellera cet outil que lorsqu'il bute sur l'ampleur : jamais pour
 * un « bonjour ». C'est le même principe que la todo list (voir `./todoTool`).
 *
 * CÂBLAGE
 * -------
 *   - L'outil ne fait RIEN de lui-même : il ÉMET un `tool_event` vers le front
 *     (`{ kind: "tool_event", tool: "team_escalate", reason }`).
 *   - C'est le FRONT qui pilote l'escalade réelle : il coupe le run léger et
 *     relance une session AVEC les équipes, en réinjectant l'historique (le
 *     travail déjà produit est conservé). Le sidecar ne peut pas re-seeder sa
 *     propre session en plein run — d'où la séparation.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucune entrée exécutée** : `reason` est une chaîne bornée, re-sérialisée.
 *   - **Aucun effet de bord** : l'outil ne touche ni disque ni système.
 *   - **Auto-approuvé** (inscrit dans `TOOL_POLICIES`) : pas de carte de
 *     confirmation pour une simple demande d'escalade.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Longueur maximale de la justification d'escalade (borne mémoire UI). */
const MAX_REASON = 400;

/** Callback émis quand le modèle demande l'escalade (relayé tel quel au front). */
export type TeamEscalateEmit = (reason: string) => void;

/**
 * Construit l'outil d'escalade d'une session.
 *
 * @param emit callback de remontée (voir `TeamEscalateEmit`).
 */
export function buildTeamEscalateTool(emit: TeamEscalateEmit) {
  const escalate = createTool({
    name: "escalate_to_team",
    description:
      "Request more execution capacity for a task that genuinely needs it. Call this ONLY " +
      "when the current work is too broad or multi-faceted to handle in a single pass — for " +
      "example: investigating many files, an end-to-end refactor or migration, a wide " +
      "codebase-wide search, or parallel workstreams. Do NOT call it for simple, focused " +
      "requests (a question, a one-file edit, a single lookup): handle those directly. " +
      "Calling this restarts the run with a team of collaborators; the work done so far is kept.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(1)
        .max(MAX_REASON)
        .describe("Why the task needs a team, in one short sentence."),
    }),
    // Demander l'escalade ne termine PAS le run du point de vue de l'outil : le
    // front décide de la suite (relance ou non).
    lifecycle: { completesRun: false },
    async execute(input: { reason: string }) {
      const reason = String(input.reason ?? "").slice(0, MAX_REASON);
      emit(reason);
      return {
        output:
          "Escalation requested: the run will restart with a team of collaborators, " +
          "keeping the work already done. Stop planning further; the team lead will continue.",
        isError: false,
      };
    },
  });

  return { tools: [escalate] };
}
