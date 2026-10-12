/**
 * Configuration LSP déclarative et extensible.
 *
 * Deux niveaux, par ordre de précédence :
 *  1. **Global**  — préférences utilisateur (localStorage), tous projets.
 *  2. **Workspace** — fichier `.origin/lsp.json` à la racine du projet (versionnable).
 *
 * La config NE contient PAS la commande exécutable à proprement parler : elle
 * référence un **id de serveur** (`serverId`) qui doit appartenir à l'allowlist
 * compilée côté Rust (`lsp.rs`). Le frontend ne peut donc jamais faire exécuter
 * un binaire arbitraire : au pire il active/désactive un serveur connu.
 *
 * Sécurité :
 *  - Parsing strict via Zod (rejette tout champ inconnu, borne les tailles).
 *  - Les `args` supplémentaires sont transmis au backend, qui les valide à
 *    nouveau (pas de shell, pas d'argument vide / NUL).
 *  - Aucun `eval`, aucune concaténation de commande.
 */
import { z } from 'zod';

/** Préfixe réservé : identifie un serveur LSP interne supporté. */
export const SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Code d'erreur structuré renvoyé par Rust quand le binaire d'un serveur est
 * introuvable (`LSP_BINARY_NOT_FOUND`). Le frontend compare ce code stable au
 * lieu de parser un message libre (fragile, localisé, dépendant de l'OS).
 */
export const LSP_BINARY_NOT_FOUND = 'LSP_BINARY_NOT_FOUND';

export const LspServerConfigSchema = z.object({
  /** Id d'un serveur supporté (doit exister dans l'allowlist Rust). */
  serverId: z.string().regex(SERVER_ID_PATTERN),
  /** Extensions de fichier (sans point) traitées par ce serveur. */
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1).max(64),
  /** languageId LSP envoyé au serveur (ex. "typescriptreact"). */
  languageId: z.string().min(1).max(64),
  /** Argument additionnels passés au serveur (ex. ["--stdio"]). */
  args: z.array(z.string().min(1).max(256)).max(32).optional(),
  /**
   * Chemin explicite du binaire du serveur (absolu). Prioritaire sur le PATH
   * lorsqu'il est fourni — utile pour un serveur installé localement au projet.
   */
  serverPath: z.string().min(1).max(1024).optional(),
  /** Active/désactive ce serveur sans le supprimer. */
  enabled: z.boolean().optional(),
});

export const LspConfigSchema = z.object({
  /** Version du schéma, pour migrations futures. */
  version: z.literal(1),
  servers: z.array(LspServerConfigSchema).max(128),
});

export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;
export type LspConfig = z.infer<typeof LspConfigSchema>;

// ── Catalogue des serveurs connus (miroir de l'allowlist Rust) ───────────────
// Ce catalogue est purement descriptif : il fournit le nom du binaire et la
// commande d'installation affichés à l'utilisateur. La source d'autorité
// (exécution) reste `lsp.rs`.

export interface KnownServer {
  /** Id stable, aligné sur `lsp_exe_and_args` côté Rust. */
  id: string;
  /** Libellé affiché. */
  label: string;
  /** Commande d'installation suggérée (exécutée via le terminal intégré). */
  installCommand: string;
}

export const KNOWN_SERVERS: KnownServer[] = [
  {
    id: 'typescript-language-server',
    label: 'TypeScript / JavaScript (typescript-language-server)',
    installCommand: 'npm install -g typescript-language-server typescript',
  },
  {
    id: 'rust-analyzer',
    label: 'Rust (rust-analyzer)',
    installCommand: 'rustup component add rust-analyzer',
  },
  {
    id: 'pylsp',
    label: 'Python (pylsp)',
    installCommand: 'python -m pip install python-lsp-server',
  },
  {
    id: 'gopls',
    label: 'Go (gopls)',
    installCommand: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'clangd',
    label: 'C / C++ (clangd)',
    installCommand: 'See https://clangd.llvm.org/installation',
  },
  {
    id: 'jdtls',
    label: 'Java (Eclipse JDT LS)',
    installCommand: 'See https://github.com/eclipse-jdtls/eclipse.jdt.ls',
  },
  {
    id: 'bash-language-server',
    label: 'Shell (bash-language-server)',
    installCommand: 'npm install -g bash-language-server',
  },
  {
    id: 'vscode-json-language-server',
    label: 'JSON (vscode-json-language-server)',
    installCommand: 'npm install -g vscode-langservers-extracted',
  },
  {
    id: 'vscode-css-language-server',
    label: 'CSS / SCSS / Less (vscode-css-language-server)',
    installCommand: 'npm install -g vscode-langservers-extracted',
  },
  {
    id: 'vscode-html-language-server',
    label: 'HTML (vscode-html-language-server)',
    installCommand: 'npm install -g vscode-langservers-extracted',
  },
  {
    id: 'yaml-language-server',
    label: 'YAML (yaml-language-server)',
    installCommand: 'npm install -g yaml-language-server',
  },
];

const KNOWN_SERVER_IDS = new Set(KNOWN_SERVERS.map(s => s.id));

/** Indique si un id de serveur est reconnu par le catalogue/allowlist. */
export function isKnownServerId(id: string): boolean {
  return KNOWN_SERVER_IDS.has(id);
}

// ── Configuration par défaut (3 serveurs historiques) ───────────────────────

export const DEFAULT_LSP_CONFIG: LspConfig = {
  version: 1,
  servers: [
    {
      serverId: 'typescript-language-server',
      extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
      languageId: 'typescript',
      args: ['--stdio'],
    },
    {
      serverId: 'rust-analyzer',
      extensions: ['rs'],
      languageId: 'rust',
    },
    {
      serverId: 'pylsp',
      extensions: ['py', 'pyw', 'pyi'],
      languageId: 'python',
    },
  ],
};
