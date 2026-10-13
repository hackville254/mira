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
