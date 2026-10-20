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
  includes = '',
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>('search_in_files', {
    folder,
    query,
    options: toWireOptions(options),
    excludes,
    includes,
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
  preserveCase = false,
  includes = '',
): Promise<ReplaceResult> {
  const raw = await invoke<{ files_changed: number; replacements: number; files: string[] }>('replace_in_files', {
    req: {
      folder,
      query,
      replacement,
      options: toWireOptions(options),
      excludes,
      includes,
      preserve_case: preserveCase,
      files: files ?? null,
    },
  });
  return { filesChanged: raw.files_changed, replacements: raw.replacements, files: raw.files ?? [] };
}

/**
 * Remplace UNE occurrence précise (ligne + col) — bouton « Replace » au survol
 * d'un résultat. Retourne `true` si une correspondance a été trouvée/remplacée.
 */
export async function replaceOne(
  path: string,
  query: string,
  replacement: string,
  line: number,
  col: number,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  preserveCase = false,
): Promise<boolean> {
  return invoke<boolean>('replace_one', {
    req: {
      path,
      query,
      replacement,
      options: toWireOptions(options),
      line,
      col,
      preserve_case: preserveCase,
    },
  });
}
