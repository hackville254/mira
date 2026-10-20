/**
 * Bus d'ouverture d'un onglet « Git diff » depuis le panneau Source Control.
 *
 * `SourceTreePanel` n'a pas accès aux onglets de l'éditeur (il vit dans la
 * sidebar, sans props de navigation). Plutôt que de faire remonter une prop à
 * travers toute la hiérarchie, on émet un événement window que `App` écoute —
 * même approche que `origin:git-changed` / le bus de drag.
 */

export const GIT_DIFF_EVENT = 'origin:open-git-diff';

export interface GitDiffRequest {
  /** Chemin ABSOLU du fichier à comparer à HEAD. */
  filePath: string;
  /** Racine du dépôt (workspace). */
  repoPath: string;
}

/** Demande l'ouverture (ou la réactivation) de l'onglet diff git du fichier. */
export function openGitDiff(req: GitDiffRequest): void {
  window.dispatchEvent(new CustomEvent<GitDiffRequest>(GIT_DIFF_EVENT, { detail: req }));
}

/** S'abonne aux demandes d'ouverture de diff git. Renvoie le désabonnement. */
export function onGitDiff(cb: (req: GitDiffRequest) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<GitDiffRequest>).detail);
  window.addEventListener(GIT_DIFF_EVENT, handler);
  return () => window.removeEventListener(GIT_DIFF_EVENT, handler);
}
