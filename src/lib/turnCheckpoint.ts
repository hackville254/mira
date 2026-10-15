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

// ── Revert multi-tours (annulation d'un « run » complet) ──────────────────────
//
// Un run d'agent comporte PLUSIEURS tours (boucle d'outils), chacun avec son
// propre checkpoint. Reverter un message utilisateur = annuler TOUS les tours
// générés depuis, d'où des commandes travaillant sur une liste de `turn_ids`.

/** Action qui sera appliquée à un chemin lors d'un revert. */
export type RevertAction = "delete" | "restore";

/** Entrée du plan de revert : un chemin + l'action prévue. */
export interface RevertPlanEntry {
  /** Chemin absolu du fichier concerné. */
  path: string;
  /** `delete` = créé pendant le run (sera supprimé) ; `restore` = modifié. */
  action: RevertAction;
  /** Nombre de tours du run ayant touché ce chemin (≥ 1). */
  turns: number;
}

/**
 * Prévisualisation d'un revert : liste, sans RIEN modifier, les fichiers qui
 * seront supprimés (créés pendant le run) ou restaurés (modifiés). C'est le
 * contrat montré à l'utilisateur avant confirmation.
 */
export async function previewRevertTurns(
  turnIds: string[],
  workspaceRoot?: string | null,
): Promise<RevertPlanEntry[]> {
  return invoke<RevertPlanEntry[]>("checkpoint_revert_preview", {
    turnIds,
    workspaceRoot: workspaceRoot ?? null,
  });
}

/**
 * Annule un run complet : restaure les fichiers modifiés, supprime ceux créés,
 * élague les dossiers laissés vides, puis purge les checkpoints consommés.
 * Renvoie le plan réellement appliqué.
 */
export async function revertTurns(
  turnIds: string[],
  workspaceRoot?: string | null,
): Promise<RevertPlanEntry[]> {
  return invoke<RevertPlanEntry[]>("checkpoint_undo_many", {
    turnIds,
    workspaceRoot: workspaceRoot ?? null,
  });
}
