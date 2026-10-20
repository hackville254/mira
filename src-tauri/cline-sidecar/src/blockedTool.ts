/**
 * Origin — Outils MCP « bloqués » (sidecar Cline).
 *
 * RÔLE
 * ----
 * Un agent personnalisé peut restreindre la liste des serveurs MCP qu'il est
 * autorisé à utiliser. Or le SDK enregistre TOUS les serveurs MCP déclarés dans
 * le fichier de réglages, puis expose leurs outils au modèle. Pour respecter la
 * dotation de l'agent, on enregistre donc un outil « refus » portant le MÊME
 * nom que chaque outil MCP d'un serveur NON retenu : il MASQUE la vraie
 * définition (les noms d'outils sont uniques dans la session) et renvoie au
 * modèle un refus explicite plutôt qu'une erreur silencieuse.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucune entrée exécutée** : `execute` ne fait que renvoyer un message.
 *   - **Aucun accès réseau/disque** : le refus est purement textuel.
 *   - **Données inertes** : on ne transporte qu'un nom d'outil (chaîne) et un
 *     libellé de serveur ; jamais de commande ni de code.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Longueur maximale d'un nom d'outil affiché (bornage défensif). */
const MAX_NAME = 128;

/** Un outil MCP refusé : son nom réel + le serveur dont il provient. */
export interface BlockedToolSpec {
  /** Nom complet exposé par le SDK (ex. `mcp__github__create_issue`). */
  name: string;
  /** Nom du serveur MCP d'origine (pour un message lisible). */
  server: string;
}

/**
 * Construit un outil « refus » par spécification. Le nom est dérivé de manière
 * STRICTE (tronqué, caractères non sûrs remplacés par `_`) : un nom hostile ne
 * peut pas casser le protocole d'outils de la session.
 */
export function buildBlockedTools(specs: BlockedToolSpec[] | undefined) {
  const tools: unknown[] = [];
  for (const spec of specs ?? []) {
    const name = sanitizeToolName(spec.name);
    if (!name) continue;
    const server = sanitizeLabel(spec.server);
    tools.push(
      createTool({
        name,
        description:
          `Disabled tool from MCP server "${server}". This agent is not allowed to use it.`,
        // Schéma permissif : on accepte n'importe quelle charge d'appel pour que
        // le refus soit TOUJOURS renvoyé (jamais une erreur de validation).
        inputSchema: z.object({}).passthrough(),
        lifecycle: { completesRun: false },
        async execute() {
          return {
            output:
              `Tool "${name}" is not enabled for the current agent. ` +
              `Its MCP server "${server}" is excluded from this agent's toolset.`,
            isError: true,
          };
        },
      }),
    );
  }
  return tools;
}

/** Nettoie un nom d'outil : borné, jeu de caractères sûr, jamais vide. */
function sanitizeToolName(raw: string): string {
  return String(raw ?? "")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, MAX_NAME);
}

/** Nettoie un libellé de serveur (affichage uniquement). */
function sanitizeLabel(raw: string): string {
  return String(raw ?? "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, MAX_NAME);
}
