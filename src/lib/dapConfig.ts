/**
 * Configuration DAP (debug) déclarative et extensible.
 *
 * Deux niveaux, par ordre de précédence :
 *  1. **Global**  — préférences utilisateur (localStorage), tous projets.
 *  2. **Workspace** — fichier `.origin/debug.json` à la racine du projet (versionnable).
 *
 * Comme pour le LSP, la config NE contient PAS la commande exécutable : elle
 * référence un **id d'adaptateur** (`adapterId`) qui doit appartenir à l'allowlist
 * compilée côté Rust (`dap.rs`). Le frontend ne peut donc jamais faire exécuter un
 * binaire arbitraire : au pire il lance un adaptateur connu.
 *
 * Sécurité :
 *  - Parsing strict via Zod (rejette tout champ inconnu, borne les tailles).
 *  - L'adaptateur est lancé **sans shell** (argv) côté Rust.
 */
import { z } from 'zod';

/** Préfixe réservé : identifie un adaptateur DAP supporté. */
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export const DapAdapterConfigSchema = z.object({
  /** Id d'un adaptateur supporté (doit exister dans l'allowlist Rust). */
  adapterId: z.string().regex(ADAPTER_ID_PATTERN),
  /** Extensions de fichier (sans point) ciblées par cet adaptateur. */
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1).max(64),
  /** Libellé affiché dans le sélecteur. */
  label: z.string().min(1).max(64),
  /** Chemin du binaire de l'adaptateur (vide = résolution via PATH). */
  adapterPath: z.string().max(1024).optional(),
  /** Active/désactive cet adaptateur sans le supprimer. */
  enabled: z.boolean().optional(),
});

export const DapConfigSchema = z.object({
  /** Version du schéma, pour migrations futures. */
  version: z.literal(1),
  adapters: z.array(DapAdapterConfigSchema).max(64),
});

export type DapAdapterConfig = z.infer<typeof DapAdapterConfigSchema>;
export type DapConfig = z.infer<typeof DapConfigSchema>;

// ── Catalogue des adaptateurs connus (miroir de l'allowlist Rust) ────────────
// Purement descriptif : fournit le nom du binaire et la commande d'installation.
// La source d'autorité (exécution) reste `dap.rs`.

export interface KnownAdapter {
  /** Id stable, aligné sur `dap_exe_and_args` côté Rust. */
  id: string;
  /** Libellé affiché (langages couverts). */
  label: string;
  /** Commande d'installation suggérée. */
  installCommand: string;
}

export const KNOWN_ADAPTERS: KnownAdapter[] = [
  {
    id: 'codelldb',
    label: 'Rust / C / C++ (CodeLLDB)',
    installCommand: 'code --install-extension vadimcn.vscode-lldb  (ou télécharger codelldb)',
  },
  {
    id: 'debugpy',
    label: 'Python (debugpy)',
    installCommand: 'python -m pip install debugpy',
  },
  {
    id: 'delve',
    label: 'Go (Delve)',
    installCommand: 'go install github.com/go-delve/delve/cmd/dlv@latest',
  },
  {
    id: 'netcoredbg',
    label: 'C# / .NET (netcoredbg)',
    installCommand: 'See https://github.com/Samsung/netcoredbg',
  },
  {
    id: 'js-debug',
    label: 'Node.js / JavaScript (js-debug)',
    installCommand: 'npm install -g @vscode/js-debug',
  },
  {
    id: 'php-debug',
    label: 'PHP (Xdebug)',
    installCommand: 'See https://xdebug.org/docs/step_debug',
  },
  {
    id: 'kotlin-debug-adapter',
    label: 'Kotlin (kotlin-debug-adapter)',
    installCommand: 'See https://github.com/fwcd/kotlin-debug-adapter',
  },
];

const KNOWN_ADAPTER_IDS = new Set(KNOWN_ADAPTERS.map(a => a.id));

/** Indique si un id d'adaptateur est reconnu par le catalogue/allowlist. */
export function isKnownAdapterId(id: string): boolean {
  return KNOWN_ADAPTER_IDS.has(id);
}

// ── Configuration par défaut (3 adaptateurs historiques + Go) ───────────────

export const DEFAULT_DAP_CONFIG: DapConfig = {
  version: 1,
  adapters: [
    { adapterId: 'codelldb', extensions: ['rs', 'c', 'cpp', 'cc', 'cxx'], label: 'Rust / C / C++ (CodeLLDB)' },
    { adapterId: 'debugpy', extensions: ['py', 'pyw'], label: 'Python (debugpy)' },
    { adapterId: 'delve', extensions: ['go'], label: 'Go (Delve)' },
  ],
};

// ── Détection par extension ──────────────────────────────────────────────────

/**
 * Trouve l'adaptateur DAP associé à un chemin de fichier, ou `null`.
 * La première correspondance d'extension gagne (ordre de déclaration stable).
 */
export function findAdapterForFile(config: DapConfig, filePath: string): DapAdapterConfig | null {
  if (!filePath || filePath.startsWith('__')) return null;
  const base = filePath.replace(/\\/g, '/');
  const name = base.slice(base.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const adapter of config.adapters) {
    if (adapter.enabled === false) continue;
    if (adapter.extensions.includes(ext)) return adapter;
  }
  return null;
}
