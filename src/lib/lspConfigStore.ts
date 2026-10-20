/**
 * Résolution et persistance de la configuration LSP.
 *
 * Précédence : **workspace** (`.origin/lsp.json`) > **global** (localStorage) >
 * **défaut** (`DEFAULT_LSP_CONFIG`).
 *
 * La fusion est une surcharge par `serverId` : un serveur défini des deux côtés
 * prend la version workspace. Les serveurs absents du workspace mais présents en
 * global sont conservés.
 *
 * Sécurité : toute config — globale comme workspace — est **validée par Zod**
 * avant usage. Une config invalide est ignorée (fallback sur le niveau
 * inférieur) : un fichier `.origin/lsp.json` malveillant ne peut pas injecter de
 * données hors schéma ni faire planter l'app.
 */
import {
  DEFAULT_LSP_CONFIG,
  LspConfigSchema,
  type LspConfig,
  type LspServerConfig,
} from './lspConfig';
import { readFile } from './fs';

const GLOBAL_KEY = 'origin-lsp-config';

/** Chemin relatif du fichier de config workspace. */
export const WORKSPACE_LSP_PATH = '.origin/lsp.json';

// ── Global (localStorage) ────────────────────────────────────────────────────

export function loadGlobalLspConfig(): LspConfig {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return { ...DEFAULT_LSP_CONFIG, servers: [...DEFAULT_LSP_CONFIG.servers] };
    const result = LspConfigSchema.safeParse(JSON.parse(raw));
    if (!result.success) return { ...DEFAULT_LSP_CONFIG, servers: [...DEFAULT_LSP_CONFIG.servers] };
    return result.data;
  } catch {
    return { ...DEFAULT_LSP_CONFIG, servers: [...DEFAULT_LSP_CONFIG.servers] };
  }
}

export function saveGlobalLspConfig(config: LspConfig): void {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(config));
}

// ── Workspace (.origin/lsp.json) ─────────────────────────────────────────────

/**
 * Lit la config workspace. Retourne `null` si absente, illisible ou invalide
 * (dans ce cas la config globale prend le relais).
 */
export async function loadWorkspaceLspConfig(rootPath: string): Promise<LspConfig | null> {
  if (!rootPath) return null;
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const fullPath = `${rootPath.replace(/[/\\]$/, '')}${sep}${WORKSPACE_LSP_PATH.replace('/', sep)}`;
  try {
    const raw = await readFile(fullPath);
    const result = LspConfigSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    // Fichier absent (cas normal) ou JSON invalide : on ignore silencieusement.
    return null;
  }
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/** Fusionne global puis workspace (workspace gagne par serverId). */
export function mergeLspConfigs(global: LspConfig, workspace: LspConfig | null): LspConfig {
  if (!workspace) return global;
  const byId = new Map<string, LspServerConfig>();
  for (const s of global.servers) byId.set(s.serverId, s);
  for (const s of workspace.servers) byId.set(s.serverId, s);
  return { version: 1, servers: [...byId.values()] };
}

/**
 * Résout la config LSP effective pour un workspace.
 * Fonction unique à utiliser partout : garantit une précédence cohérente.
 */
export async function resolveLspConfig(rootPath: string): Promise<LspConfig> {
  const global = loadGlobalLspConfig();
  const workspace = await loadWorkspaceLspConfig(rootPath);
  return mergeLspConfigs(global, workspace);
}

// ── Détection par extension ──────────────────────────────────────────────────

export interface ResolvedServer {
  /** Id du serveur (== clé de session LSP envoyée au backend). */
  serverId: string;
  /** Config du serveur. */
  config: LspServerConfig;
}

/**
 * Trouve le serveur LSP associé à un chemin de fichier, ou `null`.
 * La première correspondance d'extension gagne (ordre de déclaration stable).
 */
export function findServerForFile(config: LspConfig, filePath: string): ResolvedServer | null {
  if (!filePath || filePath.startsWith('__')) return null;
  const base = filePath.replace(/\\/g, '/');
  const name = base.slice(base.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const server of config.servers) {
    if (server.enabled === false) continue;
    if (server.extensions.includes(ext)) {
      return { serverId: server.serverId, config: server };
    }
  }
  return null;
}
