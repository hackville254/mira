// ── File d'attente de messages (message queue) ────────────────────────────────
//
// Pendant qu'un tour est en cours (streaming), l'utilisateur peut continuer à
// écrire. Contrairement au comportement historique qui ANNULAIT le tour courant,
// le message est ici mis en file d'attente puis envoyé automatiquement quand le
// tour se termine (fin normale, erreur, ou stop manuel).
//
// Ce module ne contient que de la logique pure (pas de React) afin d'être
// testable simplement. L'état est un unique message en attente, comme Trae :
// au-delà, un nouvel envoi remplace le précédent.

import type { QueuedMessage } from "../aiTypes";

/**
 * Ajoute un message à la file. Le modèle de file retenu est « un seul message
 * en attente » (comme Trae/Cursor) : un nouvel envoi écrase le précédent plutôt
 * que d'empiler des envois potentiellement contradictoires.
 */
export function enqueueMessage(_current: QueuedMessage | null, next: QueuedMessage): QueuedMessage {
  return next;
}

/**
 * Dépile le prochain message à envoyer, ou `null` si la file est vide.
 */
export function dequeueMessage(current: QueuedMessage | null): QueuedMessage | null {
  return current;
}

/**
 * Indique s'il reste un message à envoyer.
 */
export function hasQueued(current: QueuedMessage | null): boolean {
  return current !== null;
}
