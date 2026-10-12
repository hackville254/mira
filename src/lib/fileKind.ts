/**
 * Classification d'un fichier par son extension, pour choisir **comment
 * l'afficher** dans l'éditeur : rendu texte (CodeMirror), image, PDF, ou
 * « binaire non supporté » (message explicite plutôt qu'un écran d'erreur).
 *
 * Module pur (aucune dépendance), donc testable en isolation. La source de
 * vérité pour la coloration du texte reste `languages.ts` ; ici on ne décide
 * que du **mode de rendu**.
 */

export type FileKind = 'text' | 'image' | 'pdf' | 'binary';

/** Extensions rendues comme des images (SVG inclus : c'est un texte, mais on
 *  l'affiche comme une image, c'est l'attendu utilisateur). */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
]);

const PDF_EXTENSIONS = new Set(['pdf']);

/** Extensions binaires connues qui n'ont pas de lecteur dédié (on affiche un
 *  message clair au lieu de tenter un décodage texte voué à l'échec). */
const BINARY_EXTENSIONS = new Set([
  // Archives
  'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz', 'tgz',
  // Documents / médias
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  // Binaires/objets
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'sqlite', 'db', 'dat', 'dmg', 'iso', 'img', 'apk', 'ipa',
]);

/** Extrait l'extension (sans point, en minuscules) d'un chemin, ou ''. */
export function extensionOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // pas de point, ou fichier caché type « .gitignore »
  return base.slice(dot + 1).toLowerCase();
}

/** Type de média MIME pour un rendu image (data URL). SVG = image/svg+xml. */
export function imageMimeOf(path: string): string {
  switch (extensionOf(path)) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp':  return 'image/bmp';
    case 'ico':  return 'image/x-icon';
    case 'avif': return 'image/avif';
    case 'svg':  return 'image/svg+xml';
    case 'png':
    default:     return 'image/png';
  }
}

/**
 * Classe un chemin : `'text'` (éditable), `'image'`, `'pdf'` (lecteurs dédiés),
 * ou `'binary'` (message « non supporté »). Les sentinelles d'onglets
 * (`__untitled__`, `__diff__`…) sont toujours du texte.
 */
export function fileKindOf(path: string | null | undefined): FileKind {
  if (!path || path.startsWith('__')) return 'text';
  const ext = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return 'text';
}

/** Vrai si le fichier doit être lu en binaire (image/PDF) plutôt qu'en texte. */
export function isBinaryReadable(path: string | null | undefined): boolean {
  const kind = fileKindOf(path);
  return kind === 'image' || kind === 'pdf';
}
