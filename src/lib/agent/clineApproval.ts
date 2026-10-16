/**
 * Origin — Traduction des demandes d'approbation Cline → politique d'Origin.
 *
 * RÔLE
 * ----
 * Le moteur Cline (sidecar Node) demande l'autorisation d'un outil via
 * `requestToolApproval`, avec les **noms d'outils réels du SDK** — vérifiés
 * dans le bundle `@cline/core` (`DefaultToolNames`) : `read_files`,
 * `editor` / `apply_patch`, `run_commands`, `search_codebase`,
 * `fetch_web_content`, `web_search`, `skills`, `ask_question`,
 * `submit_and_exit`, plus les outils d'équipe `team_*` / `spawn_agent`.
 *
 * La politique d'Origin, elle, raisonne sur des `PendingAction` typées
 * (`write_file`, `edit`, `bash_run`, `ask_user`) — c'est ce que consomme
 * `permissions.ts::decideApproval`.
 *
 * Ce module fait le pont entre les deux, et RIEN d'autre : il ne décide pas, il
 * normalise. La décision reste dans `permissions.ts` (source unique de vérité),
 * ce qui garantit que le comportement d'approbation est identique quel que soit
 * le harness sous-jacent.
 *
 * POURQUOI ON GARDE AUSSI LES ALIAS
 * ---------------------------------
 * Le SDK normalise en interne des alias historiques (`write_to_file`,
 * `execute_command`, `read_file`, `replace_in_file`, …) vers les noms
 * canoniques ci-dessus. Selon la version et la configuration, un de ces alias
 * peut remonter tel quel dans `toolName`. Les reconnaître évite de classer un
 * outil connu comme « inconnu » (donc sensible) par simple différence de nom.
 *
 * SÉCURITÉ
 * --------
 *   - Un outil **inconnu** est traité comme SENSIBLE (jamais auto-approuvé par
 *     défaut) : on préfère demander une fois de trop que d'exécuter un outil
 *     non catalogué sans garde-fou.
 *   - On n'invente jamais de chemin : si l'entrée ne porte pas de chemin
 *     exploitable, on classe l'action comme non-confinée (donc à confirmer en
 *     mode `auto`).
 *   - Les outils de LECTURE pure sont reconnus explicitement pour ne pas
 *     harceler l'utilisateur (lecture = sûre, cf. `permissions.ts`).
 */

import type { PendingAction } from "./tools";

/**
 * Noms d'outils Cline qui MODIFIENT le disque via un chemin unique.
 * Canoniques (`editor`, `apply_patch`) + alias historiques (`write_to_file`…).
 */
const WRITE_TOOLS = new Set([
  "editor",
  "apply_patch",
  "write_to_file",
  "replace_in_file",
  "apply_diff",
  "edit",
]);

/** Noms d'outils Cline qui exécutent une commande shell. */
const SHELL_TOOLS = new Set(["run_commands", "bash", "execute_command", "shell", "list_files"]);

/** Noms d'outils Cline de LECTURE pure (aucune modification). */
const READ_TOOLS = new Set([
  "read_files",
  "read_file",
  "search_codebase",
  "search_files",
  "list_code_definition_names",
  "fetch_web_content",
  "web_fetch",
  "web_search",
  "fetch",
]);

/** Noms d'outils Cline qui posent une question à l'utilisateur. */
const ASK_TOOLS = new Set(["ask_question", "ask_followup_question", "ask_user", "ask"]);

/**
 * Convertit une demande d'approbation Cline en `PendingAction` d'Origin, ou
 * `null` si l'outil est reconnu comme non modifiant (lecture pure).
 *
 * @param toolName nom d'outil émis par le SDK.
 * @param input    entrée de l'outil (forme libre, validée défensivement ici).
 */
export function toPendingAction(toolName: string, input: unknown): PendingAction | null {
  if (READ_TOOLS.has(toolName)) return null;

  if (WRITE_TOOLS.has(toolName)) {
    const path = extractPath(input);
    return {
      type: "write_file",
      path,
      // Origin ne reconstruit pas le contenu ici : la politique ne s'appuie que
      // sur le CHEMIN (confinement workspace). Les champs de contenu ne sont pas
      // utilisés par `decideApproval`, on les laisse vides pour ne pas dupliquer
      // une logique d'édition qui vit dans le SDK.
      content: "",
      originalContent: "",
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = extractCommand(input);
    return { type: "bash_run", command, cwd: "" };
  }

  if (ASK_TOOLS.has(toolName)) {
    return { type: "ask_user", question: "", options: [], allowFreeform: true };
  }

  // Outil inconnu → on le classe comme une écriture NON confinée (chemin vide,
  // donc hors workspace) : en mode `auto` il sera demandé, jamais exécuté en
  // silence. C'est le choix conservateur.
  return { type: "write_file", path: "", content: "", originalContent: "" };
}

/** Extrait un chemin d'une entrée d'outil, sans jamais inventer de valeur. */
function extractPath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target_file", "targetFile"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/** Extrait une commande d'une entrée d'outil shell. */
function extractCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Vrai si l'outil est reconnu comme ne modifiant RIEN (lecture pure). Permet à
 * l'appelant de court-circuiter l'UI sans même construire une `PendingAction`.
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}
