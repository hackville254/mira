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
