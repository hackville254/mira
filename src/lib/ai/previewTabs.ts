/**
 * Store des ONGLETS du navigateur intégré (`WebPreviewPane`).
 *
 * BESOIN (parité Trae SOLO) : l'utilisateur — comme l'agent — doit pouvoir
 * ouvrir AUTANT d'onglets qu'il veut, chacun avec sa propre pile d'historique,
 * sa propre webview native (le backend indexe déjà les webviews par `panelId`,
 * cf. `PanelUrlState` dans `lib.rs`) et son URL persistée.
 *
 * VRAI NAVIGATEUR : chaque onglet possède une webview vivante. Basculer d'onglet
 * ne recharge PAS la page — c'est un simple changement d'ACTIF (`activeIndex`)
 * qui se traduit côté vue par montrer/masquer la webview correspondante. L'état
 * par-onglet (historique, chargement, dimensions, erreur) vit donc HORS du cycle
 * React du composant, survivant aux re-rendus comme aux changements d'onglet.
 *
 * POURQUOI UN STORE HORS REACT
 * ----------------------------
 * L'agent (piloté côté Rust/sidecar) doit pouvoir viser EXPLICITEMENT un onglet
 * sans dépendre du DOM. Le store est donc la source de vérité partagée : le
 * composant React s'y abonne, et `clineClient` peut le lire au moment d'un
 * `tool_invoke` (hors arbre React).
 *
 * SÉCURITÉ : on ne transporte que des DONNÉES (id, url, index) — jamais de code
 * ni de HTML. Les URLs restent revérifiées côté Rust (`assert_navigable`).
 */

/** Préfixe des labels de webview. Le backend indexe par ce label. */
export const PREVIEW_PANEL_PREFIX = 'origin-web-preview';

/**
 * Cible LOGIQUE envoyée à l'agent : il ne connaît pas les onglets et vise
 * toujours « l'onglet actif ». Le front remappe cette valeur vers le label réel
 * (`resolvePreviewPanel`) au moment du `tool_invoke`.
 */
export const PREVIEW_ACTIVE_TARGET = 'origin-web-preview';

/** Label de la webview d'un onglet à partir de son id. */
export function panelIdForTab(tabId: string): string {
  return `${PREVIEW_PANEL_PREFIX}-${tabId}`;
}

export interface PreviewTab {
  /** Identifiant stable et unique de l'onglet. */
  id: string;
  /** URL courante affichée (dernière entrée de la pile). */
  url: string;
}

/**
 * Vue publique d'un onglet destinée à l'AGENT.
 *
 * Le modèle ne doit jamais recevoir un `panelId` matériel (il pourrait le
 * forger pour viser une webview arbitraire) : il manipule un **identifiant
 * d'onglet** opaque (`tabId`), que le front seul sait traduire en cible réelle.
 * C'est la même frontière de confiance que `PREVIEW_ACTIVE_TARGET`.
 */
export interface PreviewTabInfo {
  /** Identifiant d'onglet, à réutiliser dans les outils de gestion. */
  tabId: string;
  /** URL courante de l'onglet (vide tant qu'aucune URL n'a été saisie). */
  url: string;
  /** Titre lisible (hôte + dernier segment de chemin). */
  title: string;
  /** Vrai pour l'onglet affiché à l'écran. */
  active: boolean;
}

/** État runtime d'un onglet — jamais persisté, jamais dans le cycle React. */
interface TabRuntime {
  /** Pile d'historique de navigation + index courant. */
  stack: string[];
  index: number;
  /** Dimension d'aperçu imposée (`null` = pleine largeur / hauteur). */
  viewW: number | null;
  viewH: number | null;
  /** Tentatives de chargement de la webview (relance l'embed). */
  reloadKey: number;
  /** Vrai pendant le chargement de la webview. */
  loading: boolean;
  /** Message d'erreur de chargement, ou `null`. */
  error: string | null;
  /** Vrai si la webview peut revenir en arrière (history.length > 1). */
  canBack: boolean;
}

interface PreviewTabsState {
  tabs: PreviewTab[];
  /** Index de l'onglet actif, ou -1 si aucun. */
  activeIndex: number;
}

let state: PreviewTabsState = { tabs: [], activeIndex: -1 };
const listeners = new Set<() => void>();

/**
 * État runtime par id d'onglet. Possédé par le store — et NON par une ref du
 * composant — pour que la webview d'un onglet, ses dimensions ou son état de
 * chargement survivent à tout re-rendu et à tout changement d'onglet.
 */
const runtimes = new Map<string, TabRuntime>();

/** Accède (et crée à la volée) l'état runtime d'un onglet. */
export function runtimeFor(tabId: string): TabRuntime {
  let rt = runtimes.get(tabId);
  if (!rt) {
    const url = state.tabs.find((t) => t.id === tabId)?.url;
    rt = {
      stack: url ? [url] : [],
      index: url ? 0 : -1,
      viewW: null,
      viewH: null,
      reloadKey: 0,
      loading: false,
      error: null,
      canBack: false,
    };
    runtimes.set(tabId, rt);
  }
  return rt;
}

/** Réinitialise la pile d'historique d'un onglet sur une URL unique. */
export function resetTabHistory(tabId: string, url: string): void {
  const rt = runtimeFor(tabId);
  rt.stack = url ? [url] : [];
  rt.index = url ? 0 : -1;
}

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // Un abonné défaillant ne doit pas casser les autres.
    }
  }
}

/** S'abonne aux changements du store (usage `useSyncExternalStore`). */
export function subscribePreviewTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Instantané immuable — `useSyncExternalStore` exige une référence stable. */
export function getPreviewTabsSnapshot(): PreviewTabsState {
  return state;
}

let seq = 0;
/** Génère un id d'onglet unique (monotone, jamais réutilisé). */
export function nextPreviewTabId(): string {
  seq += 1;
  return `t${seq}-${Date.now().toString(36)}`;
}

/**
 * Résout un `panelId` reçu de l'agent vers le label réel de la webview cible.
 *
 * - la cible logique (`PREVIEW_ACTIVE_TARGET`) → label de l'onglet ACTIF ;
 * - un label d'onglet déjà concret → renvoyé tel quel (l'agent peut viser un
 *   onglet précis s'il le connaît) ;
 * - aucun onglet ouvert → `null` (l'appelant renvoie une erreur à l'agent).
 */
export function resolvePreviewPanel(panelId: string): string | null {
  if (panelId === PREVIEW_ACTIVE_TARGET) {
    const tab = state.tabs[state.activeIndex];
    return tab ? panelIdForTab(tab.id) : null;
  }
  return panelId;
}

/** Titre lisible d'une URL (hôte + dernier segment), pour l'inventaire agent. */
function titleForUrl(url: string): string {
  if (!url) return 'New tab';
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url;
  }
}

/**
 * Inventaire des onglets OUVERTS, tel que présenté à l'agent.
 *
 * C'est la seule vision que le modèle a du navigateur : des identifiants opaques
 * et des URLs, jamais de `panelId` ni de détail d'implémentation. L'agent peut
 * ainsi savoir combien d'onglets existent et lequel est actif, puis agir
 * précisément (`open`/`close`/`activate`) sans rien deviner.
 */
export function listPreviewTabs(): PreviewTabInfo[] {
  return state.tabs.map((t, i) => ({
    tabId: t.id,
    url: t.url,
    title: titleForUrl(t.url),
    active: i === state.activeIndex,
  }));
}

/**
 * Traduit un identifiant d'onglet fourni par l'agent en label de webview réel.
 * Renvoie `null` si l'onglet est inconnu (l'appelant renvoie une erreur claire
 * à l'agent plutôt que de viser le mauvais onglet).
 */
export function panelIdForAgentTab(tabId: string): string | null {
  return state.tabs.some((t) => t.id === tabId) ? panelIdForTab(tabId) : null;
}

/** Active l'onglet identifié par `tabId`. Renvoie vrai si trouvé. */
export function activatePreviewTabById(tabId: string): boolean {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return false;
  activatePreviewTab(idx);
  return true;
}

/** Ferme l'onglet identifié par `tabId`. Renvoie vrai si trouvé. */
export function closePreviewTabById(tabId: string): boolean {
  if (!state.tabs.some((t) => t.id === tabId)) return false;
  closePreviewTab(tabId);
  return true;
}

/** Liste des labels de webview à garder en vie (tous les onglets). */
export function livePanelIds(): string[] {
  return state.tabs.map((t) => panelIdForTab(t.id));
}

/** Crée un onglet et l'active. Renvoie son id. */
export function openPreviewTab(url: string): string {
  const id = nextPreviewTabId();
  state = { tabs: [...state.tabs, { id, url }], activeIndex: state.tabs.length };
  emit();
  return id;
}

/** Active l'onglet d'index `index` (no-op si hors bornes). */
export function activatePreviewTab(index: number): void {
  if (index < 0 || index >= state.tabs.length || index === state.activeIndex) return;
  state = { ...state, activeIndex: index };
  emit();
}

/** Ferme l'onglet `id`. Ajuste l'onglet actif si nécessaire. */
export function closePreviewTab(id: string): void {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeIndex = state.activeIndex;
  if (tabs.length === 0) activeIndex = -1;
  else if (idx < activeIndex) activeIndex -= 1;
  else if (idx === activeIndex) activeIndex = Math.min(idx, tabs.length - 1);
  state = { tabs, activeIndex };
  runtimes.delete(id);
  emit();
}

/** Remplace l'URL de l'onglet `id` (navigation dans l'onglet). */
export function setPreviewTabUrl(id: string, url: string): void {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1 || state.tabs[idx].url === url) return;
  const tabs = state.tabs.slice();
  tabs[idx] = { ...tabs[idx], url };
  state = { ...state, tabs };
  emit();
}

/** Bornes du store, pour la persistance. */
export function replacePreviewTabs(tabs: PreviewTab[], activeIndex: number): void {
  state = {
    tabs,
    activeIndex: activeIndex >= 0 && activeIndex < tabs.length ? activeIndex : tabs.length - 1,
  };
  emit();
}

/**
 * Ouvre `url` dans un onglet : réutilise l'onglet actif s'il en existe un, sinon
 * crée un nouvel onglet. C'est le comportement attendu d'un lien cliqué.
 * Renvoie l'id de l'onglet utilisé.
 */
export function navigateActiveOrCreate(url: string): string {
  if (state.activeIndex >= 0 && state.tabs[state.activeIndex]) {
    const id = state.tabs[state.activeIndex].id;
    setPreviewTabUrl(id, url);
    return id;
  }
  return openPreviewTab(url);
}
