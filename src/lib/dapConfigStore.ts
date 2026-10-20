/**
 * Résolution et persistance de la configuration DAP (debug).
 *
 * Précédence : **workspace** (`.origin/debug.json`) > **global** (localStorage) >
 * **défaut** (`DEFAULT_DAP_CONFIG`).
 *
 * La fusion est une surcharge par `adapterId` : un adaptateur défini des deux
 * côtés prend la version workspace. Les adaptateurs absents du workspace mais
 * présents en global sont conservés.
 *
 * Sécurité : toute config — globale comme workspace — est **validée par Zod**
 * avant usage. Une config invalide est ignorée (fallback sur le niveau
 * inférieur) : un fichier `.origin/debug.json` malveillant ne peut pas injecter
 * de données hors schéma ni faire planter l'app.
 */
import {
  DEFAULT_DAP_CONFIG,
  DapConfigSchema,
  type DapConfig,
  type DapAdapterConfig,
} from './dapConfig';
import { readFile } from './fs';

const GLOBAL_KEY = 'origin-dap-config';

/** Chemin relatif du fichier de config workspace. */
export const WORKSPACE_DAP_PATH = '.origin/debug.json';

// ── Global (localStorage) ────────────────────────────────────────────────────

export function loadGlobalDapConfig(): DapConfig {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return { ...DEFAULT_DAP_CONFIG, adapters: [...DEFAULT_DAP_CONFIG.adapters] };
    const result = DapConfigSchema.safeParse(JSON.parse(raw));
    if (!result.success) return { ...DEFAULT_DAP_CONFIG, adapters: [...DEFAULT_DAP_CONFIG.adapters] };
    return result.data;
  } catch {
    return { ...DEFAULT_DAP_CONFIG, adapters: [...DEFAULT_DAP_CONFIG.adapters] };
  }
}

export function saveGlobalDapConfig(config: DapConfig): void {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(config));
}

// ── Workspace (.origin/debug.json) ───────────────────────────────────────────

/**
 * Lit la config workspace. Retourne `null` si absente, illisible ou invalide
 * (dans ce cas la config globale prend le relais).
 */
export async function loadWorkspaceDapConfig(rootPath: string): Promise<DapConfig | null> {
  if (!rootPath) return null;
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const fullPath = `${rootPath.replace(/[/\\]$/, '')}${sep}${WORKSPACE_DAP_PATH.replace('/', sep)}`;
  try {
    const raw = await readFile(fullPath);
    const result = DapConfigSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    // Fichier absent (cas normal) ou JSON invalide : on ignore silencieusement.
    return null;
  }
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/** Fusionne global puis workspace (workspace gagne par adapterId). */
export function mergeDapConfigs(global: DapConfig, workspace: DapConfig | null): DapConfig {
  if (!workspace) return global;
  const byId = new Map<string, DapAdapterConfig>();
  for (const a of global.adapters) byId.set(a.adapterId, a);
  for (const a of workspace.adapters) byId.set(a.adapterId, a);
  return { version: 1, adapters: [...byId.values()] };
}

/**
 * Résout la config DAP effective pour un workspace.
 * Fonction unique à utiliser partout : garantit une précédence cohérente.
 */
export async function resolveDapConfig(rootPath: string): Promise<DapConfig> {
  const global = loadGlobalDapConfig();
  const workspace = await loadWorkspaceDapConfig(rootPath);
  return mergeDapConfigs(global, workspace);
}
