/**
 * Résolution, persistance et confiance de la configuration « Run ».
 *
 * Précédence : **workspace** (`.origin/run.json`) > **global** (localStorage) >
 * **défaut** (`DEFAULT_RUN_CONFIG`).
 *
 * Sécurité :
 *  - Toute config est validée par Zod avant usage (un `.origin/run.json`
 *    malveillant ne peut pas injecter de données hors schéma).
 *  - Les tâches issues du workspace sont **non fiables** : elles ne s'exécutent
 *    qu'après confirmation explicite, mémorisée par un **hash de contenu**
 *    (voir `isWorkspaceTrusted` / `trustWorkspace`). Modifier le fichier
 *    invalide la confiance et redemande une confirmation.
 */
import {
  DEFAULT_RUN_CONFIG,
  RunConfigSchema,
  type RunConfig,
  type RunTask,
} from './runTasks';
import { readFile } from './fs';

const GLOBAL_KEY = 'origin-run-config';
const TRUST_KEY_PREFIX = 'origin-run-trust:';

/** Chemin relatif du fichier de config workspace. */
export const WORKSPACE_RUN_PATH = '.origin/run.json';

// ── Global (localStorage) ────────────────────────────────────────────────────

export function loadGlobalRunConfig(): RunConfig {
  const fallback: RunConfig = { ...DEFAULT_RUN_CONFIG, tasks: [...DEFAULT_RUN_CONFIG.tasks] };
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (!raw) return fallback;
    const result = RunConfigSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

export function saveGlobalRunConfig(config: RunConfig): void {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(config));
}

// ── Workspace (.origin/run.json) ─────────────────────────────────────────────

/**
 * Lit la config workspace. Retourne `null` si absente, illisible ou invalide.
 * Le contenu brut est aussi renvoyé (haché par l'appelant) pour la confiance.
 */
export async function loadWorkspaceRunConfig(
  rootPath: string,
): Promise<{ config: RunConfig; raw: string } | null> {
  if (!rootPath) return null;
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const fullPath = `${rootPath.replace(/[/\\]$/, '')}${sep}${WORKSPACE_RUN_PATH.replace('/', sep)}`;
  try {
    const raw = await readFile(fullPath);
    const result = RunConfigSchema.safeParse(JSON.parse(raw));
    return result.success ? { config: result.data, raw } : null;
  } catch {
    return null;
  }
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/** Fusionne global puis workspace (workspace gagne par `id` de tâche). */
export function mergeRunConfigs(global: RunConfig, workspace: RunConfig | null): RunConfig {
  if (!workspace) return global;
  const byId = new Map<string, RunTask>();
  for (const t of global.tasks) byId.set(t.id, t);
  for (const t of workspace.tasks) byId.set(t.id, t);
  return { version: 1, tasks: [...byId.values()] };
}

// ── Confiance (Workspace Trust) ──────────────────────────────────────────────

/** Hash non cryptographique suffisant pour détecter un changement de contenu. */
function hashContent(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function trustKey(rootPath: string): string {
  return `${TRUST_KEY_PREFIX}${rootPath}`;
}

/**
 * Indique si le fichier workspace actuel (identifié par son contenu) a déjà été
 * approuvé. Toute modification du contenu invalide la confiance.
 */
export function isWorkspaceTrusted(rootPath: string, raw: string): boolean {
  try {
    return localStorage.getItem(trustKey(rootPath)) === hashContent(raw);
  } catch {
    return false;
  }
}

/** Mémorise l'approbation du contenu workspace courant. */
export function trustWorkspace(rootPath: string, raw: string): void {
  try {
    localStorage.setItem(trustKey(rootPath), hashContent(raw));
  } catch {
    // localStorage indisponible : on continue sans persister la confiance.
  }
}

// ── Résolution ───────────────────────────────────────────────────────────────

export interface ResolvedRunConfig {
  /** Config effective après fusion. */
  config: RunConfig;
  /** `true` si au moins une tâche provient d'un workspace non encore approuvé. */
  needsTrust: boolean;
  /** Contenu brut du workspace (à fournir à `trustWorkspace`), si présent. */
  workspaceRaw: string | null;
}

/** Résout la config Run effective + l'état de confiance pour ce workspace. */
export async function resolveRunConfig(rootPath: string): Promise<ResolvedRunConfig> {
  const global = loadGlobalRunConfig();
  const workspace = await loadWorkspaceRunConfig(rootPath);
  const config = mergeRunConfigs(global, workspace?.config ?? null);
  const workspaceRaw = workspace?.raw ?? null;
  const needsTrust =
    workspace !== null && workspaceRaw !== null && !isWorkspaceTrusted(rootPath, workspaceRaw);
  return { config, needsTrust, workspaceRaw };
}
