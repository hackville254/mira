import { invoke } from '@tauri-apps/api/core';

export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

/** Options de recherche transmises au backend Rust. */
export interface SearchOptions {
  /** Le motif est une expression régulière (sinon littéral). */
  isRegex: boolean;
  /** Respecte la casse (insensible par défaut). */
  caseSensitive: boolean;
  /** N'accepte que des correspondances sur des mots entiers. */
  wholeWord: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
};

/** Conversion camelCase (front) → snake_case (serde Rust). */
function toWireOptions(o: SearchOptions) {
  return {
    is_regex: o.isRegex,
    case_sensitive: o.caseSensitive,
    whole_word: o.wholeWord,
  };
}

export async function searchInFiles(
  folder: string,
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  excludes = '',
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>('search_in_files', {
    folder,
    query,
    options: toWireOptions(options),
    excludes,
  });
}

export interface ReplaceResult {
  filesChanged: number;
  replacements: number;
  /** Chemins absolus des fichiers effectivement modifiés (pour rafraîchir les onglets). */
  files: string[];
}

/** Remplacement global dans le dossier. `files` limite l'action à des fichiers précis. */
export async function replaceInFiles(
  folder: string,
  query: string,
  replacement: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  excludes = '',
  files?: string[],
): Promise<ReplaceResult> {
  const raw = await invoke<{ files_changed: number; replacements: number; files: string[] }>('replace_in_files', {
    req: {
      folder,
      query,
      replacement,
      options: toWireOptions(options),
      excludes,
      files: files ?? null,
    },
  });
  return { filesChanged: raw.files_changed, replacements: raw.replacements, files: raw.files ?? [] };
}
