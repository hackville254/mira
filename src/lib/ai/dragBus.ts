/**
 * Bus de « drag interne » vers l'input du chat.
 *
 * Pourquoi un bus : le drag d'un élément de l'explorateur (`ExplorerTree`) est
 * implémenté en PointerEvents au niveau `window` (voir `ExplorerTree.onMove`),
 * PAS en HTML5 Drag & Drop. Un tel drag ne renseigne donc AUCUN `dataTransfer` :
 * l'input du chat ne peut pas le recevoir via `onDrop`. Et l'arbre vit dans un
 * arbre React sans rapport avec le chat (Sidebar vs AiPanel).
 *
 * On expose donc une capacité minuscule et symétrique à `refreshBus` :
 *  - l'arbre PUBLIE les chemins en cours de drag (`beginPathDrag`) ;
 *  - il EFFACE à la fin (`endPathDrag`) ;
 *  - l'input LIT l'état (`getPathDrag`) et s'abonne aux transitions
 *    (`subscribePathDrag`) pour afficher son état « déposer ici ».
 *
 * Portée volontairement réduite : un seul payload à la fois, pas d'historique.
 * Le drag natif depuis le Finder/OS n'emprunte PAS ce bus : il est reçu via
 * `onDragDropEvent` de Tauri (qui fournit les chemins absolus).
 */

export interface PathDragPayload {
  /** Chemins absolus des éléments glissés (fichiers et/ou dossiers). */
  paths: string[];
}

type PathDragListener = (payload: PathDragPayload | null) => void;

let current: PathDragPayload | null = null;
const listeners = new Set<PathDragListener>();

/** Payload de drag en cours, ou `null` si aucun. */
export function getPathDrag(): PathDragPayload | null {
  return current;
}

/**
 * Abonne un consommateur aux transitions (début / fin de drag). Le callback
 * reçoit aussi l'état courant immédiatement, pour couvrir le cas d'un abonné
 * monté *pendant* un drag (le chat peut apparaître en cours d'opération).
 * Retourne la fonction de désabonnement.
 */
export function subscribePathDrag(listener: PathDragListener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Publie le début (ou la mise à jour) d'un drag de chemins. */
export function beginPathDrag(paths: string[]): void {
  if (paths.length === 0) {
    endPathDrag();
    return;
  }
  current = { paths };
  for (const l of listeners) {
    try { l(current); } catch { /* un abonné défaillant ne casse pas l'émetteur */ }
  }
}

/**
 * Signale la fin d'un drag. `false` = l'input a CONSOMMÉ le drop : l'arbre doit
 * alors annuler son propre drop interne (réorganisation de fichiers), sinon le
 * dossier serait à la fois attaché au chat ET déplacé dans l'arbre. Renvoie
 * `true` si le drag était déjà terminé (appel idempotent).
 */
export function endPathDrag(): void {
  if (current === null) return;
  current = null;
  for (const l of listeners) {
    try { l(null); } catch { /* idem */ }
  }
}
