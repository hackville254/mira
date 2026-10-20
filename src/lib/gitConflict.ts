import {
  EditorView,
  Decoration,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import {
  StateField,
  EditorSelection,
  type EditorState,
  type Extension,
} from '@codemirror/state';

// ── Modèle ──────────────────────────────────────────────────────────────────

/** Un bloc de conflit Git délimité par `<<<<<<<` … `>>>>>>>`. */
export interface ConflictBlock {
  /** Ligne (1-based) du marqueur `<<<<<<<`. */
  startLine: number;
  /** Ligne du `=======`. */
  separatorLine: number;
  /** Ligne du marqueur `>>>>>>>`. */
  endLine: number;
}

/** Un côté d'un conflit (bloc de lignes entre deux marqueurs). */
export interface ConflictSide {
  /** Index de la ligne (1-based) de la première ligne de texte. */
  firstLine: number;
  /** Index de la ligne (1-based) de la dernière ligne de texte. */
  lastLine: number;
}

const START_MARKER = /^<{7}(?: .*)?$/;
const SEPARATOR_MARKER = /^={7}$/;
const END_MARKER = /^>{7}(?: .*)?$/;

/**
 * Détecte tous les blocs de conflit Git d'un document. Tolère les variantes
 * `<<<<<<< HEAD`, `>>>>>>> branch` ainsi que les conflits imbriqués en
 * appariant chaque `<<<<<<<` avec le `>>>>>>>` correspondant.
 */
export function findConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  // Pile des `<<<<<<<` ouverts : gère l'imbrication (rare mais possible).
  const stack: { startLine: number; separatorLine: number | null }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (START_MARKER.test(line)) {
      stack.push({ startLine: i + 1, separatorLine: null });
    } else if (SEPARATOR_MARKER.test(line) && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.separatorLine === null) top.separatorLine = i + 1;
    } else if (END_MARKER.test(line) && stack.length > 0) {
      const top = stack.pop()!;
      // `base` (|||||||) n'est pas toujours présent : on garde le dernier =====.
      blocks.push({
        startLine: top.startLine,
        separatorLine: top.separatorLine ?? top.startLine,
        endLine: i + 1,
      });
    }
  }

  return blocks.sort((a, b) => a.startLine - b.startLine);
}

/** Bornes (1-based, inclusives) de la section « actuelle » (entre <<<< et ====). */
export function currentSide(block: ConflictBlock): ConflictSide {
  return { firstLine: block.startLine + 1, lastLine: block.separatorLine - 1 };
}

/** Bornes (1-based, inclusives) de la section « entrante » (entre ==== et >>>>). */
export function incomingSide(block: ConflictBlock): ConflictSide {
  return { firstLine: block.separatorLine + 1, lastLine: block.endLine - 1 };
}

// ── Résolution (fonctions pures, testables) ─────────────────────────────────

export type Resolution = 'current' | 'incoming' | 'both';

/**
 * Applique une résolution à un document texte et renvoie la nouvelle version.
 * - `current`  : ne garde que la section actuelle (HEAD) ;
 * - `incoming` : ne garde que la section entrante ;
 * - `both`     : garde les deux sections (actuelle puis entrante).
 * Tous les marqueurs `<<<<<<<`, `=======`, `>>>>>>>` du bloc sont retirés.
 */
export function resolveConflict(text: string, block: ConflictBlock, resolution: Resolution): string {
  const lines = text.split('\n');
  const before = lines.slice(0, block.startLine - 1);
  const after = lines.slice(block.endLine);

  const cur = lines.slice(block.startLine, block.separatorLine - 1);
  const inc = lines.slice(block.separatorLine, block.endLine - 1);

  let kept: string[];
  if (resolution === 'current') kept = cur;
  else if (resolution === 'incoming') kept = inc;
  else kept = [...cur, ...inc];

  return [...before, ...kept, ...after].join('\n');
}

// ── Décoration CodeMirror 6 ─────────────────────────────────────────────────

class ConflictWidget extends WidgetType {
  constructor(readonly block: ConflictBlock) { super(); }
  eq(other: ConflictWidget): boolean {
    return other.block.startLine === this.block.startLine
      && other.block.endLine === this.block.endLine;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-conflict-actions';
    for (const [label, res] of [
      ['Accept Current', 'current'],
      ['Accept Incoming', 'incoming'],
      ['Accept Both', 'both'],
    ] as const) {
      const btn = document.createElement('button');
      btn.className = 'cm-conflict-btn';
      btn.textContent = label;
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        resolveConflictInView(el, res);
      });
      el.appendChild(btn);
    }
    return el;
  }
  ignoreEvent(): boolean { return false; }
}

const startLineDeco = Decoration.line({ class: 'cm-conflict-line cm-conflict-start' });
const separatorLineDeco = Decoration.line({ class: 'cm-conflict-line cm-conflict-separator' });
const endLineDeco = Decoration.line({ class: 'cm-conflict-line cm-conflict-end' });
const markerLineDeco = Decoration.line({ class: 'cm-conflict-line cm-conflict-marker' });

/** Retrouve la vue CodeMirror associée à un élément DOM et applique la
 *  résolution du bloc de conflit qui le précède. */
function resolveConflictInView(el: HTMLElement, resolution: Resolution) {
  const view = EditorView.findFromDOM(el);
  if (!view) return;
  const pos = view.posAtDOM(el);
  const line = view.state.doc.lineAt(pos).number;

  // Le widget est posé en fin de ligne `<<<<<<<` : on cherche le bloc dont ce
  // marqueur est le plus proche au-dessus de `line`.
  const blocks = findConflictBlocks(view.state.doc.toString());
  const block = blocks.find(b => b.startLine === line) ?? blocks.find(b => b.startLine <= line && line <= b.endLine);
  if (!block) return;

  const next = resolveConflict(view.state.doc.toString(), block, resolution);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    selection: EditorSelection.cursor(0),
    scrollIntoView: true,
  });
  view.focus();
}

function buildConflictDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  // Sortie rapide : la quasi-totalité des fichiers n'ont aucun marqueur.
  if (!text.includes('<<<<<<<')) return Decoration.none;

  const blocks = findConflictBlocks(text);
  const ranges: ReturnType<typeof startLineDeco.range>[] = [];

  for (const block of blocks) {
    if (block.startLine > state.doc.lines) continue;
    const start = state.doc.line(block.startLine);
    ranges.push(startLineDeco.range(start.from));
    // Un widget distinct par bloc (il porte l'identité du bloc pour la résolution).
    ranges.push(Decoration.widget({ widget: new ConflictWidget(block), side: 1 }).range(start.to));

    for (let l = block.startLine + 1; l <= block.separatorLine - 1; l++) {
      if (l <= state.doc.lines) ranges.push(markerLineDeco.range(state.doc.line(l).from));
    }
    if (block.separatorLine <= state.doc.lines) {
      ranges.push(separatorLineDeco.range(state.doc.line(block.separatorLine).from));
    }
    for (let l = block.separatorLine + 1; l <= block.endLine - 1; l++) {
      if (l <= state.doc.lines) ranges.push(markerLineDeco.range(state.doc.line(l).from));
    }
    if (block.endLine <= state.doc.lines) {
      ranges.push(endLineDeco.range(state.doc.line(block.endLine).from));
    }
  }

  return Decoration.set(ranges, true);
}

export const conflictField = StateField.define<DecorationSet>({
  create: state => buildConflictDecorations(state),
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    return buildConflictDecorations(tr.state);
  },
  provide: f => EditorView.decorations.from(f),
});

const conflictTheme = EditorView.baseTheme({
  '.cm-conflict-line': { backgroundColor: 'color-mix(in srgb, var(--origin-git-conflict) 12%, transparent)' },
  '.cm-conflict-start': { borderTop: '1px solid var(--origin-git-conflict)' },
  '.cm-conflict-end': { borderBottom: '1px solid var(--origin-git-conflict)' },
  '.cm-conflict-marker': { opacity: '0.85' },
  '.cm-conflict-separator': { backgroundColor: 'color-mix(in srgb, var(--origin-git-conflict) 22%, transparent)' },
  '.cm-conflict-actions': {
    display: 'inline-flex',
    gap: '4px',
    marginLeft: '8px',
    verticalAlign: 'middle',
  },
  '.cm-conflict-btn': {
    fontSize: '11px',
    lineHeight: '1.4',
    padding: '1px 6px',
    border: '1px solid var(--origin-border)',
    borderRadius: '3px',
    background: 'var(--origin-bg-elevated, transparent)',
    color: 'var(--origin-fg)',
    cursor: 'pointer',
  },
  '.cm-conflict-btn:hover': { background: 'var(--origin-bg-hover, rgba(255,255,255,0.08))' },
});

/**
 * Extension « merge conflict resolver » : surligne les blocs de conflit Git et
 * affiche, à la fin du marqueur `<<<<<<<`, trois boutons de résolution
 * (Accept Current / Accept Incoming / Accept Both).
 */
export function createConflictResolver(): Extension {
  return [conflictField, conflictTheme];
}
