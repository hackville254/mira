/**
 * Canal d'ouverture de la modale de connexion Mira.
 *
 * Pourquoi un canal dédié plutôt qu'un état partagé : la modale `SignInDialog`
 * est montée par `TitleBar`, qui vit dans la barre de titre. Le chat (AiPanel /
 * ChatBox) est un arbre de composants distinct et ne peut donc pas modifier
 * directement son état. On réutilise le pattern d'événement global déjà employé
 * ailleurs dans l'app (`origin-open-settings`, `origin-chat-drop`, …) : un
 * émetteur unique, un écouteur unique, aucun état dupliqué.
 *
 * Sécurité : le canal ne transporte aucune donnée sensible (aucun argument),
 * il ne fait que demander l'ouverture d'un dialogue que l'utilisateur devra
 * de toute façon approuver dans son navigateur (device flow).
 */
export const SIGN_IN_OPEN_EVENT = "origin-open-signin";

/** Demande l'ouverture de la modale de connexion Mira. */
export function requestSignIn(): void {
  window.dispatchEvent(new CustomEvent(SIGN_IN_OPEN_EVENT));
}

/**
 * S'abonne aux demandes d'ouverture de la modale de connexion.
 * Renvoie une fonction de désabonnement (à appeler au démontage).
 */
export function onSignInRequest(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(SIGN_IN_OPEN_EVENT, listener);
  return () => window.removeEventListener(SIGN_IN_OPEN_EVENT, listener);
}
