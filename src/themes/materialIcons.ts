/**
 * Bundle natif d'icônes « Material » pour l'explorateur.
 *
 * Objectif : offrir, **sans aucune extension installée**, des icônes de fichiers
 * et dossiers proches de Material Icon Theme (comportement par défaut de VS Code
 * avec l'extension préinstallée).
 *
 * Conception :
 *  - un **catalogue de glyphes SVG** (chemins 16×16 monochromes) définis une fois ;
 *  - une **couleur par clé** (palette officielle Material Icon Theme) ;
 *  - un **mapping déclaratif** nom de fichier exact → clé, extension → clé,
 *    et un mapping **langage** → clé alimenté par le registre `lib/languages.ts` ;
 *  - un `resolveMaterialIcon(name, isDir, expanded, languageIcon)` qui renvoie une
 *    data-URI `image/svg+xml` prête pour un `<img>`.
 *
 * Sécurité : ce module est purement déclaratif (données statiques, aucun code
 * exécuté, aucune entrée utilisateur interprétée). Les SVG sont **générés ici**
 * (jamais lus depuis le disque), donc jamais issus d'une source non fiable.
 */

// ── Glyphes (chemins SVG 16×16) ──────────────────────────────────────────────
// Un glyphe générique « document » sert de repli pour toute clé sans forme dédiée.

const GLYPH_FILE =
  'M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5zM9.5 5V1.5L13.5 5z';
const GLYPH_FOLDER =
  'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.2.6l.8 1.1H13a1.5 1.5 0 0 1 1.5 1.5v6.3A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z';

/**
 * Formes SVG par clé. Chaque entrée est le contenu interne d'un `<svg viewBox>`
 * (paths monochromes). `fill="currentColor"` n'est pas utilisé : la couleur est
 * injectée par `iconDataUri`, ce qui permet de réutiliser une forme avec
 * plusieurs teintes.
 */
const SHAPES: Record<string, string> = {
  // Glyphes génériques
  file: `<path d="${GLYPH_FILE}"/>`,
  folder: `<path d="${GLYPH_FOLDER}"/>`,
  code: `<path d="M6 4 2 8l4 4M10 4l4 4-4 4"/>`,
  gear: `<path d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z"/><path d="M8 1.5v1.8M8 12.7v1.8M2.5 8H4.3M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3"/>`,
  text: `<path d="M3 3h10M3 6h10M3 9h7M3 12h5"/>`,
  image: `<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M4 12l3-3 2 2 3-3 2 2"/>`,
  db: `<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>`,
  terminal: `<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 7l2 2-2 2M8.5 11h3"/>`,
  hex: `<path d="M8 1.8 13 4.6v6.8L8 14.2 3 11.4V4.6z"/>`,
  braces: `<path d="M6 3c-1.5 0-2 .8-2 2v1.5c0 1-.6 1.5-1.5 1.5.9 0 1.5.5 1.5 1.5V13c0 1.2.5 2 2 2M10 3c1.5 0 2 .8 2 2v1.5c0 1 .6 1.5 1.5 1.5-.9 0-1.5.5-1.5 1.5V13c0 1.2-.5 2-2 2"/>`,
  sparkle: `<path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4z"/>`,
  cube: `<path d="M8 1.8 13.5 4.6v6.8L8 14.2 2.5 11.4V4.6z"/><path d="M2.5 4.6 8 7.4l5.5-2.8M8 7.4v6.8"/>`,
  git: `<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.6v4.8M6.1 12H9c1.4 0 2-.9 2.5-3.9"/>`,
  lock: `<rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>`,
  pdf: `<path d="${GLYPH_FILE}"/><path d="M5 11.5V9h1.2a1.3 1.3 0 0 1 0 2.5zM8.4 11.5V9h.8a1.3 1.3 0 0 1 0 2.5z"/>`,
  zip: `<path d="${GLYPH_FILE}"/><path d="M8 4.5v1M8 6.5v1M8 8.5v1"/>`,
};

// ── Couleurs (palette Material Icon Theme) ────────────────────────────────────

const COLORS: Record<string, string> = {
  file: '#90a4ae',
  folder: '#90a4ae',
  typescript: '#519aba',
  react_ts: '#519aba',
  javascript: '#cbcb41',
  react: '#519aba',
  css: '#42a5f5',
  sass: '#f55385',
  html: '#e44d26',
  json: '#cbcb41',
  markdown: '#519aba',
  xml: '#8dc149',
  rust: '#dea584',
  python: '#519aba',
  go: '#519aba',
  c: '#519aba',
  cpp: '#519aba',
  java: '#cc3e44',
  csharp: '#519aba',
  scala: '#cc3e44',
  kotlin: '#7f52ff',
  swift: '#e37933',
  dart: '#4fc3f7',
  ruby: '#cc3e44',
  php: '#a074c4',
  lua: '#51a0cf',
  perl: '#8dc149',
  r: '#519aba',
  erlang: '#cc3e44',
  haskell: '#8f7de0',
  clojure: '#8dc149',
  shell: '#8dc149',
  docker: '#519aba',
  makefile: '#8dc149',
  database: '#f55385',
  yaml: '#f55385',
  toml: '#cbcb41',
  settings: '#90a4ae',
  protobuf: '#90a4ae',
  git: '#e44d26',
  lock: '#e2a76f',
  pdf: '#cc3e44',
  zip: '#e2a76f',
  image: '#a074c4',
  text: '#90a4ae',
  default: '#90a4ae',
};

/** Forme assignée à chaque clé (repli : `file`). */
const SHAPE_FOR: Record<string, string> = {
  file: 'file', folder: 'folder',
  typescript: 'code', react_ts: 'code', javascript: 'code', react: 'code',
  css: 'braces', sass: 'braces',
  html: 'code', xml: 'code', markdown: 'text', json: 'braces',
  rust: 'gear', python: 'gear', go: 'code', c: 'code', cpp: 'code',
  java: 'cube', csharp: 'cube', scala: 'cube', kotlin: 'cube', swift: 'cube',
  dart: 'cube', ruby: 'sparkle', php: 'sparkle', lua: 'braces',
  perl: 'sparkle', r: 'code', erlang: 'code', haskell: 'code', clojure: 'braces',
  shell: 'terminal', docker: 'cube', makefile: 'gear',
  database: 'db', sql: 'db', yaml: 'braces', toml: 'braces',
  settings: 'gear', protobuf: 'hex',
  git: 'git', lock: 'lock', pdf: 'pdf', zip: 'zip', image: 'image', text: 'text',
};

// ── Mapping nom de fichier exact → clé ───────────────────────────────────────

const FILE_NAMES: Record<string, string> = {
  'dockerfile': 'docker',
  'makefile': 'makefile',
  'cmakelists.txt': 'settings',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'package.json': 'json',
  'package-lock.json': 'lock',
  'tsconfig.json': 'json',
  'cargo.toml': 'toml',
  'cargo.lock': 'lock',
  'go.mod': 'go',
  'go.sum': 'lock',
  'requirements.txt': 'python',
  'pyproject.toml': 'toml',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  'license': 'text',
  'license.txt': 'text',
  'license.md': 'markdown',
  'readme.md': 'markdown',
  'readme': 'markdown',
};

// ── Mapping extension → clé ──────────────────────────────────────────────────

const FILE_EXTENSIONS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react_ts', jsx: 'react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'sass', sass: 'sass',
  html: 'html', htm: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  xml: 'xml', svg: 'image',
  rs: 'rust',
  py: 'python', pyw: 'python', pyi: 'python',
  go: 'go',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  java: 'java',
  cs: 'csharp',
  scala: 'scala', sc: 'scala',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  rb: 'ruby', rake: 'ruby',
  php: 'php',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  erl: 'erlang', hrl: 'erlang',
  hs: 'haskell',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  dockerfile: 'docker',
  mk: 'makefile',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'settings', cfg: 'settings',
  proto: 'protobuf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image',
  pdf: 'pdf',
  zip: 'zip', tar: 'zip', gz: 'zip', rar: 'zip', '7z': 'zip',
  lock: 'lock',
  txt: 'text', log: 'text', csv: 'text',
};

// ── Construction des data-URI (mémoïsées) ────────────────────────────────────

const uriCache = new Map<string, string>();

/**
 * Construit une data-URI `image/svg+xml` pour une forme + une couleur.
 * Un `<img>` rendue telle est un média **passif** : le SVG ne peut pas exécuter
 * de script dans notre origine. Le contenu provient exclusivement de ce module.
 */
function iconDataUri(shapeKey: string, color: string): string {
  const cacheKey = `${shapeKey}|${color}`;
  const cached = uriCache.get(cacheKey);
  if (cached) return cached;

  const shape = SHAPES[shapeKey] ?? SHAPES.file;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" ` +
    `fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` +
    shape +
    `</svg>`;

  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  uriCache.set(cacheKey, uri);
  return uri;
}

/** Renvoie la clé d'icône « sémantique » pour un nom de fichier. */
function pickKey(name: string): string | null {
  const lower = name.toLowerCase();
  if (FILE_NAMES[lower]) return FILE_NAMES[lower];
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    if (FILE_EXTENSIONS[ext]) return FILE_EXTENSIONS[ext];
    return 'file';
  }
  // Fichier sans extension mais non répertorié.
  return lower.startsWith('.') ? 'settings' : 'file';
}

/**
 * Résout l'icône Material d'un fichier ou dossier, sous forme de data-URI.
 *
 * @param name         Nom du fichier/dossier (pas le chemin complet).
 * @param isDir        Vrai pour un dossier.
 * @param expanded     Vrai si un dossier est déplié.
 * @param languageIcon Clé d'icône issue du registre de langages (prioritaire sur
 *                     l'extension brute pour un fichier), ou null.
 * @returns            data-URI SVG, ou `null` si indéterminable (jamais ici : une
 *                     icône générique est toujours renvoyée).
 */
export function resolveMaterialIcon(
  name: string,
  isDir: boolean,
  expanded: boolean,
  languageIcon: string | null = null,
): string {
  if (isDir) {
    const key = 'folder';
    return iconDataUri(SHAPE_FOR[key] ?? 'folder', expanded ? '#42a5f5' : COLORS[key]);
  }
  // Priorité : clé de langage (registre) → mapping nom/extension.
  const key = (languageIcon && SHAPE_FOR[languageIcon] ? languageIcon : null) ?? pickKey(name) ?? 'file';
  const shape = SHAPE_FOR[key] ?? 'file';
  const color = COLORS[key] ?? COLORS.default;
  return iconDataUri(shape, color);
}
