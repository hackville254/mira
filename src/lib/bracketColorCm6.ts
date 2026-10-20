import { EditorView, Decoration, ViewPlugin, type ViewUpdate, type DecorationSet } from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { IterMode } from '@lezer/common';

// ── Colorisation des paires de parenthèses (rainbow brackets) ─────────────────
// Attribue une couleur cyclique à chaque bracket selon son niveau d'imbrication,
// comme VS Code. Approche : on parcourt les nœuds « bracket » de l'arbre
// syntaxique (tokens anonymes dont le texte est un délimiteur) et on suit une
// pile pour connaître le niveau courant. Le calcul est limité à la plage
// visible + une marge, pour rester bon marché sur de gros fichiers.
//
// Le niveau est calculé par rapport au début de la plage visible (réinitialisé
// à 0) : les couleurs restent ainsi cohérentes à l'écran, sans devoir reparcourir
// tout le document.

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Nombre de couleurs distinctes (cycliques) disponibles. */
const LEVEL_COUNT = 6;

/** Classe CSS de coloration pour un niveau donné (0-based). */
function levelClass(level: number): string {
  return `cm-bracket-level${level % LEVEL_COUNT}`;
}

/** Marque posée sur un délimiteur colorisé. */
const bracketMark = (level: number) =>
  Decoration.mark({ class: levelClass(level) });

/** Borne le travail : au-delà, on ne colorise pas (fichiers énormes). */
const MAX_SCAN = 200_000; // caractères dans la plage analysée

/** Un délimiteur repéré : position + caractère. */
export interface BracketToken {
  from: number;
  to: number;
  /** Caractère délimiteur : l'un de `([{)]}`. */
  ch: string;
}

/**
 * Calcule le niveau d'imbrication de chaque délimiteur via une pile. Fonction
 * pure (sans dépendance CodeMirror) pour rester testable. Renvoie un tableau
 * `{ token, level }` dans l'ordre d'apparition.
 */
export function assignLevels(tokens: BracketToken[]): { token: BracketToken; level: number }[] {
  const stack: number[] = [];
  const out: { token: BracketToken; level: number }[] = [];
  for (const token of tokens) {
    if (OPENERS.includes(token.ch)) {
      const level = stack.length;
      stack.push(level);
      out.push({ token, level });
    } else if (CLOSERS.includes(token.ch)) {
      const level = stack.length > 0 ? stack.pop()! : 0;
      out.push({ token, level });
    }
  }
  return out;
}

/**
 * Construit le jeu de décorations pour la plage [from, to].
 */
function buildDecorations(
  view: EditorView,
  from: number,
  to: number,
): DecorationSet {
  const doc = view.state.doc;
  const start = Math.max(0, from);
  const end = Math.min(doc.length, to);
  if (end - start > MAX_SCAN) return Decoration.none;

  const tree = syntaxTree(view.state);

  // 1. Repère les tokens « bracket » dans la plage. On inclut les nœuds anonymes
  //    (les délimiteurs sont des tokens anonymes dans la plupart des grammaires).
  const tokens: BracketToken[] = [];
  tree.iterate({
    from: start,
    to: end,
    mode: IterMode.IncludeAnonymous,
    enter: node => {
      if (node.from < start || node.to > end) return;
      if (node.to - node.from !== 1) return; // un délimiteur = 1 caractère
      const ch = doc.sliceString(node.from, node.to);
      if (OPENERS.includes(ch) || CLOSERS.includes(ch)) {
        tokens.push({ from: node.from, to: node.to, ch });
      }
    },
  });

  // 2. Niveaux par pile (ordre croissant garanti par le parcours de l'arbre).
  const builder = new RangeSetBuilder<Decoration>();
  for (const { token, level } of assignLevels(tokens)) {
    builder.add(token.from, token.to, bracketMark(level));
  }
  return builder.finish();
}

/** Thème des couleurs de brackets (réutilise la palette `accent.*`). */
const bracketTheme = EditorView.baseTheme({
  '.cm-bracket-level0': { color: 'var(--origin-accent-blue)' },
  '.cm-bracket-level1': { color: 'var(--origin-accent-pink)' },
  '.cm-bracket-level2': { color: 'var(--origin-accent-yellow)' },
  '.cm-bracket-level3': { color: 'var(--origin-accent-green)' },
  '.cm-bracket-level4': { color: 'var(--origin-accent-purple)' },
  '.cm-bracket-level5': { color: 'var(--origin-accent-cyan)' },
});

/**
 * Extension : colorise les paires de parenthèses par niveau d'imbrication.
 * Recalcule les décorations à chaque changement du document ou du viewport,
 * uniquement sur la plage visible (+ marge d'une ligne).
 */
export function createBracketColorizationExtension(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, ...this.range(view));
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, ...this.range(update.view));
        }
      }

      /** Plage à analyser : viewport élargi d'une ligne de marge de chaque côté. */
      range(view: EditorView): [number, number] {
        const ranges = view.visibleRanges;
        if (ranges.length === 0) return [0, 0];
        const doc = view.state.doc;
        const first = doc.lineAt(ranges[0].from);
        const last = doc.lineAt(ranges[ranges.length - 1].to);
        const from = first.number > 1 ? doc.line(first.number - 1).from : 0;
        const to = last.number < doc.lines ? doc.line(last.number + 1).to : doc.length;
        return [from, to];
      }
    },
    { decorations: v => v.decorations },
  );

  return [bracketTheme, plugin];
}
