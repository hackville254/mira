/**
 * VS Code file-icon theme support.
 *
 * A file-icon theme (`contributes.iconThemes`) is a JSON file that maps file
 * names, extensions, folder names and language ids to an icon key, plus an
 * `iconDefinitions` table resolving each key to an `.svg` on disk.
 *
 * SECURITY: icon assets and the theme JSON come from installed extensions and
 * are therefore untrusted. We never inline their SVG markup into the DOM (which
 * could carry scripts/handlers); instead each SVG is loaded as text and rendered
 * through an `<img src="data:image/svg+xml,...">`, which the browser treats as a
 * passive image (no script execution). Paths are resolved through the confined
 * `readExtensionAsset` reader, which rejects traversal outside the extension.
 */
import { listExtensions, readExtensionAsset } from "../lib/extensions";

/** A file-icon theme offered in the Appearance settings. */
export interface FileIconTheme {
  /** Stable id: `${extensionId}:${themeId}`. Empty for the built-in default. */
  id: string;
  label: string;
  extensionId: string;
  /** Relative path of the theme JSON inside the extension. */
  relPath: string;
}

/** The built-in (no icon theme) entry — falls back to the native Material set. */
export const BUILTIN_ICON_THEME: FileIconTheme = {
  id: "",
  label: "Material Icons (built-in)",
  extensionId: "",
  relPath: "",
};

interface IconDefinition {
  iconPath?: string;
}

interface RawIconTheme {
  iconDefinitions?: Record<string, IconDefinition>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
}

/**
 * Resolves a file/folder entry to an SVG data-URI. Instances are created by
 * `createIconResolver`; lookups are synchronous once the theme JSON is parsed,
 * while SVG contents are loaded lazily and cached.
 */
export interface IconResolver {
  /** SVG data-URI for an entry, or `null` when the theme has no match. */
  resolve(name: string, isDir: boolean, expanded: boolean): string | null;
}

/** Read-only view of the parsed theme used for synchronous key lookups. */
interface ParsedTheme {
  raw: RawIconTheme;
  /** Absolute-ish base dir of the theme file, for resolving icon paths. */
  baseDir: string;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Join a theme-relative icon path against the theme file's directory. */
function joinPath(base: string, rel: string): string {
  const clean = rel.replace(/^\.\//, "");
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = (base ? base + "/" + clean : clean).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function pickKey(raw: RawIconTheme, name: string, isDir: boolean, expanded: boolean): string | undefined {
  const lower = name.toLowerCase();
  if (isDir) {
    if (expanded) {
      return raw.folderNamesExpanded?.[lower] ?? raw.folderExpanded ?? raw.folder;
    }
    return raw.folderNames?.[lower] ?? raw.folder;
  }
  if (raw.fileNames && raw.fileNames[lower]) return raw.fileNames[lower];
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    if (raw.fileExtensions && raw.fileExtensions[ext]) return raw.fileExtensions[ext];
  }
  return raw.file;
}

/**
 * Build a resolver for one icon theme. Parsing the JSON is cheap (mapping
 * tables only); SVG content is fetched on first use and cached, so a theme with
 * >1000 icons never loads them all up front.
 */
export async function createIconResolver(
  extensionId: string,
  relPath: string
): Promise<IconResolver | null> {
  let raw: RawIconTheme;
  try {
    const json = await readExtensionAsset(extensionId, relPath);
    raw = JSON.parse(json) as RawIconTheme;
  } catch (e) {
    console.warn(`Failed to load icon theme ${extensionId}:${relPath}`, e);
    return null;
  }
  const theme: ParsedTheme = { raw, baseDir: dirname(relPath) };
  const cache = new Map<string, string | null>();

  async function loadIcon(iconPath: string): Promise<string | null> {
    const rel = joinPath(theme.baseDir, iconPath);
    try {
      const svg = await readExtensionAsset(extensionId, rel);
      // Encode as a data URI so it is rendered as a passive image, never as
      // live markup (SVG from an extension must not run scripts in our origin).
      const encoded = encodeURIComponent(svg.trim())
        .replace(/'/g, "%27")
        .replace(/"/g, "%22");
      return `data:image/svg+xml;charset=utf-8,${encoded}`;
    } catch {
      return null;
    }
  }

  return {
    resolve(name, isDir, expanded) {
      const key = pickKey(theme.raw, name, isDir, expanded);
      if (!key) return null;
      const def = theme.raw.iconDefinitions?.[key];
      const iconPath = def?.iconPath;
      if (!iconPath) return null;
      if (cache.has(iconPath)) return cache.get(iconPath) ?? null;
      // Kick off the async load; return null for now, and re-render once cached.
      void loadIcon(iconPath).then((uri) => {
        cache.set(iconPath, uri);
        if (uri) notify();
      });
      cache.set(iconPath, null);
      return null;
    },
  };
}

// ── Change notification (so lazily-loaded icons trigger a re-render) ─────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to icon-resolution updates (fired when a lazy SVG finishes loading). */
export function subscribeIconUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Discover every file-icon theme contributed by installed extensions. */
export async function loadFileIconThemes(): Promise<FileIconTheme[]> {
  return loadIconThemesOfKind("icon-theme");
}

/** Discover every product-icon theme contributed by installed extensions. */
export async function loadProductIconThemes(): Promise<FileIconTheme[]> {
  return loadIconThemesOfKind("product-icon-theme");
}

async function loadIconThemesOfKind(
  kind: "icon-theme" | "product-icon-theme"
): Promise<FileIconTheme[]> {
  const out: FileIconTheme[] = [];
  let extensions;
  try {
    extensions = await listExtensions();
  } catch {
    return out;
  }
  for (const ext of extensions) {
    for (const contrib of ext.contributions) {
      if (contrib.kind !== kind) continue;
      out.push({
        id: `${ext.id}:${contrib.label ?? contrib.path}`,
        label: contrib.label ? `${contrib.label} (${ext.name})` : ext.display_name,
        extensionId: ext.id,
        relPath: contrib.path,
      });
    }
  }
  return out;
}
