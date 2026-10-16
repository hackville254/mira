// ── Passerelle vers l'éditeur actif ──────────────────────────────────────────
//
// Les commandes (palette, raccourcis globaux) peuvent s'exécuter alors que le
// focus est hors de l'éditeur (ex. input de la palette). Ce module expose le
// handle de l'éditeur actif ainsi que le `EditorView` CodeMirror courant, sans
// passer par des props/refs React — un simple registre module-level.
//
// App publie le handle actif (éditeur principal ou splitté) via
// `setActiveEditor` ; Editor publie sa vue via `setActiveEditorView`.

import type { EditorHandle } from '../../components/editor/Editor';
import type { EditorView } from '@codemirror/view';

let activeEditor: EditorHandle | null = null;
let activeView: EditorView | null = null;

export function setActiveEditor(handle: EditorHandle | null): void {
  activeEditor = handle;
}

export function getActiveEditor(): EditorHandle | null {
  return activeEditor;
}

export function setActiveEditorView(view: EditorView | null): void {
  activeView = view;
}

export function getActiveEditorView(): EditorView | null {
  return activeView;
}

/**
 * Vrai si le focus clavier est actuellement DANS un éditeur CodeMirror.
 *
 * On ne se fie pas à `activeView` seul : ce registre est aussi renseigné à la
 * création de la vue, pas uniquement au focus. Pour décider si un raccourci
 * purement « éditeur » doit s'appliquer (ex. Ctrl+A = tout sélectionner DANS le
 * fichier), on regarde le focus réel du DOM : `activeElement` à l'intérieur d'un
 * `.cm-editor`. Hors éditeur (arbre de fichiers, chat, input…), le raccourci ne
 * doit PAS être détourné — sinon Ctrl+A sélectionnait toute l'UI.
 */
export function isEditorFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.closest('.cm-editor') !== null;
}

/**
 * Vrai si le focus clavier est dans un `<input>`/`<textarea>` NATIF.
 *
 * Dans ces contrôles, le Ctrl+A natif est **fiable et scopé** : il sélectionne le
 * texte du champ. On laisse donc filer l'événement sans le prévenir.
 *
 * NB : on exclut volontairement les `contenteditable` (ex. composer du chat) —
 * leur Ctrl+A natif n'est PAS scopé de façon fiable selon les moteurs et pouvait
 * sélectionner tout le document (noms de fichiers, chrome de l'IDE).
 */
export function isNativeTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  // Les input non textuels (case à cocher, bouton, range…) n'ont pas de
  // sélection textuelle : Ctrl+A n'y a pas de sens.
  const type = (el as HTMLInputElement).type;
  return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type);
}

/**
 * Vrai si le focus clavier est dans un `contenteditable` hors CodeMirror
 * (typiquement le composer du chat).
 *
 * Ces zones ne sont pas des inputs natifs : leur sélection « tout » doit être
 * gérée **explicitement** (voir `selectContentEditable`) pour rester confinée au
 * contenu de la zone, sans déborder sur le reste de l'UI.
 */
export function isContentEditableFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.isContentEditable && el.closest('.cm-editor') === null;
}

/**
 * Sélectionne tout le contenu d'un `contenteditable` (et rien d'autre).
 * Retourne `true` si la sélection a pu être posée.
 */
export function selectContentEditable(el: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
