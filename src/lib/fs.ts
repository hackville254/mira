import { invoke } from '@tauri-apps/api/core';

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/**
 * Contexte de confinement passé aux commandes FS : la racine du workspace.
 * Le backend refuse (garde lexicale + canonicalisation anti-symlink) tout
 * chemin qui s'en échappe. Les appels hors explorateur peuvent l'omettre, mais
 * l'explorateur le fournit **toujours**.
 */
export interface FsScope {
  workspaceRoot?: string | null;
}

function scopeArg(scope?: FsScope) {
  return scope?.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {};
}

export async function readDir(path: string, scope?: FsScope): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('read_dir', { path, ...scopeArg(scope) });
}

export async function readFile(path: string, scope?: FsScope): Promise<string> {
  return invoke<string>('read_file', { path, ...scopeArg(scope) });
}

export async function writeFile(path: string, content: string, scope?: FsScope): Promise<void> {
  return invoke<void>('write_file', { path, content, ...scopeArg(scope) });
}

export async function renamePath(from: string, to: string, scope?: FsScope): Promise<void> {
  return invoke<void>('rename_path', { from, to, ...scopeArg(scope) });
}

export async function deletePath(path: string, scope?: FsScope): Promise<void> {
  return invoke<void>('delete_path', { path, ...scopeArg(scope) });
}

export async function createDirCmd(path: string, scope?: FsScope): Promise<void> {
  return invoke<void>('create_dir_cmd', { path, ...scopeArg(scope) });
}

/** Copie récursive (fichier ou dossier). La cible ne doit pas exister. */
export async function copyPath(from: string, to: string, scope?: FsScope): Promise<void> {
  return invoke<void>('copy_path', { from, to, ...scopeArg(scope) });
}

/** Teste l'existence d'un chemin (anti-écrasement / anti-doublon). */
export async function pathExists(path: string, scope?: FsScope): Promise<boolean> {
  return invoke<boolean>('path_exists', { path, ...scopeArg(scope) });
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>('reveal_in_explorer', { path });
}
