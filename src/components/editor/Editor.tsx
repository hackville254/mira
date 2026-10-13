/* eslint-disable react-refresh/only-export-components -- this module exports helper hooks/utilities alongside the editor component */
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { Lightbulb } from 'lucide-react';
import {
  EditorView, keymap, lineNumbers,
  highlightActiveLineGutter, highlightActiveLine, drawSelection,
} from '@codemirror/view';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { undo as cmUndo, redo as cmRedo, selectAll as cmSelectAll, defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle,
  bracketMatching, indentOnInput,
  codeFolding, foldGutter, foldKeymap,
} from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { showMinimap } from '@replit/codemirror-minimap';
import { stickyScroll } from '../../lib/stickyScroll';
import { tags as t } from '@lezer/highlight';
import { unifiedMergeView } from '@codemirror/merge';
import { createHunkControls } from '../../lib/hunkControls';
import { createGitGutter, setGitBaselineEffect, relativeToRoot } from '../../lib/gitGutter';
import { createConflictResolver } from '../../lib/gitConflict';
import { gitFileHead, onGitChanged } from '../../lib/git';
import { getLanguageExtension, languageLabel } from './languageSupport';
import { useExtensions } from '../../context/ExtensionsContext';
import { createLspExtension, lspFormatDocument, lspPrepareRename, lspRename, lspCodeActions, lspExecuteCommand, uriToPath, type RawCodeAction } from '../../lib/lspCm6';
import type { MissingServerInfo } from '../../lib/lspCm6';
import { lspPosToOffset, offsetToLspPos, flattenWorkspaceEdit, type FileEdits, type LspWorkspaceEdit } from '../../lib/lspEdits';
import { forEachDiagnostic } from '@codemirror/lint';
import { isLspSupported } from '../../lib/lsp';
import { resolveLspConfig, findServerForFile } from '../../lib/lspConfigStore';
import { useToast } from '../ui/Toast';
import { createAiAutocompleteExtension, type AiCompletionFn } from '../../lib/aiAutocomplete';
import {
  createDapExtension,
  addBreakpointEffect,
  clearBreakpointsEffect,
  setPausedLineEffect,
} from '../../lib/dapCm6';

// ── Syntax token colors — all via CSS variables ────────────────────────────────

export const originHighlight = HighlightStyle.define([
  { tag: t.comment,                                    color: 'var(--origin-syntax-comment)', fontStyle: 'italic' },
  { tag: t.lineComment,                                color: 'var(--origin-syntax-comment)', fontStyle: 'italic' },
  { tag: t.blockComment,                               color: 'var(--origin-syntax-comment)', fontStyle: 'italic' },
  { tag: t.keyword,                                    color: 'var(--origin-syntax-keyword)' },
  { tag: t.controlKeyword,                             color: 'var(--origin-syntax-keyword)' },
  { tag: t.definitionKeyword,                          color: 'var(--origin-syntax-keyword)' },
  { tag: t.moduleKeyword,                              color: 'var(--origin-syntax-keyword)' },
  { tag: [t.string, t.special(t.string)],              color: 'var(--origin-syntax-string)' },
  { tag: t.regexp,                                     color: 'var(--origin-syntax-string)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--origin-syntax-function)' },
  { tag: t.definition(t.variableName),                 color: 'var(--origin-syntax-function)' },
  { tag: t.definition(t.function(t.variableName)),     color: 'var(--origin-syntax-function)' },
  { tag: t.variableName,                               color: 'var(--origin-syntax-variable)' },
  { tag: t.propertyName,                               color: 'var(--origin-syntax-variable)' },
  { tag: [t.number, t.integer, t.float],               color: 'var(--origin-syntax-constant)' },
  { tag: t.constant(t.variableName),                   color: 'var(--origin-syntax-constant)' },
  { tag: t.bool,                                       color: 'var(--origin-syntax-constant)' },
  { tag: t.null,                                       color: 'var(--origin-syntax-constant)' },
  { tag: [t.typeName, t.className, t.namespace],       color: 'var(--origin-syntax-type)' },
  { tag: t.typeOperator,                               color: 'var(--origin-syntax-type)' },
  { tag: [t.operator, t.punctuation],                  color: 'var(--origin-syntax-operator)' },
  { tag: t.special(t.punctuation),                     color: 'var(--origin-syntax-operator)' },
  { tag: t.attributeName,                              color: 'var(--origin-syntax-attribute)' },
  { tag: t.attributeValue,                             color: 'var(--origin-syntax-string)' },
  { tag: t.tagName,                                    color: 'var(--origin-syntax-keyword)' },
  { tag: t.self,                                       color: 'var(--origin-syntax-keyword)' },
  { tag: [t.meta, t.documentMeta],                     color: 'var(--origin-syntax-comment)' },
  { tag: t.strong,                                     fontWeight: 'bold' },
  { tag: t.emphasis,                                   fontStyle: 'italic' },
  { tag: t.strikethrough,                              textDecoration: 'line-through' },
  { tag: t.link,                                       color: 'var(--origin-syntax-constant)', textDecoration: 'underline' },
  { tag: t.heading,                                    color: 'var(--origin-syntax-keyword)', fontWeight: 'bold' },
]);

// ── Structural theme ───────────────────────────────────────────────────────────

export const originBaseTheme = EditorView.theme({
  '&': {
    height: '100%',
    position: 'relative',
    backgroundColor: 'transparent',
    color: 'var(--origin-fg-default)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, "Geist Mono", "Fira Code", monospace)',
    fontSize: '13px',
    lineHeight: '1.65',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '2px 0',
    caretColor: 'var(--origin-accent-blue)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    borderRight: '1px solid var(--origin-border-default)',
    color: 'var(--origin-fg-subtle)',
    paddingRight: '0',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '3.2em',
    padding: '0 12px 0 8px',
    textAlign: 'right',
  },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--origin-accent-blue)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--origin-bg-hover)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: '4px',
    color: 'var(--origin-fg-subtle)',
    padding: '0 6px',
    margin: '0 2px',
    cursor: 'pointer',
  },
  // ── Minimap ────────────────────────────────────────────────────────────────
  '.cm-minimap-gutter': {
    borderRight: 'none',
    borderLeft: '1px solid var(--origin-border-default)',
    backgroundColor: 'transparent',
  },
  // ── Sticky scroll ────────────────────────────────────────────────────────────
  '.cm-sticky-scroll': {
    position: 'absolute',
    top: '0',
    right: '0',
    zIndex: '6',
    display: 'none',
    backgroundColor: 'var(--origin-bg-base)',
    borderBottom: '1px solid var(--origin-border-default)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    fontFamily: 'var(--font-mono, "Geist Mono", "Fira Code", monospace)',
    fontSize: '13px',
    lineHeight: '1.65',
    overflow: 'hidden',
    userSelect: 'none',
  },
  '.cm-sticky-scroll-row': {
    padding: '0 12px 0 10px',
    whiteSpace: 'pre',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--origin-fg-muted)',
    cursor: 'pointer',
  },
  '.cm-sticky-scroll-row:hover': { color: 'var(--origin-fg-default)', backgroundColor: 'var(--origin-bg-hover)' },
  '.cm-activeLine': { backgroundColor: 'var(--origin-bg-hover)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--origin-bg-hover)',
    color: 'var(--origin-fg-muted)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--origin-accent-blue)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--origin-accent-blue) 15%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--origin-accent-blue) 40%, transparent)',
    borderRadius: '2px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--origin-bg-base)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: '6px',
    color: 'var(--origin-fg-default)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--origin-bg-hover)',
  },
  '.cm-panels': { backgroundColor: 'var(--origin-bg-base)', color: 'var(--origin-fg-default)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--origin-border-default)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--origin-border-default)' },
  '.cm-search': {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px',
    padding: '6px 10px',
    backgroundColor: 'var(--origin-bg-base)',
  },
  '.cm-search label': { fontSize: '12px', color: 'var(--origin-fg-muted)', display: 'flex', alignItems: 'center', gap: '4px' },
  '.cm-textfield': {
    background: 'var(--origin-bg-input)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: '5px',
    color: 'var(--origin-fg-default)',
    padding: '3px 7px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
    minWidth: '120px',
  },
  '.cm-textfield:focus': { borderColor: 'var(--origin-accent-blue)' },
  '.cm-button': {
    background: 'var(--origin-bg-hover)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: '5px',
    color: 'var(--origin-fg-default)',
    padding: '3px 10px',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-button:hover': { background: 'var(--origin-bg-active)' },
  // ── Unified merge view (diff) ─────────────────────────────────────────────
  '.cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-error) 14%, transparent)',
  },
  '.cm-deletedChunk-gutter': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-error) 28%, transparent)',
    borderRight: '3px solid color-mix(in srgb, var(--origin-semantic-error) 65%, transparent)',
  },
  '.cm-changedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-success) 13%, transparent)',
  },
  '.cm-changedChunk-gutter': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-success) 25%, transparent)',
    borderRight: '3px solid color-mix(in srgb, var(--origin-semantic-success) 65%, transparent)',
  },
  '.cm-insertedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-success) 13%, transparent)',
  },
  '.cm-insertedChunk-gutter': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-success) 25%, transparent)',
    borderRight: '3px solid color-mix(in srgb, var(--origin-semantic-success) 65%, transparent)',
  },
  '.cm-deletedChunkField': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-error) 35%, transparent)',
    borderRadius: '2px',
  },
  '.cm-changedChunkField': {
    backgroundColor: 'color-mix(in srgb, var(--origin-semantic-success) 35%, transparent)',
    borderRadius: '2px',
  },
  '.cm-collapsedLines': {
    backgroundColor: 'var(--origin-bg-hover)',
    color: 'var(--origin-fg-subtle)',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '2px 0',
  },
});

// ── Minimap ────────────────────────────────────────────────────────────────────

/** Construit l'extension minimap ; renvoie `[]` pour la désactiver. */
function minimapExtension(enabled: boolean): Extension {
  if (!enabled) return [];
  return showMinimap.compute(['doc'], () => ({
    create: () => {
      const dom = document.createElement('div');
      return { dom };
    },
    // Rendu « texte réduit » (comme VS Code) : bien plus lisible que des blocs
    // colorés qui, sur du code dense, produisent un bruit visuel illisible.
    displayText: 'characters',
    showOverlay: 'mouse-over',
  }));
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface EditorContext {
  filename: string;
  language: string;
  code: string;
  type: 'selection' | 'viewport';
  startLine: number;
  endLine: number;
}

export interface DiffHunk {
  fromLine: number;
  toLine: number;
}

export interface EditorHandle {
  getEditorContext: () => EditorContext | null;
  showDiff: (newCode: string, originalContent?: string) => void;
  rejectDiff: () => void;
  undo: () => void;
  redo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  openFind: () => void;
  /** Formate le document via le serveur LSP (no-op si indisponible). */
  formatDocument: () => Promise<void>;
  /** Contenu texte actuel de la vue (source de vérité pour le « format on save »). */
  getContent: () => string;
  /** Ouvre l'invite de renommage du symbole sous le curseur (F2). */
  renameSymbol: () => void;
  /** Ouvre le menu des code actions (quick fix) à la position du curseur. */
  showCodeActions: () => void;
  /**
   * Push debug breakpoint + paused-line state into the editor in one atomic
   * transaction. Called by App.tsx whenever DebugContext session changes.
   */
  syncBreakpoints: (lines: number[], pausedLine: number | null) => void;
}

interface Props {
  path: string;
  content: string;
  onChange?: (value: string) => void;
  onCursorChange?: (line: number, col: number) => void;
  initialCursor?: { line: number; col: number };
  jumpTo?: { line: number; col: number; key: number };
  onAddToAiContext?: (ctx: EditorContext) => void;
  onAcceptDiff?: () => void;
  onReady?: () => void;
  // LSP props
  rootPath?: string | null;
  onDefinitionJump?: (filePath: string, line: number, col: number) => void;
  onMissingServer?: (info: MissingServerInfo) => void;
  /**
   * Applique aux **autres** fichiers les éditions d'un WorkspaceEdit LSP
   * (rename / code action) que l'éditeur ne peut pas appliquer lui-même.
   */
  onApplyWorkspaceEdits?: (edits: FileEdits[]) => void;
  /**
   * Incrémenté quand un serveur LSP vient d'être installé : force la recréation
   * de l'extension LSP pour activer la complétion sans action de l'utilisateur.
   */
  lspGeneration?: number;
  // AI inline autocomplete
  getAiCompletion?: AiCompletionFn;
  // DAP debugging
  onToggleBreakpoint?: (filePath: string, line: number) => void;
  /** Minimap (aperçu de la structure du fichier). Activée par défaut. */
  minimap?: boolean;
  /** Sticky scroll (en-têtes de blocs épinglés en haut). Activé par défaut. */
  stickyScroll?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { path, content, onChange, onCursorChange, initialCursor, jumpTo, onAddToAiContext, onAcceptDiff, onReady, rootPath, onDefinitionJump, onMissingServer, onApplyWorkspaceEdits, lspGeneration, getAiCompletion, onToggleBreakpoint, minimap = true, stickyScroll: stickyScrollEnabled = true }, ref
) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const viewRef        = useRef<EditorView | null>(null);
  const onChangeRef    = useRef(onChange);
  onChangeRef.current  = onChange;
  const onCursorRef    = useRef(onCursorChange);
  onCursorRef.current  = onCursorChange;

  // One Compartment per editor instance — lets us swap in/out the merge extension.
  const mergeCompartment = useRef(new Compartment());
  // LSP extensions compartment — reconfigured per file path
  const lspCompartment = useRef(new Compartment());
  // AI autocomplete compartment — first in extensions so its keymap beats indentWithTab
  const autocompleteCompartment = useRef(new Compartment());
  // DAP breakpoint gutter + paused-line highlight compartment
  const dapCompartment = useRef(new Compartment());
  // Gutter « inline diff » git (comparaison avec HEAD)
  const gitCompartment = useRef(new Compartment());
  const conflictCompartment = useRef(new Compartment());
  // Minimap + sticky scroll compartments — togglables sans recréer la vue
  const minimapCompartment = useRef(new Compartment());
  const stickyCompartment = useRef(new Compartment());
  // Stable ref — trigger plugin reads .current so it always calls the latest function
  const getAiCompletionRef = useRef(getAiCompletion);
  getAiCompletionRef.current = getAiCompletion;
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  onToggleBreakpointRef.current = onToggleBreakpoint;
  // Stable ref so the LSP definition callback always sees the current value
  const onDefinitionJumpRef = useRef(onDefinitionJump);
  onDefinitionJumpRef.current = onDefinitionJump;
  const onMissingServerRef = useRef(onMissingServer);
  onMissingServerRef.current = onMissingServer;
  const onApplyWorkspaceEditsRef = useRef(onApplyWorkspaceEdits);
  onApplyWorkspaceEditsRef.current = onApplyWorkspaceEdits;

  // Id du serveur LSP actif pour ce fichier (renseigné par l'effet LSP) — requis
  // par les requêtes ponctuelles : formatage, rename, code actions.
  const lspServerIdRef = useRef<string | null>(null);
  // Commandes LSP appelées depuis la keymap ; stockées en ref pour que la keymap
  // (créée dans l'effet LSP) appelle toujours la version à jour, sans redémarrer
  // le serveur à chaque rendu.
  const lspCommandsRef = useRef({
    rename: () => {}, codeActions: () => {}, format: () => {} } as {
      rename: () => void; codeActions: () => void; format: () => void;
    });

  // Invite de renommage (F2) : plage + position d'origine du symbole.
  const [renameTarget, setRenameTarget] = useState<{ from: number; to: number; initial: string; line: number; character: number } | null>(null);
  // Menu des code actions (Ctrl+.) ancré à une position écran.
  const [codeActionMenu, setCodeActionMenu] = useState<{ items: RawCodeAction[]; x: number; y: number } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Ampoule (lightbulb) : visible quand la ligne du curseur porte un diagnostic,
  // signal qu'un quick fix LSP peut être disponible. Cliquer ouvre les code actions.
  const [showLightbulb, setShowLightbulb] = useState(false);

  // Focus + sélection du texte dès l'ouverture de l'invite de renommage.
  useEffect(() => {
    if (renameTarget && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTarget]);

  // Fermeture du menu code actions au clic extérieur ou sur Échap.
  useEffect(() => {
    if (!codeActionMenu) return;
    function onDown() { setCodeActionMenu(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setCodeActionMenu(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [codeActionMenu]);

  const { showToast } = useToast();
  const { getGrammarForPath, grammars } = useExtensions();

  // Dynamic grammar from an installed extension (Level 1). Recomputed when the
  // set of installed grammars changes so the editor re-configures itself.
  const dynLangCompartment = useRef(new Compartment());
  const dynLang = getGrammarForPath(path);
  const grammarCount = grammars.length;

  // Keep onAcceptDiff prop current so the hunk plugin callback never goes stale.
  const onAcceptDiffRef = useRef(onAcceptDiff);
  onAcceptDiffRef.current = onAcceptDiff;

  // Stable indirection into handleAcceptDiff for createHunkControls.
  const hunkAllResolvedRef = useRef<() => void>(() => {});

  // Diff state
  const [diffPending, setDiffPending] = useState(false);
  const diffOriginalRef = useRef<string>('');

  type CtxMenu = { x: number; y: number; ctx: EditorContext };
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    function onDown() { setContextMenu(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setContextMenu(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useImperativeHandle(ref, () => ({
    getEditorContext(): EditorContext | null {
      const view = viewRef.current;
      if (!view) return null;
      const { state } = view;
      const sel = state.selection.main;
      const filename = path.startsWith('__untitled__')
        ? 'Untitled'
        : (path.split(/[/\\]/).pop() ?? path);
      const language = languageLabel(path);

      if (sel.from !== sel.to) {
        const startLine = state.doc.lineAt(sel.from).number;
        const endLine   = state.doc.lineAt(sel.to).number;
        return { filename, language, code: state.sliceDoc(sel.from, sel.to), type: 'selection', startLine, endLine };
      }

      const visible = view.visibleRanges;
      if (!visible.length) return null;
      const from      = visible[0].from;
      const to        = visible[visible.length - 1].to;
      const startLine = state.doc.lineAt(from).number;
      const endLine   = state.doc.lineAt(to).number;
      return { filename, language, code: state.sliceDoc(from, to), type: 'viewport', startLine, endLine };
    },

    showDiff(newCode: string, originalContent?: string) {
      const view = viewRef.current;
      if (!view) return;

      // Use the explicitly supplied original when the view content may be stale
      // (e.g. file just opened — CodeMirror view was created before content loaded).
      const original = originalContent !== undefined ? originalContent : view.state.doc.toString();
      diffOriginalRef.current = original;

      // Atomically: replace the document + enable the merge extension + per-hunk controls.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newCode },
        effects: mergeCompartment.current.reconfigure([
          unifiedMergeView({
            original,
            highlightChanges: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
            mergeControls: false,
          }),
          createHunkControls(() => hunkAllResolvedRef.current()),
        ]),
      });

      setDiffPending(true);
    },


    rejectDiff() {
      handleRejectDiff();
    },

    undo() { if (viewRef.current) cmUndo(viewRef.current); },
    redo() { if (viewRef.current) cmRedo(viewRef.current); },
    selectAll() { if (viewRef.current) cmSelectAll(viewRef.current); },
    openFind() { if (viewRef.current) openSearchPanel(viewRef.current); },

    formatDocument() { return runFormatDocument(); },
    getContent() { return viewRef.current?.state.doc.toString() ?? ''; },
    renameSymbol() { void triggerRename(); },
    showCodeActions() { void triggerCodeActions(); },

    cut() {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      if (sel.from === sel.to) return;
      navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to))
        .then(() => { view.dispatch(view.state.replaceSelection('')); })
        .catch(() => { showToast('Clipboard write failed', 'error'); });
    },

    copy() {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      if (sel.from === sel.to) return;
      navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to))
        .catch(() => { showToast('Clipboard write failed', 'error'); });
    },

    paste() {
      const view = viewRef.current;
      if (!view) return;
      navigator.clipboard.readText()
        .then(text => { view.dispatch(view.state.replaceSelection(text)); })
        .catch(() => { showToast('Clipboard read failed', 'error'); });
    },

    syncBreakpoints(lines: number[], pausedLine: number | null) {
      const view = viewRef.current;
      if (!view) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous CodeMirror StateEffect list
      const effects: import('@codemirror/state').StateEffect<any>[] = [clearBreakpointsEffect.of(null)];
      for (const line of lines) {
        if (line >= 1 && line <= view.state.doc.lines) {
          effects.push(addBreakpointEffect.of(line));
        }
      }
      effects.push(setPausedLineEffect.of(pausedLine));
      view.dispatch({ effects });
    },
  }));

  function handleAcceptDiff() {
    // Remove merge view, keep the current (modified) document.
    viewRef.current?.dispatch({
      effects: mergeCompartment.current.reconfigure([]),
    });
    setDiffPending(false);
    diffOriginalRef.current = '';
    onAcceptDiffRef.current?.();
  }

  // Keep hunkAllResolvedRef pointing at the latest handleAcceptDiff on every render.
  hunkAllResolvedRef.current = handleAcceptDiff;

  function handleRejectDiff() {
    const view = viewRef.current;
    if (view && diffOriginalRef.current !== '') {
      // Restore original document and remove merge view in one transaction.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: diffOriginalRef.current },
        effects: mergeCompartment.current.reconfigure([]),
      });
    }
    setDiffPending(false);
    diffOriginalRef.current = '';
  }

  // ── LSP : formatage, rename, code actions ───────────────────────────────────

  /** Applique un WorkspaceEdit : la partie « fichier courant » dans la vue,
   *  le reste (autres fichiers) remonté à l'app via `onApplyWorkspaceEdits`. */
  function applyWorkspaceEditLocally(edit: LspWorkspaceEdit): void {
    const view = viewRef.current;
    if (!view) return;
    const files = flattenWorkspaceEdit(edit, uriToPath);
    const mine  = files.find(f => f.path === path);
    if (mine) {
      const text = view.state.doc.toString();
      const changes = mine.edits
        .map(e => ({
          from: lspPosToOffset(text, e.range.start),
          to:   lspPosToOffset(text, e.range.end),
          insert: e.newText,
        }))
        .sort((a, b) => b.from - a.from);
      view.dispatch({ changes });
    }
    const others = files.filter(f => f.path !== path);
    if (others.length) onApplyWorkspaceEditsRef.current?.(others);
  }

  /** Formate le document entier via le serveur LSP. */
  async function runFormatDocument(): Promise<void> {
    const view = viewRef.current;
    const serverId = lspServerIdRef.current;
    if (!view || !serverId) return;
    try {
      const edits = await lspFormatDocument(serverId, path, {
        tabSize: view.state.tabSize,
        insertSpaces: true,
      });
      if (!edits || edits.length === 0) return;
      const text = view.state.doc.toString();
      const changes = edits
        .map(e => ({
          from: lspPosToOffset(text, e.range.start),
          to:   lspPosToOffset(text, e.range.end),
          insert: e.newText,
        }))
        .sort((a, b) => b.from - a.from);
      view.dispatch({ changes });
    } catch (err) {
      showToast(`Format failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Ouvre l'invite de renommage (F2) si le symbole sous le curseur est renommable. */
  async function triggerRename(): Promise<void> {
    const view = viewRef.current;
    const serverId = lspServerIdRef.current;
    if (!view || !serverId) return;
    const pos  = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const position = { line: line.number - 1, character: pos - line.from };
    try {
      const prep = await lspPrepareRename(serverId, path, position);
      if (!prep) { showToast('Nothing to rename here', 'info'); return; }
      const text = view.state.doc.toString();
      setRenameTarget({
        from: lspPosToOffset(text, prep.range.start),
        to:   lspPosToOffset(text, prep.range.end),
        initial: prep.placeholder,
        line: position.line,
        character: position.character,
      });
    } catch (err) {
      showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Confirme le renommage et applique l'édition (multi-fichiers). */
  async function confirmRename(newName: string): Promise<void> {
    const serverId = lspServerIdRef.current;
    const target = renameTarget;
    setRenameTarget(null);
    viewRef.current?.focus();
    if (!serverId || !target || !newName || newName === target.initial) return;
    try {
      const edit = await lspRename(serverId, path, { line: target.line, character: target.character }, newName);
      if (edit) applyWorkspaceEditLocally(edit);
    } catch (err) {
      showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Récupère les code actions disponibles à la sélection courante. */
  async function fetchCodeActions(view: EditorView, serverId: string): Promise<RawCodeAction[]> {
    const sel  = view.state.selection.main;
    const text = view.state.doc.toString();
    const range = { start: offsetToLspPos(text, sel.from), end: offsetToLspPos(text, sel.to) };
    // Les diagnostics (state lint) alimentent la requête : le serveur s'en sert
    // pour proposer des « quick fix » pertinents.
    const diagnostics: unknown[] = [];
    forEachDiagnostic(view.state, (d, from, to) => {
      diagnostics.push({
        range: { start: offsetToLspPos(text, from), end: offsetToLspPos(text, to) },
        severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : d.severity === 'info' ? 3 : 4,
        message: d.message,
        source: d.source,
        code: d.source,
      });
    });
    try {
      return await lspCodeActions(serverId, path, range, diagnostics);
    } catch {
      return [];
    }
  }

  /** Ouvre le menu des code actions (Ctrl+.) à la position du curseur. */
  async function triggerCodeActions(): Promise<void> {
    const view = viewRef.current;
    const serverId = lspServerIdRef.current;
    if (!view || !serverId) return;
    const items = await fetchCodeActions(view, serverId);
    if (items.length === 0) { showToast('No code actions available', 'info'); return; }
    // Actions « preferred » (quick fixes prioritaires) en tête.
    items.sort((a, b) => Number(!!b.isPreferred) - Number(!!a.isPreferred));
    const coords = view.coordsAtPos(view.state.selection.main.head);
    setCodeActionMenu({ items, x: coords?.left ?? 120, y: (coords?.bottom ?? 80) + 4 });
  }

  /** Applique la code action choisie (edit + éventuelle commande serveur). */
  async function applyCodeAction(raw: RawCodeAction): Promise<void> {
    setCodeActionMenu(null);
    viewRef.current?.focus();
    const serverId = lspServerIdRef.current;
    if (raw.edit) applyWorkspaceEditLocally(raw.edit);
    if (raw.command) {
      const cmd  = typeof raw.command === 'string' ? raw.command : raw.command.command;
      const args = typeof raw.command === 'string' ? (raw.arguments ?? []) : (raw.command.arguments ?? []);
      if (serverId && cmd) {
        try { await lspExecuteCommand(serverId, cmd, args); }
        catch { /* la commande serveur a échoué : l'édition éventuelle est déjà appliquée */ }
      }
    }
  }

  // Garde lspCommandsRef pointé sur les dernières implémentations (sans relancer
  // l'effet LSP à chaque rendu).
  useEffect(() => {
    lspCommandsRef.current = {
      rename: () => { void triggerRename(); },
      codeActions: () => { void triggerCodeActions(); },
      format: () => { void runFormatDocument(); },
    };
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        // Must be first so ghostKeymap wins the Tab key race over indentWithTab.
        autocompleteCompartment.current.of(
          getAiCompletion ? createAiAutocompleteExtension(getAiCompletionRef) : []
        ),
        lineNumbers(),
        codeFolding(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        history(),
        syntaxHighlighting(originHighlight),
        search({ top: false }),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab, ...searchKeymap,
          // Raccourcis LSP — priorité au-dessus des défauts ci-dessus. Les commandes
          // passent par lspCommandsRef pour rester à jour sans recréer la vue.
          { key: 'F2',          run: () => { lspCommandsRef.current.rename();      return true; } },
          { key: 'Mod-.',       run: () => { lspCommandsRef.current.codeActions(); return true; } },
          { key: 'Shift-Alt-f', run: () => { lspCommandsRef.current.format();      return true; } },
        ]),
        getLanguageExtension(path),
        dynLangCompartment.current.of(dynLang ?? []),
        mergeCompartment.current.of([]),
        lspCompartment.current.of([]),
        dapCompartment.current.of([]),
        gitCompartment.current.of([]),
        conflictCompartment.current.of([]),
        minimapCompartment.current.of(minimapExtension(minimap)),
        stickyCompartment.current.of(stickyScrollEnabled ? stickyScroll() : []),
        originBaseTheme,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            const pos  = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            onCursorRef.current?.(line.number, pos - line.from + 1);
          }
          // Ampoule : vrai si la ligne du curseur porte au moins un diagnostic.
          const curLine = update.state.doc.lineAt(update.state.selection.main.head).number;
          let onDiagLine = false;
          forEachDiagnostic(update.state, (_d, from) => {
            if (update.state.doc.lineAt(from).number === curLine) onDiagLine = true;
          });
          setShowLightbulb(onDiagLine);
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    // Signal the parent that the imperative handle is now usable.
    // useImperativeHandle runs before useEffect, so editorRef.current is already set.
    onReady?.();

    // Restore cursor position from previous visit to this file
    if (initialCursor && (initialCursor.line > 1 || initialCursor.col > 1)) {
      const doc     = view.state.doc;
      const lineNum = Math.min(Math.max(1, initialCursor.line), doc.lines);
      const line    = doc.line(lineNum);
      const ch      = Math.max(0, Math.min(initialCursor.col - 1, line.length));
      view.dispatch({ selection: { anchor: line.from + ch }, scrollIntoView: true });
    }

    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
      setDiffPending(false);
      diffOriginalRef.current = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply extension-provided grammars as they finish loading, without recreating
  // the whole editor view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: dynLangCompartment.current.reconfigure(getGrammarForPath(path) ?? []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grammarCount, path]);

  // Jump to line when triggered from search results
  useEffect(() => {
    const view = viewRef.current;
    if (!jumpTo || !view) return;
    const doc     = view.state.doc;
    const lineNum = Math.min(Math.max(1, jumpTo.line), doc.lines);
    const line    = doc.line(lineNum);
    const ch      = Math.max(0, Math.min((jumpTo.col ?? 1) - 1, line.length));
    view.dispatch({ selection: { anchor: line.from + ch }, scrollIntoView: true });
    view.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.key]);

  // LSP session — install extensions when a supported file is open in a workspace.
  // Le serveur est résolu depuis la config (workspace > global), ce qui permet
  // d'ajouter n'importe quel serveur de l'allowlist sans toucher au code.
  useEffect(() => {
    if (!rootPath || path.startsWith('__')) return;
    if (!isLspSupported(path)) return;

    let cancelled = false;
    (async () => {
      let serverId: string;
      let args: string[] | undefined;
      let serverPath: string | undefined;
      try {
        const config = await resolveLspConfig(rootPath);
        const resolved = findServerForFile(config, path);
        if (!resolved) return;
        serverId = resolved.serverId;
        args = resolved.config.args;
        serverPath = resolved.config.serverPath;
      } catch {
        return;
      }
      if (cancelled) return;
      lspServerIdRef.current = serverId;

      const exts = await createLspExtension({
        filePath: path,
        rootPath,
        serverId,
        args,
        serverPath,
        onDefinitionJump: (fp, ln, col) => onDefinitionJumpRef.current?.(fp, ln, col),
        onMissingServer: info => onMissingServerRef.current?.(info),
      });
      if (cancelled) return;
      const v = viewRef.current;
      if (v) v.dispatch({ effects: lspCompartment.current.reconfigure(exts) });
    })();

    return () => {
      cancelled = true;
      lspServerIdRef.current = null;
      const v = viewRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- lspCompartment is a stable ref, never reassigned
      if (v) v.dispatch({ effects: lspCompartment.current.reconfigure([]) });
    };
  }, [path, rootPath, lspGeneration]);

  // DAP breakpoint gutter — install/teardown per file path
  useEffect(() => {
    if (path.startsWith('__')) return;
    const view = viewRef.current;
    if (!view) return;
    const exts = createDapExtension({
      filePath: path,
      onToggleBreakpoint: (line) => onToggleBreakpointRef.current?.(path, line),
    });
    view.dispatch({ effects: dapCompartment.current.reconfigure(exts) });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- dapCompartment is a stable ref, never reassigned
      viewRef.current?.dispatch({ effects: dapCompartment.current.reconfigure([]) });
    };
  }, [path]);

  // Gutter « inline diff » git — compare le tampon courant au contenu à HEAD.
  // La référence est rechargée au changement de fichier et à chaque opération
  // git (commit, checkout…) signalée par `onGitChanged`.
  useEffect(() => {
    if (!rootPath || path.startsWith('__')) return;
    const view = viewRef.current;
    if (!view) return;
    const root = rootPath;
    const rel = relativeToRoot(root, path);
    if (rel === null) return;
    const relPath: string = rel;

    const gitComp = gitCompartment.current;
    const conflictComp = conflictCompartment.current;
    view.dispatch({ effects: gitComp.reconfigure(createGitGutter()) });

    // Résolveur de conflits de merge : actif uniquement sur les fichiers de
    // travail (pas les onglets virtuels). Les boutons n'apparaissent que si des
    // marqueurs `<<<<<<<` sont présents dans le document.
    view.dispatch({ effects: conflictComp.reconfigure(createConflictResolver()) });

    let cancelled = false;
    async function loadBaseline() {
      const res = await gitFileHead(root, relPath);
      if (cancelled) return;
      const v = viewRef.current;
      if (!v) return;
      const baseline =
        res.status === 'tracked' ? res.content
        : res.status === 'untracked' ? ''
        : null;
      v.dispatch({ effects: setGitBaselineEffect.of(baseline) });
    }
    void loadBaseline();
    const off = onGitChanged(() => { void loadBaseline(); });

    return () => {
      cancelled = true;
      off();
      viewRef.current?.dispatch({ effects: gitComp.reconfigure([]) });
      viewRef.current?.dispatch({ effects: conflictComp.reconfigure([]) });
    };
  }, [path, rootPath]);

  // Reconfigure autocomplete compartment when the prop goes from undefined ↔ function.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: autocompleteCompartment.current.reconfigure(
        getAiCompletion ? createAiAutocompleteExtension(getAiCompletionRef) : []
      ),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!getAiCompletion]);

  function handleContextMenu(e: React.MouseEvent) {
    if (!onAddToAiContext) return;
    const view = viewRef.current;
    if (!view) return;
    const { state } = view;
    const sel = state.selection.main;
    if (sel.from === sel.to) return;
    e.preventDefault();
    const filename  = path.startsWith('__untitled__') ? 'Untitled' : (path.split(/[/\\]/).pop() ?? path);
    const startLine = state.doc.lineAt(sel.from).number;
    const endLine   = state.doc.lineAt(sel.to).number;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      ctx: { filename, language: languageLabel(path), code: state.sliceDoc(sel.from, sel.to), type: 'selection', startLine, endLine },
    });
  }

  return (
    <>
      <div
        ref={containerRef}
        onContextMenu={handleContextMenu}
        style={{ flex: 1, overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}
      >
        {/* Accept / Reject overlay — shown while a diff is pending */}
        {diffPending && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              zIndex: 50,
              backgroundColor: 'var(--origin-bg-base)',
              border: '1px solid var(--origin-border-default)',
              borderRadius: 7,
              padding: '4px 6px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              fontSize: '11px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <span style={{
              padding: '2px 8px',
              borderRadius: 4,
              backgroundColor: 'var(--origin-fg-default)',
              color: 'var(--origin-bg-base)',
              fontWeight: 600,
              letterSpacing: '0.01em',
              userSelect: 'none',
            }}>
              Review changes
            </span>
            <button
              onClick={handleAcceptDiff}
              style={{
                padding: '3px 11px',
                borderRadius: 5,
                border: 'none',
                backgroundColor: 'var(--origin-semantic-success)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '11px',
                fontFamily: 'var(--font-sans)',
                fontWeight: 500,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'color-mix(in srgb, var(--origin-semantic-success) 80%, white)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--origin-semantic-success)'; }}
            >
              Accept All
            </button>
            <button
              onClick={handleRejectDiff}
              style={{
                padding: '3px 11px',
                borderRadius: 5,
                border: 'none',
                backgroundColor: 'var(--origin-semantic-error)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '11px',
                fontFamily: 'var(--font-sans)',
                fontWeight: 500,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'color-mix(in srgb, var(--origin-semantic-error) 80%, white)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--origin-semantic-error)'; }}
            >
              Reject All
            </button>
          </div>
        )}

        {/* Ampoule (lightbulb) — quick fix LSP disponible sur la ligne courante */}
        {showLightbulb && !diffPending && (
          <button
            onClick={() => { void triggerCodeActions(); }}
            title="Code actions (Ctrl+.)"
            style={{
              position: 'absolute',
              top: 6,
              right: 12,
              zIndex: 55,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: 5,
              border: '1px solid var(--origin-border-default)',
              backgroundColor: 'var(--origin-bg-base)',
              color: 'var(--origin-accent-blue)',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--origin-bg-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--origin-bg-base)'; }}
          >
            <Lightbulb size={14} />
          </button>
        )}

        {/* Invite de renommage (F2) — input flottant ancré en haut de la vue */}
        {renameTarget && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 60,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              backgroundColor: 'var(--origin-bg-base)',
              border: '1px solid var(--origin-border-default)',
              borderRadius: 7,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)', userSelect: 'none' }}>
              Rename symbol
            </span>
            <input
              ref={renameInputRef}
              defaultValue={renameTarget.initial}
              spellCheck={false}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void confirmRename((e.target as HTMLInputElement).value);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenameTarget(null);
                  viewRef.current?.focus();
                }
              }}
              onBlur={e => { void confirmRename(e.target.value); }}
              style={{
                background: 'var(--origin-bg-input)',
                border: '1px solid var(--origin-border-default)',
                borderRadius: 5,
                color: 'var(--origin-fg-default)',
                padding: '3px 7px',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
                minWidth: '160px',
              }}
            />
          </div>
        )}
      </div>

      {codeActionMenu && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: codeActionMenu.y,
            left: codeActionMenu.x,
            minWidth: '220px',
            maxWidth: '420px',
            background: 'color-mix(in srgb, var(--origin-bg-base) 85%, transparent)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--origin-border-default)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            padding: '4px',
            zIndex: 9999,
          }}
        >
          {codeActionMenu.items.map((item, i) => (
            <button
              key={`${item.title ?? 'action'}-${i}`}
              onClick={() => { void applyCodeAction(item); }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 10px',
                borderRadius: '5px',
                border: 'none',
                cursor: 'pointer',
                background: 'transparent',
                textAlign: 'left',
                fontSize: '12px',
                color: 'var(--origin-fg-default)',
                fontFamily: 'var(--font-sans)',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {item.isPreferred && (
                <span style={{ color: 'var(--origin-accent-blue)', fontSize: '11px' }}>✦</span>
              )}
              <span style={{ flex: 1 }}>{item.title ?? 'Code action'}</span>
              {item.kind && (
                <span style={{ fontSize: '10px', color: 'var(--origin-fg-subtle)' }}>
                  {item.kind.split('.').pop()}
                </span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {contextMenu && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            minWidth: '200px',
            background: 'color-mix(in srgb, var(--origin-bg-base) 85%, transparent)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--origin-border-default)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            padding: '4px',
            zIndex: 9999,
          }}
        >
          <button
            onClick={() => {
              onAddToAiContext?.(contextMenu.ctx);
              setContextMenu(null);
            }}
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              padding: '7px 10px',
              borderRadius: '5px',
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
              textAlign: 'left',
              gap: '2px',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span style={{ fontSize: '13px', color: 'var(--origin-fg-default)' }}>
              Ask AI about this
            </span>
            <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>
              L{contextMenu.ctx.startLine}–{contextMenu.ctx.endLine} · {contextMenu.ctx.filename}
            </span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
});

export default Editor;
