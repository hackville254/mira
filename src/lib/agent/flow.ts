/**
 * Flow — logique PURE de bascule automatique d'onglet (parité Trae).
 *
 * Principe (« Flow » chez Trae) : pendant qu'un tour d'agent s'exécute, le
 * panneau d'outils suit l'étape en cours — l'agent lit un fichier → onglet
 * Editor ; il écrit → DiffView ; il lance une commande → Terminal ; il va sur le
 * web → Browser. L'utilisateur reprend la main dès qu'il clique un onglet : le
 * Flow ne force plus rien tant qu'un nouveau tour n'a pas redémarré.
 *
 * Toute la décision est isolée ici, dans une fonction pure, pour être testable
 * sans DOM et sans dépendre du rendu React. Le composant ne fait qu'appliquer
 * le résultat.
 */

/** Onglets d'outils pilotables par le Flow (sous-ensemble de `ToolTabId`). */
export type FlowTabId = "terminal" | "editor" | "diffview" | "browser";

/**
 * Outils canoniques du SDK Cline (cf. `toolPresentation.ts`) → onglet cible.
 *
 * - `editor`  : écrit un fichier → DiffView (c'est là qu'on juge le changement).
 * - `read_files` : lit des fichiers → Editor (on montre ce qui est lu).
 * - `run_commands` : exécute une commande → Terminal.
 * - `fetch_web_content` : consulte le web → Browser.
 * - Les autres outils (`search_codebase`, `skills`, `todo_write`, `ask_question`…)
 *   ne changent PAS d'onglet : ils n'ont pas de panneau dédié et forcer une
 *   bascule serait du bruit.
 */
const TOOL_TO_TAB: Record<string, FlowTabId> = {
  editor:             "diffview",
  apply_patch:        "diffview",   // défensif : désactivé dans le SDK, mais inoffensif
  read_files:         "editor",
  run_commands:       "terminal",
  fetch_web_content:  "browser",
};

/**
 * Détermine l'onglet à activer pour un tool-call donné.
 *
 * `undefined` = « ne pas changer d'onglet » (outil sans panneau associé, ou
 * outil inconnu). On reste alors sur l'onglet courant : c'est le comportement le
 * moins intrusif, et il évite tout clignotement sur les outils silencieux.
 */
export function flowTargetFor(toolName: string | undefined | null): FlowTabId | undefined {
  if (!toolName) return undefined;
  return TOOL_TO_TAB[toolName];
}

/**
 * Sélectionne le tool-call qui doit piloter le Flow, à partir d'une liste de
 * tool-calls `running` (dans l'ordre chronologique).
 *
 * On prend le DERNIER en cours : c'est l'étape réellement active. `undefined`
 * si aucun tool-call ne tourne (fin d'étape, texte en cours, run terminé).
 */
export function activeFlowTab(
  runningTools: { toolName: string }[],
): FlowTabId | undefined {
  for (let i = runningTools.length - 1; i >= 0; i--) {
    const tab = flowTargetFor(runningTools[i].toolName);
    if (tab) return tab;
  }
  return undefined;
}

/**
 * Doit-on appliquer une bascule Flow ? État d'entrée = « un run est en cours ».
 *
 * Le Flow ne s'active QUE pendant un run : hors run, l'utilisateur navigue
 * librement et on ne doit jamais lui voler son onglet. C'est la garde
 * d'observabilité qui évite les surprises (et une dépendance au rendu).
 */
export function shouldFlow(isRunning: boolean): boolean {
  return isRunning;
}
