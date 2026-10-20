/**
 * Bus de « révélation » d'une sélection de code depuis le chat.
 *
 * Le badge de contexte du `ChatBox` vit dans le panneau IA, sans accès à la vue
 * CodeMirror de l'éditeur. Pour que cliquer dessus re-surligne le code concerné
 * (l'utilisateur est alors sûr de ce qui est épinglé), on émet un événement
 * window que l'éditeur écoute — même approche que `origin:git-changed` /
 * `gitDiffBus`, afin d'éviter de faire remonter une prop à travers toute la
 * hiérarchie.
 */

export const SELECTION_REVEAL_EVENT = 'origin:reveal-selection';

export interface SelectionRevealRequest {
  /** Nom de fichier (basename) porté par le contexte épinglé. */
  filename: string;
  /** Numéro de la première ligne concernée (1-based, inclus). */
  startLine: number;
  /** Numéro de la dernière ligne concernée (1-based, inclus). */
  endLine: number;
  /** Texte exact épinglé — sert de garde-fou pour ne surligner que si la plage
   *  correspond encore au même contenu. */
  code: string;
}

/** Demande à l'éditeur de surligner la sélection épinglée correspondante. */
export function revealSelection(req: SelectionRevealRequest): void {
  window.dispatchEvent(new CustomEvent<SelectionRevealRequest>(SELECTION_REVEAL_EVENT, { detail: req }));
}

/** S'abonne aux demandes de révélation. Renvoie le désabonnement. */
export function onRevealSelection(cb: (req: SelectionRevealRequest) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<SelectionRevealRequest>).detail);
  window.addEventListener(SELECTION_REVEAL_EVENT, handler);
  return () => window.removeEventListener(SELECTION_REVEAL_EVENT, handler);
}
