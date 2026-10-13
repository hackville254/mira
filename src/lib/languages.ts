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

/** Identifiant d'un serveur LSP interne (aligné sur l'allowlist `lsp.rs`). */
export type LspServerId = string;

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
  lsp?: LspServerId;
  /** languageId envoyé à un serveur LSP (par défaut : `id`). */
  languageId?: string;
  /**
   * Clé d'icône Material (bundle natif `themes/materialIcons.ts`) associée au
   * langage. Permet à l'explorateur de résoudre une icône par **langage** et non
   * par extension brute, en cohérence avec la coloration et le LSP.
   */
  icon?: string;
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
    lsp: 'typescript-language-server', languageId: 'typescript',
    icon: 'typescript',
  },
  {
    id: 'typescriptreact', label: 'TypeScript JSX', extensions: ['tsx'],
    parser: () => javascript({ typescript: true, jsx: true }),
    lsp: 'typescript-language-server', languageId: 'typescriptreact',
    icon: 'react_ts',
  },
  {
    id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs', 'cjs'],
    parser: () => javascript(),
    lsp: 'typescript-language-server', languageId: 'javascript',
    icon: 'javascript',
  },
  {
    id: 'javascriptreact', label: 'JavaScript JSX', extensions: ['jsx'],
    parser: () => javascript({ jsx: true }),
    lsp: 'typescript-language-server', languageId: 'javascriptreact',
    icon: 'react',
  },
  { id: 'css', label: 'CSS', extensions: ['css'], parser: () => css(), lsp: 'vscode-css-language-server', languageId: 'css', icon: 'css' },
  { id: 'scss', label: 'SCSS', extensions: ['scss'], parser: () => css(), lsp: 'vscode-css-language-server', languageId: 'scss', icon: 'sass' },
  { id: 'sass', label: 'Sass', extensions: ['sass'], parser: () => legacy(sass), icon: 'sass' },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm'], parser: () => html(), lsp: 'vscode-html-language-server', languageId: 'html', icon: 'html' },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc'], parser: () => json(), lsp: 'vscode-json-language-server', languageId: 'json', icon: 'json' },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'mdx'], parser: () => markdown(), lsp: 'marksman', languageId: 'markdown', icon: 'markdown' },
  { id: 'xml', label: 'XML', extensions: ['xml', 'svg'], parser: () => legacy(xml), icon: 'xml' },

  // ── Systèmes / backend ────────────────────────────────────────────────────
  { id: 'rust', label: 'Rust', extensions: ['rs'], parser: () => rust(), lsp: 'rust-analyzer', languageId: 'rust', icon: 'rust' },
  {
    id: 'python', label: 'Python', extensions: ['py', 'pyw', 'pyi'],
    parser: () => python(), lsp: 'pylsp', languageId: 'python',
    icon: 'python',
  },
  { id: 'go', label: 'Go', extensions: ['go'], parser: () => legacy(go), lsp: 'gopls', languageId: 'go', icon: 'go' },
  { id: 'c', label: 'C', extensions: ['c', 'h'], parser: () => legacy(c), lsp: 'clangd', languageId: 'c', icon: 'c' },
  { id: 'cpp', label: 'C++', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], parser: () => legacy(cpp), lsp: 'clangd', languageId: 'cpp', icon: 'cpp' },
  { id: 'java', label: 'Java', extensions: ['java'], parser: () => legacy(java), lsp: 'jdtls', languageId: 'java', icon: 'java' },
  { id: 'csharp', label: 'C#', extensions: ['cs'], parser: () => legacy(csharp), icon: 'csharp' },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sc'], parser: () => legacy(scala), icon: 'scala' },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt'], parser: () => legacy(kotlin), icon: 'kotlin' },
  // Kotlin Script (build.gradle.kts) : coloration Kotlin.
  { id: 'kotlin-script', label: 'Kotlin Script', extensions: ['kts'], parser: () => legacy(kotlin), icon: 'kotlin' },
  // Gradle (Groovy DSL) : proche de Groovy ; coloration Kotlin par repli raisonnable.
  { id: 'gradle', label: 'Gradle', extensions: ['gradle'], parser: () => legacy(kotlin), icon: 'android' },
  { id: 'swift', label: 'Swift', extensions: ['swift'], parser: () => legacy(swift), icon: 'swift' },
  { id: 'dart', label: 'Dart', extensions: ['dart'], parser: () => legacy(dart), lsp: 'dart-analysis-server', languageId: 'dart', icon: 'dart' },
  // Manifeste / propriétés Apple (Info.plist) : coloration XML.
  { id: 'plist', label: 'Property List', extensions: ['plist'], parser: () => legacy(xml), icon: 'apple' },
  { id: 'ruby', label: 'Ruby', extensions: ['rb', 'rake'], filenames: ['Rakefile', 'Gemfile', 'Podfile', 'Fastfile', 'Appfile'], parser: () => legacy(ruby), icon: 'ruby' },
  { id: 'php', label: 'PHP', extensions: ['php'], parser: () => [], icon: 'php' },
  { id: 'lua', label: 'Lua', extensions: ['lua'], parser: () => legacy(lua), icon: 'lua' },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm'], parser: () => legacy(perl), icon: 'perl' },
  { id: 'r', label: 'R', extensions: ['r'], parser: () => legacy(r), icon: 'r' },
  { id: 'erlang', label: 'Erlang', extensions: ['erl', 'hrl'], parser: () => legacy(erlang), icon: 'erlang' },
  { id: 'haskell', label: 'Haskell', extensions: ['hs'], parser: () => legacy(haskell), icon: 'haskell' },
  { id: 'clojure', label: 'Clojure', extensions: ['clj', 'cljs', 'cljc'], parser: () => legacy(clojure), icon: 'clojure' },

  // ── Shell / infra ─────────────────────────────────────────────────────────
  { id: 'shellscript', label: 'Shell Script', extensions: ['sh', 'bash', 'zsh'], parser: () => legacy(shell), lsp: 'bash-language-server', languageId: 'shellscript', icon: 'shell' },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], filenames: ['Dockerfile'], parser: () => legacy(dockerFile), lsp: 'dockerfile-language-server-nodejs', languageId: 'dockerfile', icon: 'docker' },
  { id: 'makefile', label: 'Makefile', extensions: ['mk'], filenames: ['Makefile'], parser: () => [], icon: 'makefile' },
  { id: 'sql', label: 'SQL', extensions: ['sql'], parser: () => legacy(sql), icon: 'database' },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], parser: () => legacy(yaml), lsp: 'yaml-language-server', languageId: 'yaml', icon: 'yaml' },
  { id: 'toml', label: 'TOML', extensions: ['toml'], parser: () => legacy(toml), icon: 'toml' },
  { id: 'ini', label: 'INI', extensions: ['ini', 'cfg'], parser: () => legacy(properties), icon: 'settings' },
  { id: 'protobuf', label: 'Protobuf', extensions: ['proto'], parser: () => legacy(protobuf), icon: 'protobuf' },
  // ── Frameworks web (SFC, HTML-like) ───────────────────────────────────────
  { id: 'svelte', label: 'Svelte', extensions: ['svelte'], parser: () => html(), lsp: 'svelte-language-server', languageId: 'svelte', icon: 'svelte' },
  { id: 'vue', label: 'Vue', extensions: ['vue'], parser: () => html(), lsp: 'vue-language-server', languageId: 'vue', icon: 'vue' },
  { id: 'astro', label: 'Astro', extensions: ['astro'], parser: () => html(), lsp: 'astro-language-server', languageId: 'astro', icon: 'astro' },
  { id: 'prisma', label: 'Prisma', extensions: ['prisma'], parser: () => [], lsp: 'prisma-language-server', languageId: 'prisma', icon: 'prisma' },
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
export function getLspServerId(path: string | null | undefined): LspServerId | null {
  return resolveLanguage(path)?.lsp ?? null;
}

/** languageId LSP envoyé au serveur (défaut "plaintext"). */
export function getLspLanguageId(path: string | null | undefined): string {
  const def = resolveLanguage(path);
  return def?.languageId ?? def?.id ?? 'plaintext';
}

/** Indique si un chemin est pris en charge par un serveur LSP interne. */
export function isLspSupported(path: string | null | undefined): boolean {
  return resolveLanguage(path)?.lsp != null;
}

/** Liste de tous les identifiants de serveurs LSP couverts par le registre. */
export function getSupportedLspServerIds(): LspServerId[] {
  const set = new Set<LspServerId>();
  for (const lang of LANGUAGES) if (lang.lsp) set.add(lang.lsp);
  return [...set];
}

/** Clé d'icône Material associée à un chemin, ou `null` si le langage est inconnu. */
export function getLanguageIcon(path: string | null | undefined): string | null {
  return resolveLanguage(path)?.icon ?? null;
}

/** Libellé du langage associé à un chemin (alias explicite de `languageLabel`). */
export function getLanguageLabel(path: string | null | undefined): string {
  return languageLabel(path);
}
