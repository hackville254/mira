import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  StateField,
  StateEffect,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

// ── Sticky scroll ─────────────────────────────────────────────────────────────
// Épingle en haut de l'éditeur les « en-têtes » des blocs englobants (fonctions,
// classes, boucles…) lorsque leur première ligne est sortie du viewport — comme
// VS Code. Approche : un overlay positionné en absolu dans le `.cm-editor`, dont
// les lignes sont recalculées depuis l'arbre syntaxique à chaque mise à jour.
//
// Important : on réserve la hauteur de l'overlay en haut du scroller via
// `EditorView.scrollMargins` (padding-top dynamique). Sans cela, l'overlay
// recouvre les lignes réellement visibles → impression de lignes « dupliquées ».

interface StickyHeader {
  /** Numéro de ligne (1-based) de l'en-tête. */
  line: number;
  /** Offset du début de la ligne d'en-tête, pour le clic. */
  from: number;
  /** Texte brut de la ligne d'en-tête. */
  text: string;
}

const LINE_HEIGHT_PX = 21.45; // 13px × 1.65 (cf. `.cm-scroller`), hauteur d'une ligne épinglée.

/** Nombre de lignes actuellement épinglées en haut (0 = pas d'overlay). */
const stickyCountField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setStickyCount)) return e.value;
    }
    if (tr.docChanged) return value; // sera recalculé par le plugin
    return value;
  },
});

const setStickyCount = StateEffect.define<number>();

/**
 * Remonte la chaîne d'ancêtres syntaxiques du début du viewport et retient ceux
 * qui débutent au-dessus de la première ligne visible et la débordent. Renvoyé
 * du plus externe au plus interne (ordre d'empilement à l'écran).
 */
function enclosingHeaders(state: EditorState, topPos: number): StickyHeader[] {
  const topLineNo = state.doc.lineAt(topPos).number;
  const tree = syntaxTree(state);
  const out: StickyHeader[] = [];

  let node: SyntaxNode | null = tree.resolveInner(topPos, 1);
  while (node) {
    if (node.from < topPos && node.to > topPos) {
      const start = state.doc.lineAt(node.from);
      const end = state.doc.lineAt(node.to);
      // Multi-ligne, en-tête strictement au-dessus du haut visible, ligne non vide.
      if (end.number > start.number && start.number < topLineNo && start.text.trim()) {
        out.push({ line: start.number, from: start.from, text: start.text });
      }
    }
    node = node.parent;
  }
  return out.reverse();
}

const stickyScrollPlugin = ViewPlugin.fromClass(
  class {
    dom: HTMLElement;
    private key = '';
    /** Nombre de lignes épinglées au dernier rendu (évite des dispatchs inutiles). */
    private count = 0;
    /** Passe à true à la destruction : neutralise les dispatchs différés. */
    private disposed = false;

    constructor(view: EditorView) {
      this.dom = document.createElement('div');
      this.dom.className = 'cm-sticky-scroll';
      this.dom.setAttribute('aria-hidden', 'true');
      view.dom.appendChild(this.dom);
      // Empêche la perte de sélection quand on interagit avec les lignes épinglées.
      this.dom.addEventListener('mousedown', e => e.preventDefault());
      this.render(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.render(update.view);
      }
    }

    destroy() {
      this.disposed = true;
      this.dom.remove();
    }

    render(view: EditorView) {
      const topPos = view.visibleRanges.length ? view.visibleRanges[0].from : 0;
      const lines = enclosingHeaders(view.state, topPos);
      const key = JSON.stringify(lines);
      if (key === this.key) return;
      this.key = key;

      // Aligne l'overlay sur le contenu, à droite de la gouttière des numéros.
      const gutters = view.dom.querySelector('.cm-gutters') as HTMLElement | null;
      const gutterW = gutters ? gutters.getBoundingClientRect().width : 0;
      this.dom.style.left = `${gutterW}px`;

      this.dom.replaceChildren();
      if (!lines.length) {
        this.dom.style.display = 'none';
        this.reserve(view, 0);
        return;
      }
      this.dom.style.display = 'block';
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = 'cm-sticky-scroll-row';
        row.textContent = line.text;
        row.title = line.text;
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
          view.focus();
        });
        this.dom.appendChild(row);
      }
      this.reserve(view, lines.length);
    }

    /** Réserve la hauteur de l'overlay en haut du scroller pour ne rien recouvrir. */
    private reserve(view: EditorView, count: number) {
      if (count === this.count) return;
      this.count = count;
      if (!view.state.field(stickyCountField, false)) return;
      // On ne peut pas dispatcher pendant une mise à jour de vue : on diffère.
      queueMicrotask(() => {
        if (this.disposed) return;
        if (view.state.field(stickyCountField, false) === count) return;
        view.dispatch({ effects: setStickyCount.of(count) });
      });
    }
  }
);

/** Réserve un padding-top égal à la hauteur de l'overlay épinglé. */
const stickyScrollMargins = EditorView.scrollMargins.of(view => {
  const count = view.state.field(stickyCountField, false) ?? 0;
  return count > 0 ? { top: count * LINE_HEIGHT_PX } : null;
});

/** Extension CodeMirror activant le sticky scroll. */
export function stickyScroll(): Extension {
  return [stickyCountField, stickyScrollMargins, stickyScrollPlugin];
}
