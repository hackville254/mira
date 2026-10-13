import { invoke } from '@tauri-apps/api/core';

export async function getBranch(path: string): Promise<string | null> {
  return invoke<string | null>('git_branch', { path });
}

export interface CommitEntry { hash: string; msg: string; }
export interface GitChanges { files: number; commits_ahead: number; log: CommitEntry[]; }

export async function getGitChanges(path: string): Promise<GitChanges | null> {
  try {
    return await invoke<GitChanges | null>('git_changes', { path });
  } catch {
    return null;
  }
}

export interface StatusFile { status: string; path: string; }
export interface FullCommitEntry { hash: string; subject: string; author: string; date: string; }
export interface BranchEntry { name: string; current: boolean; remote: boolean; }

export async function getStatusFiles(path: string): Promise<StatusFile[]> {
  return invoke<StatusFile[]>('git_status_files', { path }).catch(() => []);
}

export async function getGitLogFull(path: string): Promise<FullCommitEntry[]> {
  return invoke<FullCommitEntry[]>('git_log_full', { path }).catch(() => []);
}

export async function gitCommit(path: string, title: string, description: string): Promise<void> {
  await invoke('git_commit', { path, title, description });
}

export async function gitCommitPush(path: string, title: string, description: string): Promise<void> {
  await invoke('git_commit_push', { path, title, description });
}

// ── Staging ───────────────────────────────────────────────────────────────────

export async function gitStage(path: string, file: string): Promise<void> {
  await invoke('git_stage', { path, file });
}

export async function gitStageAll(path: string): Promise<void> {
  await invoke('git_stage_all', { path });
}

export async function gitUnstage(path: string, file: string): Promise<void> {
  await invoke('git_unstage', { path, file });
}

export async function gitDiscard(path: string, file: string): Promise<void> {
  await invoke('git_discard', { path, file });
}

// ── Remote ────────────────────────────────────────────────────────────────────

export async function gitPull(path: string): Promise<void> {
  await invoke('git_pull', { path });
}

export async function gitPush(path: string): Promise<void> {
  await invoke('git_push', { path });
}

export async function gitFetch(path: string): Promise<void> {
  await invoke('git_fetch', { path });
}

// ── Branches ──────────────────────────────────────────────────────────────────

export async function gitListBranches(path: string): Promise<BranchEntry[]> {
  return invoke<BranchEntry[]>('git_list_branches', { path }).catch(() => []);
}

export async function gitCheckout(path: string, branch: string): Promise<void> {
  await invoke('git_checkout', { path, branch });
}

export async function gitCreateBranch(path: string, branch: string): Promise<void> {
  await invoke('git_create_branch', { path, branch });
}

// ── Amend / Sync ──────────────────────────────────────────────────────────────

export async function gitCommitAmend(path: string, title: string, description: string): Promise<void> {
  await invoke('git_commit_amend', { path, title, description });
}

export async function gitCommitSync(path: string, title: string, description: string): Promise<void> {
  await invoke('git_commit_sync', { path, title, description });
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export async function gitDiff(path: string, maxBytes?: number): Promise<string> {
  return invoke<string>('git_diff', { path, maxBytes }).catch(() => '');
}

// ── Contenu à HEAD (base de comparaison du gutter de l'éditeur) ───────────────

export type GitHeadResult =
  | { status: 'tracked'; content: string }
  | { status: 'untracked' }
  | { status: 'none' };

/**
 * Renvoie le contenu de `file` tel qu'il est dans HEAD, pour la comparaison du
 * gutter :
 * - `tracked`   → contenu du blob HEAD ;
 * - `untracked` → le fichier n'existe pas dans HEAD (nouveau fichier) ;
 * - `none`      → `repoPath` n'est pas un dépôt git (aucun marqueur à afficher).
 *
 * `file` est un chemin **relatif** au workspace (`repoPath`).
 */
export async function gitFileHead(repoPath: string, file: string): Promise<GitHeadResult> {
  try {
    const content = await invoke<string | null>('git_file_head', { path: repoPath, file });
    return content === null ? { status: 'untracked' } : { status: 'tracked', content };
  } catch {
    return { status: 'none' };
  }
}

// ── Stash ─────────────────────────────────────────────────────────────────────

export interface StashEntry { index: number; branch: string; message: string; }

/** Enregistre les modifications courantes dans un stash (index 0 = plus récent). */
export async function gitStashSave(
  path: string,
  message?: string,
  includeUntracked?: boolean,
): Promise<void> {
  await invoke('git_stash_save', { path, message, includeUntracked });
}

export async function gitStashList(path: string): Promise<StashEntry[]> {
  return invoke<StashEntry[]>('git_stash_list', { path }).catch(() => []);
}

/** Applique un stash puis le retire de la pile. */
export async function gitStashPop(path: string, index: number): Promise<void> {
  await invoke('git_stash_pop', { path, index });
}

/** Applique un stash sans le retirer de la pile. */
export async function gitStashApply(path: string, index: number): Promise<void> {
  await invoke('git_stash_apply', { path, index });
}

export async function gitStashDrop(path: string, index: number): Promise<void> {
  await invoke('git_stash_drop', { path, index });
}

// ── Blame ─────────────────────────────────────────────────────────────────────

export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  /** Timestamp Unix (secondes). */
  time: number;
  summary: string;
}

/** Récupère l'annotation blame d'un fichier (relatif à la racine du dépôt). */
export async function gitBlame(root: string, relPath: string): Promise<BlameLine[]> {
  return invoke<BlameLine[]>('git_blame', { path: root, file: relPath }).catch(() => []);
}

// ── Bus d'événements git (rafraîchissement du gutter) ─────────────────────────

const GIT_CHANGED_EVENT = 'origin:git-changed';

/** Prévient les éditeurs ouverts qu'un état git a changé (commit, stage,
 *  checkout…), afin qu'ils rechargent leur référence HEAD. */
export function notifyGitChanged(): void {
  window.dispatchEvent(new Event(GIT_CHANGED_EVENT));
}

/** S'abonne aux changements d'état git. Renvoie une fonction de désabonnement. */
export function onGitChanged(cb: () => void): () => void {
  window.addEventListener(GIT_CHANGED_EVENT, cb);
  return () => window.removeEventListener(GIT_CHANGED_EVENT, cb);
}
