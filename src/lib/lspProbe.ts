/**
 * Diagnostic et gestion d'erreur du cycle de vie des serveurs LSP.
 *
 * Deux responsabilités, volontairement séparées de `lspCm6` (qui gère le
 * protocole) :
 *
 *  1. **Parsing d'erreur structurée** : Rust renvoie, quand un binaire est
 *     introuvable, un JSON `{ code: "LSP_BINARY_NOT_FOUND", serverId, binary,
 *     searched }`. On ne fait **jamais** de heuristique sur le texte — un code
 *     stable est le seul contrat fiable entre les deux couches.
 *
 *  2. **Probe** : interroge la disponibilité d'un serveur **sans le lancer**
 *     (`lsp_probe`), pour connaître l'état de chaque langage à l'avance.
 */
import { invoke } from '@tauri-apps/api/core';
import { LSP_BINARY_NOT_FOUND } from './lspConfig';

/** Charge utile renvoyée par Rust quand un binaire de serveur est introuvable. */
export interface LspBinaryError {
  code: typeof LSP_BINARY_NOT_FOUND;
  serverId: string;
  binary: string;
  /** Emplacements consultés (serverPath / app / PATH). */
  searched: string[];
}

/** Résultat de diagnostic d'un serveur LSP. */
export interface LspProbeResult {
  serverId: string;
  binary: string;
  found: boolean;
  path: string | null;
  /** Source retenue : "serverPath" | "app" | "PATH". */
  source: string | null;
  /** Emplacements consultés quand le binaire est absent. */
  searched: string[];
}

/**
 * Tente de reconnaître une erreur structurée « binaire introuvable ».
 *
 * `invoke` rejette avec une **chaîne** (le `String` renvoyé par Rust). On tente
 * de la parser comme JSON ; si le code correspond, on renvoie l'objet typé.
 * Sinon `null` — l'appelant décide (message générique, log, etc.).
 */
export function parseLspBinaryError(err: unknown): LspBinaryError | null {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  if (!raw) return null;
  // Un JSON valide commence par « { ».
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start));
    if (parsed && parsed.code === LSP_BINARY_NOT_FOUND) {
      return {
        code: LSP_BINARY_NOT_FOUND,
        serverId: String(parsed.serverId ?? parsed.server_id ?? ''),
        binary: String(parsed.binary ?? ''),
        searched: Array.isArray(parsed.searched) ? parsed.searched.map(String) : [],
      };
    }
  } catch {
    // Message non-JSON : pas une erreur structurée.
  }
  return null;
}

/**
 * Interroge la disponibilité d'un serveur LSP sans le démarrer.
 * `serverPath` conditionne la source prioritaire (chemin local explicite).
 */
export async function probeLspServer(
  serverId: string,
  serverPath?: string,
): Promise<LspProbeResult> {
  return invoke<LspProbeResult>('lsp_probe', {
    serverId,
    serverPath: serverPath ?? null,
  });
}
