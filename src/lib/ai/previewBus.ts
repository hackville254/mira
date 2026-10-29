/**
 * Bus de pilotage du panneau de prévisualisation web.
 *
 * Besoin : un lien cliqué dans un message de l'agent (ou un outil `browser_*`)
 * doit ouvrir la page dans le panneau INTÉGRÉ, jamais dans la webview Tauri
 * principale (qui noierait l'UI sans retour possible) ni dans une fenêtre OS
 * séparée (impossible à fermer proprement).
 *
 * Pourquoi un bus : le clic naît dans le rendu markdown d'un message, alors que
 * le panneau vit dans un arbre React totalement distinct (`WebPreviewPane` en
 * onglet éditeur ou onglet d'outil `browser`). Faire passer un callback à
 * travers `MessageBubble` → `AiPanel` → `AgentModeView` → `WebPreviewPane`
 * croiserait des composants sans rapport. Le bus expose donc UNE capacité :
 * « ouvre cette URL dans le preview ».
 *
 * Contrat de sécurité : on ne transporte qu'une chaîne d'URL (jamais de code,
 * jamais de HTML). Le filtrage des schémas dangereux (`javascript:`, `data:`…)
 * est fait par l'appelant AVANT publication, et reste de toute façon revérifié
 * côté Rust (`assert_navigable`). Publier sans panneau monté = no-op silencieux.
 */

/** URL demandée pour le preview intégré. Les abonnés décident d'ouvrir l'onglet. */
type PreviewListener = (url: string) => void;

const listeners = new Set<PreviewListener>();

export function subscribePreviewNavigation(listener: PreviewListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Demande l'ouverture de `url` dans le panneau de prévisualisation intégré.
 * Les abonnés (le panneau monté) rechargent l'URL ; s'il n'y a pas d'abonné, la
 * demande est mémorisée comme URL « en attente » pour être servie au montage
 * suivant (le panneau peut ne pas être encore monté au moment du clic).
 */
export function requestPreviewUrl(url: string): void {
  if (!url) return;
  pendingUrl = url;
  for (const listener of listeners) {
    try {
      listener(url);
    } catch {
      // Un abonné défaillant ne doit pas casser le clic ni les autres abonnés.
    }
  }
}

// ── Demande d'ouverture de l'onglet « browser » ────────────────────────────
// Le panneau preview peut ne PAS être monté (onglet fermé ou non actif). Un clic
// sur un lien doit alors d'abord faire apparaître l'onglet : on publie donc
// aussi une demande d'ouverture, écoutée par le conteneur des onglets d'outils.
// L'URL reste mémorisée et sera servie au montage du panneau.

type OpenListener = () => void;
const openListeners = new Set<OpenListener>();

export function subscribePreviewOpen(listener: OpenListener): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

/** Demande l'affichage du panneau preview ET la navigation vers `url`. */
export function openPreviewAt(url: string): void {
  if (!url) return;
  for (const listener of openListeners) {
    try {
      listener();
    } catch {
      // idem : l'ouverture d'onglet est un confort, pas une garantie vitale.
    }
  }
  requestPreviewUrl(url);
}

/**
 * Demande l'AFFICHAGE du panneau preview, SANS toucher aux onglets ni publier
 * d'URL.
 *
 * Usage : l'agent vient d'ouvrir ou d'activer un onglet via le store
 * (`previewTabs`) — l'onglet et son URL existent déjà. Il reste à rendre le
 * panneau VISIBLE, sinon la webview n'est jamais montée et l'agent piloterait
 * une page que personne n'affiche. Publier une URL ici serait une erreur : cela
 * écraserait l'onglet que l'agent vient de sélectionner.
 */
export function requestPreviewFocus(): void {
  for (const listener of openListeners) {
    try {
      listener();
    } catch {
      // Un abonné défaillant ne doit pas casser les autres.
    }
  }
}

let pendingUrl: string | null = null;

/**
 * Consomme l'URL en attente éventuelle (appelée au montage du panneau). Renvoie
 * `null` si aucune navigation n'a été demandée pendant qu'il était démonté.
 */
export function takePendingPreviewUrl(): string | null {
  const u = pendingUrl;
  pendingUrl = null;
  return u;
}
