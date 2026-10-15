import { invoke } from "@tauri-apps/api/core";

// ── Checkpoints par tour ──────────────────────────────────────────────────────
//
// Façade front du module Rust `checkpoint.rs`, qui implémente « Undo all /
// Keep all » : avant qu'un tour d'agent n'écrive quoi que ce soit, chaque
// fichier touché est snapshoté une fois ; à la fin du tour l'utilisateur peut
// soit tout annuler (restauration), soit tout garder (on oublie le snapshot).

/** Ouvre un checkpoint pour un tour. Idempotent côté disque. */
export async function beginTurnCheckpoint(turnId: string): Promise<void> {
  await invoke("checkpoint_begin", { turnId });
}

/**
 * Snapshot d'un fichier AVANT sa première écriture du tour. Idempotent : si le
 * fichier est déjà capturé pour ce tour, l'appel ne fait rien (le premier état
 * gagne). Renvoie `true` si un nouvel état a effectivement été capturé.
 */
export async function touchTurnFile(
  turnId: string,
  path: string,
  workspaceRoot?: string | null,
): Promise<boolean> {
  const before = await countTurnCheckpoint(turnId).catch(() => 0);
  await invoke("checkpoint_touch_file", { turnId, path, workspaceRoot: workspaceRoot ?? null });
  const after = await countTurnCheckpoint(turnId).catch(() => before);
  return after > before;
}

/** Restaure le tour (fichiers réécrits, fichiers créés supprimés). Purge ensuite. */
export async function undoTurnCheckpoint(
  turnId: string,
  workspaceRoot?: string | null,
): Promise<string[]> {
  return invoke<string[]>("checkpoint_undo", { turnId, workspaceRoot: workspaceRoot ?? null });
}

/** Oublie le checkpoint (action « Keep all »). Les écritures restent. */
export async function discardTurnCheckpoint(turnId: string): Promise<void> {
  await invoke("checkpoint_discard", { turnId });
}

/** Nombre de fichiers capturés pour un tour. */
export async function countTurnCheckpoint(turnId: string): Promise<number> {
  return invoke<number>("checkpoint_count", { turnId });
}

/** Delta de lignes d'un fichier modifié pendant le tour. */
export interface TurnFileDelta {
  /** Chemin absolu du fichier. */
  path: string;
  /** Lignes ajoutées (`+N`). */
  added: number;
  /** Lignes supprimées (`-N`). */
  removed: number;
  /** `true` si le fichier a été créé pendant le tour. */
  created: boolean;
}

/**
 * Résumé des fichiers modifiés du tour : chemins + deltas `+N/-N`, pour la
 * liste cliquable de la bannière de checkpoint.
 */
export async function summaryTurnCheckpoint(turnId: string): Promise<TurnFileDelta[]> {
  return invoke<TurnFileDelta[]>("checkpoint_summary", { turnId });
}

/**
 * Contenu d'origine d'un fichier avant le tour (pour afficher un diff en lecture
 * seule). Chaîne vide si le fichier a été créé pendant le tour.
 */
export async function fileBeforeTurnCheckpoint(turnId: string, path: string): Promise<string> {
  return invoke<string>("checkpoint_file_before", { turnId, path });
}
