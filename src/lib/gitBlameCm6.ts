import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import {
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';

// ── Git blame (annotation inline de la ligne courante) ────────────────────────
// Comme VS Code : on affiche, en fin de ligne courante, un libellé discret
// « auteur · date relative ». Les données de blame sont injectées via un effet ;
// la décoration suit la sélection.

/** Une entrée de blame (miroir de `BlameLine` côté Rust). */
export interface BlameEntry {
  line: number;
  hash: string;
  author: string;
  /** Timestamp Unix (secondes). */
  time: number;
  summary: string;
}

/** Injecte (ou efface avec `[]`) les données de blame dans l'éditeur. */
export const setBlameEffect = StateEffect.define<BlameEntry[]>();

/** Formatte un timestamp Unix en date relative compacte (ex: « 3 days ago »). */
export function relativeDate(epochSeconds: number, now = Date.now()): string {
  if (!epochSeconds) return '';
  const diff = Math.max(0, Math.floor(now / 1000) - epochSeconds);
  if (diff < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
    [31536000, 'year'],
  ];
  let value = diff;
  let unit = 'second';
  for (let i = units.length - 1; i >= 0; i--) {
    if (diff >= units[i][0]) {
      value = Math.floor(diff / units[i][0]);
      unit = units[i][1];
      break;
    }
  }
  return `${value} ${unit}${value !== 1 ? 's' : ''} ago`;
}

/** Décoration de widget affichée en fin de ligne. */
class BlameWidget extends WidgetType {
  constructor(readonly entry: BlameEntry) { super(); }
  eq(other: BlameWidget): boolean {
    return other.entry.hash === this.entry.hash
      && other.entry.author === this.entry.author
      && other.entry.time === this.entry.time;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-blameAnnotation';
    const date = relativeDate(this.entry.time);
    el.textContent = `  ${this.entry.author}${date ? `, ${date}` : ''}`;
    el.title = `${this.entry.author}, ${date}\n${this.entry.summary}`;
    return el;
  }
  ignoreEvent(): boolean { return true; }
}

const blameDataField = StateField.define<Map<number, BlameEntry>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setBlameEffect)) {
        next = new Map();
        for (const entry of e.value) next.set(entry.line, entry);
      }
    }
    // Le document a changé : les positions ne sont plus fiables → on efface,
    // l'annotation sera réinjectée par le plugin qui charge le blame.
    if (tr.docChanged) next = new Map();
    return next;
  },
});

/** Construit la décoration pour la ligne du curseur (une seule annotation). */
function buildBlameDecorations(state: EditorState): DecorationSet {
  const data = state.field(blameDataField);
  if (data.size === 0) return Decoration.none;
  const line = state.doc.lineAt(state.selection.main.head);
  const entry = data.get(line.number);
  if (!entry) return Decoration.none;
  const deco = Decoration.widget({ widget: new BlameWidget(entry), side: 1 });
  return RangeSet.of([deco.range(line.to)]);
}

const blameField = StateField.define<DecorationSet>({
  create: state => buildBlameDecorations(state),
  update(_deco, tr) {
    const dataChanged = tr.effects.some(e => e.is(setBlameEffect));
    if (!dataChanged && !tr.docChanged && !tr.selection) return _deco;
    return buildBlameDecorations(tr.state);
  },
  provide: f => EditorView.decorations.from(f),
});

const blameTheme = EditorView.baseTheme({
  '.cm-blameAnnotation': {
    color: 'var(--origin-fg-subtle)',
    fontSize: '80%',
    fontStyle: 'italic',
    opacity: '0.8',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  },
});

/** Extension : annotation git blame de la ligne courante. */
export function createBlameExtension(): Extension {
  return [blameDataField, blameField, blameTheme];
}
