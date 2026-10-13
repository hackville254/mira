/**
 * Contrôleur de recherche pour l'éditeur CodeMirror 6.
 *
 * Isole toute la logique `@codemirror/search` derrière une petite API impérative
 * consommée par `EditorHandle` et le composant `FindWidget`. Objectif : reproduire
 * le comportement de la find widget VS Code (options, compteur, navigation,
 * remplacement) sans dépendre du panneau natif de CodeMirror (dont le rendu ne
 * correspond pas à VS Code).
 */
import { EditorView } from '@codemirror/view';
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  getSearchQuery,
} from '@codemirror/search';

/** Options de recherche reflétant celles de VS Code (casse / regex / mot entier). */
export interface SearchOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

/** État affiché par la find widget (champ, remplacement, compteur). */
export interface SearchStatus {
  query: string;
  replace: string;
  label: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
};

/** Construit une `SearchQuery` CodeMirror depuis l'état de la widget. */
function buildQuery(query: string, replace: string, options: SearchOptions): SearchQuery {
  return new SearchQuery({
    search: query,
    replace,
    caseSensitive: options.caseSensitive,
    regexp: options.regexp,
    wholeWord: options.wholeWord,
  });
}

/**
 * Compte les occurrences de `query` dans le document et calcule la position
 * relative (« N of M »). Best-effort : une regex invalide renvoie « 0/0 » sans
 * lever — la widget affiche simplement l'absence de résultat.
 */
function computeStatus(view: EditorView, query: string, replace: string, options: SearchOptions): SearchStatus {
  if (!query) return { query, replace, label: '' };
  const q = buildQuery(query, replace, options);
  let total = 0;
  let index = 0;
  const sel = view.state.selection.main;
  try {
    const cursor = q.getCursor(view.state);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      total++;
      // On compte combien de matches se trouvent avant/au niveau du curseur.
      if (step.value.from <= sel.from) index = total;
    }
  } catch {
    // Regex invalide : pas de comptage.
    return { query, replace, label: '' };
  }
  if (total === 0) return { query, replace, label: 'No results' };
  return { query, replace, label: `${index || 1} of ${total}` };
}

/** Applique une nouvelle `SearchQuery` à la vue (sans ouvrir le panneau natif). */
function applyQuery(view: EditorView, query: string, replace: string, options: SearchOptions): void {
  view.dispatch({ effects: setSearchQuery.of(buildQuery(query, replace, options)) });
}

/**
 * Façade de recherche pour une instance d'éditeur. `Editor.tsx` en crée une par
 * vue et la réutilise pour toutes les opérations.
 */
export class FindController {
  private query = '';
  private replace = '';
  private options: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS };

  constructor(private readonly getView: () => EditorView | null) {}

  /** Recharge l'état depuis les options déjà présentes dans la vue (au 1er focus). */
  syncFromView(): void {
    const view = this.getView();
    if (!view) return;
    const q = getSearchQuery(view.state);
    this.options = { caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord };
  }

  getOptions(): SearchOptions { return { ...this.options }; }

  getStatus(): SearchStatus {
    const view = this.getView();
    if (!view) return { query: this.query, replace: this.replace, label: '' };
    return computeStatus(view, this.query, this.replace, this.options);
  }

  setQuery(value: string): void {
    this.query = value;
    const view = this.getView();
    if (view) applyQuery(view, this.query, this.replace, this.options);
  }

  setReplace(value: string): void {
    this.replace = value;
    const view = this.getView();
    if (view) applyQuery(view, this.query, this.replace, this.options);
  }

  setOptions(patch: Partial<SearchOptions>): void {
    this.options = { ...this.options, ...patch };
    const view = this.getView();
    if (view) applyQuery(view, this.query, this.replace, this.options);
  }

  /** Préremplit la requête avec la sélection courante (comportement VS Code). */
  seedFromSelection(): void {
    const view = this.getView();
    if (!view) return;
    const sel = view.state.selection.main;
    if (!sel.empty) {
      this.query = view.state.sliceDoc(sel.from, sel.to);
      applyQuery(view, this.query, this.replace, this.options);
    }
  }

  next(): void { const v = this.getView(); if (v) findNext(v); }
  previous(): void { const v = this.getView(); if (v) findPrevious(v); }
  replaceNext(): void { const v = this.getView(); if (v) replaceNext(v); }
  replaceAll(): void { const v = this.getView(); if (v) replaceAll(v); }
}
