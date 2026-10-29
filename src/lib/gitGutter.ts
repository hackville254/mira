import { diff } from '@codemirror/merge';
import {
  EditorView,
  GutterMarker,
  gutter,
} from '@codemirror/view';
import {
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';

// ── Modèle ──────────────────────────────────────────────────────────────────

export type LineChangeKind = 'added' | 'modified' | 'deleted';

export interface LineChange {
  /** Numéro de ligne (1-based) dans le document courant. */
  line: number;
  kind: LineChangeKind;
}

/**
 * Calcule, pour chaque ligne du document courant, son état vis-à-vis de la
 * référence (contenu à HEAD) :
 * - `added`    : lignes absentes de la référence ;
 * - `modified` : lignes présentes des deux côtés mais modifiées ;
 * - `deleted`  : lignes supprimées par rapport à la référence (le marqueur est
 *   posé sur la ligne de frontière, comme VS Code).
 *
 * S'appuie sur l'algorithme de diff de `@codemirror/merge`, borné dans le temps
 * (`timeout`/`scanLimit`) pour ne jamais bloquer la frappe sur un gros fichier.
 */
export function computeLineChanges(original: string, current: string): LineChange[] {
  if (original === current) return [];

  // La référence vient de git et peut contenir des CRLF : on normalise en LF
  // pour ne signaler que les vraies différences (le document utilise LF).
  const a = original.replace(/\r\n/g, '\n');
  const b = current.replace(/\r\n/g, '\n');

  const changes = diff(a, b, { timeout: 60, scanLimit: 8_000 });
  const index = new LineIndex(b);
  const marks = new Map<number, LineChangeKind>();

  const set = (line: number, kind: LineChangeKind) => {
    const prev = marks.get(line);
    if (prev === undefined) marks.set(line, kind);
    else marks.set(line, mergeKind(prev, kind));
  };

  for (const c of changes) {
    if (c.toB > c.fromB) {
      // Insertion ou remplacement : toutes les lignes de B couvertes.
      const kind: LineChangeKind = c.toA > c.fromA ? 'modified' : 'added';
      let first = index.lineAt(c.fromB);
      // Cas particulier : le diff peut inclure le `\n` final de la ligne
      // précédente dans le texte inséré (ajout en fin de fichier). Dans ce cas
      // la ligne de frontière n'est pas nouvelle : on démarre après.
      if (kind === 'added' && b.charCodeAt(c.fromB) === 10) first += 1;
      const last = index.lineAt(c.toB - 1);
      for (let l = first; l <= last; l++) set(l, kind);
    } else {
      // Suppression : rien dans B, marqueur posé sur la ligne de frontière.
      set(index.lineAt(c.fromB), 'deleted');
    }
  }

  return [...marks.entries()]
    .map(([line, kind]) => ({ line, kind }))
    .sort((x, y) => x.line - y.line);
}

/** Priorité en cas de collision sur une même ligne : un vrai changement de
 *  contenu (added/modified) prime sur un simple marqueur de suppression. */
function mergeKind(a: LineChangeKind, b: LineChangeKind): LineChangeKind {
  if (a === 'deleted') return b;
  return a;
}

class LineIndex {
  private readonly starts: number[];

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }

  /** Ligne (1-based) contenant `offset` (borné à [0, text.length]). */
  lineAt(offset: number): number {
    const max = this.starts[this.starts.length - 1];
    const o = offset < 0 ? 0 : offset > max ? max : offset;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/**
 * Chemin relatif de `abs` dans `root`, avec séparateurs `/`. Renvoie `null` si
 * `abs` n'est pas contenu dans `root`.
 */
export function relativeToRoot(root: string, abs: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = abs.replace(/\\/g, '/');
  if (a === r) return '';
  if (!a.startsWith(r + '/')) return null;
  return a.slice(r.length + 1);
}

// ── Extension CodeMirror 6 ──────────────────────────────────────────────────

/** Met à jour la référence HEAD du gutter. `null` = pas de référence (fichier
 *  hors dépôt git) → aucun marqueur affiché. */
export const setGitBaselineEffect = StateEffect.define<string | null>();

/** Au-delà de ce nombre de lignes, on n'affiche pas le gutter (coût du diff). */
const MAX_LINES = 50_000;

class GitGutterMarker extends GutterMarker {
  constructor(readonly kind: LineChangeKind) { super(); }
  eq(other: GitGutterMarker): boolean { return other.kind === this.kind; }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = `cm-gitGutter-marker cm-gitGutter-${this.kind}`;
    return el;
  }
}

const gitBaselineField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGitBaselineEffect)) return e.value;
    return value;
  },
});

function buildMarkers(state: EditorState): RangeSet<GitGutterMarker> {
  const baseline = state.field(gitBaselineField);
  if (baseline === null || state.doc.lines > MAX_LINES) return RangeSet.empty;

  const changes = computeLineChanges(baseline, state.doc.toString());
  let set: RangeSet<GitGutterMarker> = RangeSet.empty;
  for (const c of changes) {
    if (c.line < 1 || c.line > state.doc.lines) continue;
    set = set.update({ add: [new GitGutterMarker(c.kind).range(state.doc.line(c.line).from)] });
  }
  return set;
}

const gitGutterField = StateField.define<RangeSet<GitGutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    const baselineChanged = tr.effects.some(e => e.is(setGitBaselineEffect));
    if (!baselineChanged && !tr.docChanged) return set.map(tr.changes);
    return buildMarkers(tr.state);
  },
});

const gitGutterTheme = EditorView.baseTheme({
  '.cm-gitGutter': { width: '6px' },
  '.cm-gitGutter-marker': {
    width: '3px',
    height: '100%',
    margin: '0 auto',
    borderRadius: '1px',
  },
  '.cm-gitGutter-added': { backgroundColor: 'var(--origin-git-added)' },
  '.cm-gitGutter-modified': { backgroundColor: 'var(--origin-git-modified)' },
  '.cm-gitGutter-deleted': {
    width: '0',
    height: '0',
    margin: '4px auto 0',
    borderRadius: '0',
    borderLeft: '4px solid transparent',
    borderRight: '4px solid transparent',
    borderTop: '4px solid var(--origin-git-deleted)',
  },
});

/**
 * Extension du gutter « inline diff » : affiche une barre colorée par ligne
 * modifiée / ajoutée et un triangle sur les suppressions, relativement à la
 * référence HEAD injectée via `setGitBaselineEffect`.
 */
export function createGitGutter(): Extension {
  return [
    gitBaselineField,
    gitGutterField,
    gitGutterTheme,
    gutter({
      class: 'cm-gitGutter',
      markers: view => view.state.field(gitGutterField),
      initialSpacer: () => new GitGutterMarker('added'),
    }),
  ];
}