import { invoke } from '@tauri-apps/api/core';

export interface ExtensionContribution {
  kind: 'grammar' | 'snippet' | 'theme' | 'icon-theme' | 'product-icon-theme';
  language?: string | null;
  path: string;
  label?: string | null;
  /** File extensions (no dot) this contribution claims, when declared. */
  file_extensions?: string[];
  /** Exact file names (e.g. `Dockerfile`) this contribution claims. */
  file_names?: string[];
}

/** A command declared in `contributes.commands` (metadata only). */
export interface DeclaredCommand {
  command: string;
  title: string;
  category?: string | null;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  publisher: string;
  version: string;
  display_name: string;
  description: string;
  path: string;
  contributions: ExtensionContribution[];
  has_main: boolean;
  /** Relative entrypoint path declared by `main`. */
  main?: string | null;
  /** Commands declared in the manifest. */
  commands?: DeclaredCommand[];
  /** Raw `activationEvents` strings. */
  activation_events?: string[];
  /** Ids of extensions this one requires (`extensionDependencies`). */
  extension_dependencies?: string[];
  /** Ids bundled by this one (`extensionPack`). Informational. */
  extension_pack?: string[];
  /**
   * Executables tiers embarqués/lancés par l'extension (`origin.binaries`),
   * chemins relatifs au dossier de l'extension. Chaque binaire exige un
   * consentement explicite de l'utilisateur au premier usage.
   */
  binaries?: string[];
}

/** Root folder where extensions are installed. */
export async function extensionsRootPath(): Promise<string> {
  return invoke<string>('extensions_root_path');
}

/** List every installed extension (parsed from disk, nothing executed). */
export async function listExtensions(): Promise<ExtensionInfo[]> {
  try {
    return await invoke<ExtensionInfo[]>('list_extensions');
  } catch {
    return [];
  }
}

/** Inspect an uninstalled `.vsix` file without installing it. */
export async function inspectExtension(sourcePath: string): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>('inspect_extension', { sourcePath });
}

/** Install a `.vsix` from a local file path. */
export async function installExtension(sourcePath: string): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>('install_extension', { sourcePath });
}

/** Remove an installed extension by id. */
export async function uninstallExtension(id: string): Promise<void> {
  return invoke<void>('uninstall_extension', { id });
}

/** Read a contribution asset (grammar/snippet/theme JSON) as text. */
export async function readExtensionAsset(id: string, relPath: string): Promise<string> {
  return invoke<string>('read_extension_asset', { id, relPath });
}

/**
 * Read and parse an installed extension's `package.json`.
 *
 * Reuses the confined asset reader (path traversal is rejected in the backend),
 * so extensions that inspect their own manifest — or another's — get the real
 * `contributes` tree instead of a lossy synthetic stub. Returns `null` when the
 * manifest cannot be read/parsed; callers must degrade gracefully.
 */
export async function readExtensionManifest(id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readExtensionAsset(id, 'package.json');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Open VSX marketplace (Level 1 — passive assets only)
// ---------------------------------------------------------------------------

/** A search hit from the Open VSX registry. */
export interface MarketExtension {
  namespace: string;
  name: string;
  /** `namespace.name` */
  id: string;
  display_name: string;
  description: string;
  version: string;
  download_count: number;
  average_rating: number;
  verified: boolean;
  icon_url?: string | null;
  url: string;
}

export interface MarketSearchResult {
  total: number;
  offset: number;
  extensions: MarketExtension[];
}

/**
 * Search the Open VSX registry. The backend validates/encodes the query and
 * locks the host to open-vsx.org — the webview never supplies a URL.
 */
export async function marketSearch(query: string, size = 30, offset = 0): Promise<MarketSearchResult> {
  return invoke<MarketSearchResult>('market_search', { query, size, offset });
}

/**
 * Download a `.vsix` for `namespace.name@version` from Open VSX and install it.
 * Returns the installed extension metadata.
 */
export async function marketInstall(namespace: string, name: string, version: string): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>('market_install', { namespace, name, version });
}
