/**
 * Registre unique des langages supportés par l'éditeur.
 *
 * Source de vérité unique pour :
 *  - le **label** affiché (StatusBar, contexte IA…) ;
 *  - la **coloration syntaxique** (parser CodeMirror 6) ;
 *  - l'identité **LSP** (serveur interne + languageId envoyé au serveur).
 *
 * Toute détection de langage (extension de fichier ou nom de fichier exact)
 * DOIT passer par ce module. Cela évite les divergences historiques entre
 * `languageSupport.ts`, `lsp.ts` et les extensions TextMate.
 *
 * Politique de sécurité : ce module est purement déclaratif (données statiques
 * + factories de parser). Aucune entrée utilisateur n'est interprétée ici, aucun
 * code n'est exécuté depuis le disque.
 */
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import type { StreamParser as CmStreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
// Modes CM5 convertis en StreamLanguage (couverture des langages sans parser moderne).
import { c, cpp, java, csharp, scala, kotlin, dart } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { sql } from '@codemirror/legacy-modes/mode/sql';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { sass } from '@codemirror/legacy-modes/mode/sass';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { properties } from '@codemirror/legacy-modes/mode/properties';

/** Identifiant de serveur LSP interne (aligné sur `lsp_exe_and_args` côté Rust). */
export type LspLanguage = 'typescript' | 'rust' | 'python';

/**
 * Adapte un mode CM5 (`@codemirror/legacy-modes`) en extension CodeMirror 6.
 *
 * `legacy-modes` type ses parsers via `@codemirror/streamparser`, un paquet de
 * compatibilité dont la classe `StreamParser` est structurellement identique à
 * celle de `@codemirror/language` mais nominalement distincte (propriété privée
 * `tabSize` déclarée séparément). Le cast ci-dessous est sûr : les deux API
 * partagent le même contrat runtime. Il est isolé ici pour ne pas polluer le
 * reste du registre.
 */
function legacy(parser: unknown): Extension {
  return StreamLanguage.define(parser as CmStreamParser<unknown>);
}

export interface LanguageDef {
  /** Identifiant stable du langage (VS Code-like, ex. "typescript"). */
  id: string;
  /** Libellé affiché à l'utilisateur (ex. "TypeScript"). */
  label: string;
  /** Extensions de fichier (sans point, en minuscules) revendiquées. */
  extensions: string[];
  /** Noms de fichier exacts revendiqués (ex. "Dockerfile", "Makefile"). */
  filenames?: string[];
  /**
   * Factory du parser CodeMirror. Retourne `[]` si aucune coloration n'est
   * disponible (le langage reste alors reconnu mais affiché en texte brut).
   */
  parser: () => Extension;
  /** Serveur LSP interne capable de traiter ce langage, si disponible. */
  lsp?: LspLanguage;
  /** languageId envoyé à un serveur LSP (par défaut : `id`). */
  languageId?: string;
}

/**
 * Table des langages. L'ordre est sans importance fonctionnelle : la détection
 * par nom de fichier exact est prioritaire sur l'extension, et la première
 * correspondance d'extension gagne.
 */
export const LANGUAGES: LanguageDef[] = [
  // ── Web / data ────────────────────────────────────────────────────────────
  {
    id: 'typescript', label: 'TypeScript', extensions: ['ts', 'mts', 'cts'],
    parser: () => javascript({ typescript: true }),
    lsp: 'typescript', languageId: 'typescript',
  },
  {
    id: 'typescriptreact', label: 'TypeScript JSX', extensions: ['tsx'],
    parser: () => javascript({ typescript: true, jsx: true }),
    lsp: 'typescript', languageId: 'typescriptreact',
  },
  {
    id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs', 'cjs'],
    parser: () => javascript(),
    lsp: 'typescript', languageId: 'javascript',
  },
  {
    id: 'javascriptreact', label: 'JavaScript JSX', extensions: ['jsx'],
    parser: () => javascript({ jsx: true }),
    lsp: 'typescript', languageId: 'javascriptreact',
  },
  { id: 'css', label: 'CSS', extensions: ['css'], parser: () => css() },
  { id: 'scss', label: 'SCSS', extensions: ['scss'], parser: () => css() },
  { id: 'sass', label: 'Sass', extensions: ['sass'], parser: () => legacy(sass) },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm'], parser: () => html() },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc'], parser: () => json() },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'mdx'], parser: () => markdown() },
  { id: 'xml', label: 'XML', extensions: ['xml', 'svg'], parser: () => legacy(xml) },

  // ── Systèmes / backend ────────────────────────────────────────────────────
  { id: 'rust', label: 'Rust', extensions: ['rs'], parser: () => rust(), lsp: 'rust', languageId: 'rust' },
  {
    id: 'python', label: 'Python', extensions: ['py', 'pyw', 'pyi'],
    parser: () => python(), lsp: 'python', languageId: 'python',
  },
  { id: 'go', label: 'Go', extensions: ['go'], parser: () => legacy(go) },
  { id: 'c', label: 'C', extensions: ['c', 'h'], parser: () => legacy(c) },
  { id: 'cpp', label: 'C++', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], parser: () => legacy(cpp) },
  { id: 'java', label: 'Java', extensions: ['java'], parser: () => legacy(java) },
  { id: 'csharp', label: 'C#', extensions: ['cs'], parser: () => legacy(csharp) },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sc'], parser: () => legacy(scala) },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], parser: () => legacy(kotlin) },
  { id: 'swift', label: 'Swift', extensions: ['swift'], parser: () => legacy(swift) },
  { id: 'dart', label: 'Dart', extensions: ['dart'], parser: () => legacy(dart) },
  { id: 'ruby', label: 'Ruby', extensions: ['rb', 'rake'], filenames: ['Rakefile', 'Gemfile'], parser: () => legacy(ruby) },
  { id: 'php', label: 'PHP', extensions: ['php'], parser: () => [] },
  { id: 'lua', label: 'Lua', extensions: ['lua'], parser: () => legacy(lua) },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm'], parser: () => legacy(perl) },
  { id: 'r', label: 'R', extensions: ['r'], parser: () => legacy(r) },
  { id: 'erlang', label: 'Erlang', extensions: ['erl', 'hrl'], parser: () => legacy(erlang) },
  { id: 'haskell', label: 'Haskell', extensions: ['hs'], parser: () => legacy(haskell) },
  { id: 'clojure', label: 'Clojure', extensions: ['clj', 'cljs', 'cljc'], parser: () => legacy(clojure) },

  // ── Shell / infra ─────────────────────────────────────────────────────────
  { id: 'shellscript', label: 'Shell Script', extensions: ['sh', 'bash', 'zsh'], parser: () => legacy(shell) },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], filenames: ['Dockerfile'], parser: () => legacy(dockerFile) },
  { id: 'makefile', label: 'Makefile', extensions: ['mk'], filenames: ['Makefile'], parser: () => [] },
  { id: 'sql', label: 'SQL', extensions: ['sql'], parser: () => legacy(sql) },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], parser: () => legacy(yaml) },
  { id: 'toml', label: 'TOML', extensions: ['toml'], parser: () => legacy(toml) },
  { id: 'ini', label: 'INI', extensions: ['ini', 'cfg'], parser: () => legacy(properties) },
  { id: 'protobuf', label: 'Protobuf', extensions: ['proto'], parser: () => legacy(protobuf) },
];

// ── Index dérivés (construits une seule fois) ────────────────────────────────

const byId = new Map<string, LanguageDef>();
const byFilename = new Map<string, LanguageDef>();
const byExtension = new Map<string, LanguageDef>();

for (const lang of LANGUAGES) {
  if (byId.has(lang.id)) {
    // Garde-fou : un id dupliqué signalerait une erreur de déclaration.
    throw new Error(`Duplicate language id in registry: ${lang.id}`);
  }
  byId.set(lang.id, lang);
  for (const name of lang.filenames ?? []) {
    if (!byFilename.has(name)) byFilename.set(name, lang);
  }
  for (const ext of lang.extensions) {
    if (!byExtension.has(ext)) byExtension.set(ext, lang);
  }
}

// ── Résolution ────────────────────────────────────────────────────────────────

/** Extrait le nom de fichier (dernier segment) d'un chemin POSIX ou Windows. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Extrait l'extension (sans point, en minuscules) d'un chemin. */
function extensionOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Résout la définition de langage d'un chemin de fichier.
 * Priorité : nom de fichier exact, puis extension. `null` si inconnu.
 */
export function resolveLanguage(path: string | null | undefined): LanguageDef | null {
  if (!path || path.startsWith('__untitled__')) return null;
  const exact = byFilename.get(basename(path));
  if (exact) return exact;
  const ext = extensionOf(path);
  return ext ? byExtension.get(ext) ?? null : null;
}

/** Libellé affiché pour un chemin (jamais vide ; "Plain Text" par défaut). */
export function languageLabel(path: string | null | undefined): string {
  return resolveLanguage(path)?.label ?? 'Plain Text';
}

/** Extension CodeMirror de coloration pour un chemin (`[]` si non supporté). */
export function getLanguageExtension(path: string | null | undefined): Extension {
  return resolveLanguage(path)?.parser() ?? [];
}

/** Serveur LSP interne capable de traiter un chemin, ou `null`. */
export function getLspLanguage(path: string | null | undefined): LspLanguage | null {
  return resolveLanguage(path)?.lsp ?? null;
}

/** languageId LSP envoyé au serveur (défaut "plaintext"). */
export function getLspLanguageId(path: string | null | undefined): string {
  const def = resolveLanguage(path);
  return def?.languageId ?? def?.id ?? 'plaintext';
}

/** Liste de tous les identifiants LSP internes couverts par le registre. */
export function getSupportedLspLanguages(): LspLanguage[] {
  const set = new Set<LspLanguage>();
  for (const lang of LANGUAGES) if (lang.lsp) set.add(lang.lsp);
  return [...set];
}
