// ── État de revue « Keep all / Undo all » (logique pure) ──────────────────────
//
// Le panneau IA suit, PAR MESSAGE utilisateur, la liste des tours de checkpoint
// encore annulables. Cette logique était auparavant noyée dans `AiPanel.tsx`,
// où elle était intestable (le composant exige Tauri + DOM). On l'isole ici,
// sous forme de fonctions PURES : elles constituent la source de vérité de
// l'orchestration et couvrent les cas à risque de régression (tours fantômes,
// cible d'un Undo, reconstruction au rechargement).

import type { TurnFileDelta } from "../turnCheckpoint";

/** Suivi des tours par index de message utilisateur. */
export type TurnIdsByUser = Map<number, string[]>;

/** Rassemble tous les turnIds ouverts depuis `userIndex` (inclus). */
export function collectTurnIdsFrom(byUser: TurnIdsByUser, userIndex: number): string[] {
  const ids: string[] = [];
  for (const [idx, turns] of byUser) {
    if (idx >= userIndex) ids.push(...turns);
  }
  return ids;
}

/**
 * Acte (« keep ») tous les tours couverts par `userIndex` et suivants : ils ne
 * sont plus annulables. Renvoie une NOUVELLE map (immuable) et la liste des
 * index restants.
 *
 * POURQUOI ≥ userIndex ET PAS SEULEMENT == userIndex
 * --------------------------------------------------
 * Un « run » peut couvrir plusieurs messages ; garder un message acte donc tous
 * les tours générés depuis lui. Ne retirer que l'index exact laissait des tours
 * « fantômes » : encore listés comme annulables alors que leur checkpoint avait
 * été purgé sur disque — d'où un « Undo » qui visait une mauvaise cible.
 */
export function keepFrom(byUser: TurnIdsByUser, userIndex: number): TurnIdsByUser {
  const next: TurnIdsByUser = new Map();
  for (const [idx, turns] of byUser) {
    if (idx < userIndex) next.set(idx, turns);
  }
  return next;
}

/** Index (message utilisateur) restant annulables après un keep depuis `userIndex`. */
export function revertableIndexesAfterKeep(indexes: number[], userIndex: number): number[] {
  return indexes.filter(idx => idx < userIndex);
}

/**
 * Reconstruit le suivi des tours à partir de la liste disque (`checkpoint_list_turns`)
 * et du dernier index de message utilisateur connu.
 *
 * POURQUOI CE RATTACHEMENT
 * ------------------------
 * Les checkpoints survivent sur disque alors que le suivi par message vit en
 * mémoire : après un rechargement, la corrélation tour ↔ message est perdue. On
 * rattache alors tous les tours survivants au DERNIER message utilisateur — seul
 * ancrage fiable. « Undo all » agira ainsi sur l'ensemble du run restant, ce qui
 * reste le comportement attendu (on ne peut pas être plus précis sans avoir
 * persisté la corrélation).
 */
export function hydrateTurns(
  turnIds: string[],
  lastUserIndex: number,
): { byUser: TurnIdsByUser; revertable: number[] } {
  const byUser: TurnIdsByUser = new Map();
  if (turnIds.length === 0 || lastUserIndex < 0) {
    return { byUser, revertable: [] };
  }
  byUser.set(lastUserIndex, [...turnIds]);
  return { byUser, revertable: [lastUserIndex] };
}

/** Filtre les marqueurs « gardé » pour ne conserver que les index < `userIndex`. */
export function keptReviewsBefore(
  kept: Record<number, TurnFileDelta[]>,
  userIndex: number,
): Record<number, TurnFileDelta[]> {
  const next: Record<number, TurnFileDelta[]> = {};
  for (const [k, v] of Object.entries(kept)) {
    if (Number(k) < userIndex) next[Number(k)] = v;
  }
  return next;
}
