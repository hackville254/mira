import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, File, Terminal, FolderOpen, FilePlus, PanelLeft,
  FileInput, Sun, Moon, Settings, Loader, AlignLeft, Puzzle, FileText,
} from 'lucide-react';
import { readDir, type FsEntry } from '../../lib/fs';
import { fileColor } from '../../lib/fileColors';
import { searchInFiles, type SearchMatch } from '../../lib/search';
import { useTheme } from '../../themes/ThemeContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import {
  subscribe as subscribeRegistry,
  getCommands as getRegisteredCommands,
  executeCommand,
} from '../../lib/extensions/registry';
import {
  subscribe as subscribeRuntime,
  getCommands as getRuntimeCommands,
  runCommand as runRuntimeCommand,
  type RuntimeCommand,
} from '../../lib/commands/registry';
import {
  subscribe as subscribeI18n,
  ensureExtensionI18n,
  getRevision as getI18nRevision,
  getI18nTable,
  resolveNlsText,
} from '../../lib/extensions/i18n';
import { getEffectiveKey } from '../../lib/keybindings';
import { formatShortcut } from '../../lib/platform';
import type { OutlineSymbol } from '../../lib/outline';
import type { Tab } from '../editor/TabBar';

// ── workspace walker ─────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'target', '.next', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.turbo', 'coverage',
  '.nuxt', 'out', '.parcel-cache', '.svelte-kit',
]);

interface WorkspaceFile { name: string; path: string; rel: string; }

async function walkDir(
  dir: string, base: string, depth: number, acc: WorkspaceFile[],
): Promise<void> {
  if (depth > 5) return;
  let entries: FsEntry[];
  try { entries = await readDir(dir); } catch { return; }
  await Promise.all(entries.map(e => {
    if (IGNORE_DIRS.has(e.name)) return;
    if (e.is_dir) return walkDir(e.path, base, depth + 1, acc);
    const rel = e.path.startsWith(base)
      ? e.path.slice(base.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
      : e.path;
    acc.push({ name: e.name, path: e.path, rel });
  }));
}

// ── fuzzy ────────────────────────────────────────────────────────────────────

function fuzzyScore(q: string, target: string): number | null {
  if (!q) return 0;
  const ql = q.toLowerCase(), tl = target.toLowerCase();
  const idx = tl.indexOf(ql);
  if (idx !== -1) return idx;
  let qi = 0, score = 0;
  for (let i = 0; i < tl.length && qi < ql.length; i++) {
    if (tl[i] === ql[qi]) { score += i; qi++; }
  }
  return qi === ql.length ? score + 1000 : null;
}

// ── types ────────────────────────────────────────────────────────────────────

type ItemKind = 'open-file' | 'workspace-file' | 'command' | 'text-match';
interface PaletteItem {
  id: string; kind: ItemKind; label: string; detail?: string;
  icon: React.ReactNode; badge?: React.ReactNode;
  shortcut?: string; score: number; action: () => void;
}

// ── props ────────────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  tabs: Tab[];
  activeTab: string | null;
  onFileOpen: (path: string) => void;
  onFileOpenAtLine: (path: string, line: number) => void;
  onClose: () => void;
  onNewFile: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onOpenMarkdownPreview: (path: string) => void;
  terminalOpen: boolean;
  sidebarOpen: boolean;
  /** Mode d'ouverture : quick open fichiers, palette de commandes, ligne ou symbole. */
  openMode?: 'quickopen' | 'command' | 'line' | 'symbol';
  /** Symboles du fichier actif (mode « Go to Symbol »). */
  symbols?: OutlineSymbol[];
  /** Va à une position (mode « Go to Line »). */
  onGoToLine?: (line: number, col: number) => void;
  /** Va à un symbole (mode « Go to Symbol »). */
  onGoToSymbol?: (line: number) => void;
}

// ── component ────────────────────────────────────────────────────────────────

// Largeur du panneau, alignée sur VS Code (min 600px, ~40 % de la fenêtre).
const PALETTE_W = 600;
// Préfixe canonique de la Command Palette (VS Code : « > » pour les commandes).
const CMD_PREFIX = '>';

export default function CommandPalette({
  tabs, activeTab, onFileOpen, onFileOpenAtLine, onClose,
  onNewFile, onOpenFolder, onOpenFile,
  onToggleSidebar, onToggleTerminal, onOpenSettings,
  onOpenMarkdownPreview,
  terminalOpen, sidebarOpen,
  openMode = 'command', symbols, onGoToLine, onGoToSymbol,
}: CommandPaletteProps) {
  const { folderPath } = useWorkspace();
  const { theme, themes, setTheme } = useTheme();
  // En mode « command », la palette démarre avec le préfixe « > » (comme VS Code
  // via Cmd/Ctrl+Shift+P). En mode fichier rapide (Cmd/Ctrl+P), champ vide.
  const [query, setQuery] = useState(
    openMode === 'line' ? ':' : openMode === 'symbol' ? '#' : openMode === 'command' ? `${CMD_PREFIX} ` : '',
  );
  const [selected, setSelected] = useState(0);
  const [wsFiles, setWsFiles] = useState<WorkspaceFile[]>([]);
  const [textResults, setTextResults] = useState<SearchMatch[]>([]);
  const [textLoading, setTextLoading] = useState(false);

  // Commandes contribuées à l'exécution par les extensions (niveau 2).
  const extensionCommands = useSyncExternalStore(subscribeRegistry, getRegisteredCommands, getRegisteredCommands);
  // Commandes du cœur de l'IDE (registry runtime peuplée par App).
  const runtimeCommands = useSyncExternalStore(subscribeRuntime, getRuntimeCommands, getRuntimeCommands);
  // Version incrémentale des tables de traduction d'extension : re-rend la palette
  // dès qu'une table `package.nls.json` finit de charger (titres dé-placeholderisés).
  const i18nVersion = useSyncExternalStore(subscribeI18n, getI18nRevision, getI18nRevision);

  // Index `id de commande d'extension → titre résolu`. Dépend de `i18nVersion`
  // (recalculé au chargement des tables) et de la liste des commandes d'extension.
  const extTitles = useMemo(() => {
    void i18nVersion;
    const map = new Map<string, string>();
    for (const ext of extensionCommands) {
      const table = getI18nTable(ext.extensionId ?? '');
      const title = resolveNlsText(ext.title, table) || ext.title.replace(/%/g, '');
      map.set(ext.id, title);
    }
    return map;
  }, [extensionCommands, i18nVersion]);

  const inputRef   = useRef<HTMLInputElement>(null);
  const listRef    = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  // Walk workspace once for file search
  useEffect(() => {
    if (!folderPath) return;
    const acc: WorkspaceFile[] = [];
    walkDir(folderPath, folderPath, 0, acc).then(() => setWsFiles(acc));
  }, [folderPath]);

  // Text search — fires when query starts with '%'
  useEffect(() => {
    const isTextMode = query.startsWith('%');
    if (!isTextMode || !folderPath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard reset when not in text-search mode
      setTextResults([]);
      setTextLoading(false);
      return;
    }
    const textQuery = query.slice(1).trim();
    if (!textQuery) {
      setTextResults([]);
      setTextLoading(false);
      return;
    }
    setTextLoading(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchInFiles(folderPath, textQuery);
        setTextResults(results);
      } catch {
        setTextResults([]);
      } finally {
        setTextLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, folderPath]);

  // Auto-focus input
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Charge les tables de traduction des extensions qui contribuent des commandes
  // (titres `%key%`). Idempotent et best-effort : la palette reste utilisable.
  useEffect(() => {
    for (const ext of extensionCommands) {
      if (ext.extensionId) void ensureExtensionI18n(ext.extensionId);
    }
  }, [extensionCommands]);

  const isTextMode   = query.startsWith('%');
  const isFileMode   = query.startsWith('@');
  const isLineMode   = query.startsWith(':');
  const isSymbolMode = query.startsWith('#');
  // Préfixe « > » : commandes uniquement (comportement VS Code au Cmd/Ctrl+Shift+P).
  const isCmdPrefix  = query.startsWith(CMD_PREFIX) && !isTextMode && !isFileMode && !isLineMode && !isSymbolMode;
  // Mode « fichier rapide » : pas de préfixe spécial ni « > » → Cmd/Ctrl+P.
  const isQuickOpen  = !isTextMode && !isFileMode && !isLineMode && !isSymbolMode && !isCmdPrefix;

  const q          = (isTextMode || isFileMode || isLineMode || isSymbolMode) ? '' : query.trim();
  const cmdQuery   = isCmdPrefix ? query.slice(1).trim() : '';
  const textQuery  = isTextMode ? query.slice(1).trim() : '';
  const fileQuery  = isFileMode ? query.slice(1).trim() : '';
  const lineQuery  = isLineMode ? query.slice(1).trim() : '';
  const symbolQuery = isSymbolMode ? query.slice(1).trim() : '';

  // Résultats « fichier rapide » : onglets ouverts + fichiers du workspace.
  const quickOpenItems = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];
    const openPaths = new Set(tabs.map(t => t.path));
    for (const tab of tabs) {
      const score = fuzzyScore(q, tab.name);
      if (score === null) continue;
      const rel = folderPath && tab.path.startsWith(folderPath)
        ? tab.path.slice(folderPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/') : tab.path;
      result.push({
        id: `open:${tab.path}`, kind: 'open-file', label: tab.name, detail: rel,
        icon: <File size={14} style={{ color: fileColor(tab.name), flexShrink: 0 }} />,
        badge: <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--origin-accent-blue)', flexShrink: 0 }} />,
        score: score - 20000,
        action: () => { onFileOpen(tab.path); onClose(); },
      });
    }
    for (const f of wsFiles) {
      if (openPaths.has(f.path)) continue;
      const score = fuzzyScore(q, f.name);
      if (score === null) continue;
      result.push({
        id: `ws:${f.path}`, kind: 'workspace-file', label: f.name, detail: f.rel,
        icon: <File size={14} style={{ color: fileColor(f.name), flexShrink: 0 }} />,
        score,
        action: () => { onFileOpen(f.path); onClose(); },
      });
    }
    result.sort((a, b) => a.score - b.score);
    return result.slice(0, 60);
  }, [q, tabs, wsFiles, folderPath, onFileOpen, onClose]);

  const fileItems = useMemo<PaletteItem[]>(() => {
    if (!isFileMode) return [];
    const result: PaletteItem[] = [];
    const openPaths = new Set(tabs.map(t => t.path));
    for (const tab of tabs) {
      const score = fuzzyScore(fileQuery, tab.name);
      if (score === null) continue;
      const rel = folderPath && tab.path.startsWith(folderPath)
        ? tab.path.slice(folderPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/') : tab.path;
      result.push({
        id: `open:${tab.path}`, kind: 'open-file', label: tab.name, detail: rel,
        icon: <File size={14} style={{ color: fileColor(tab.name), flexShrink: 0 }} />,
        badge: <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--origin-accent-blue)', flexShrink: 0 }} />,
        score: score - 20000,
        action: () => { onFileOpen(tab.path); onClose(); },
      });
    }
    for (const f of wsFiles) {
      if (openPaths.has(f.path)) continue;
      const score = fuzzyScore(fileQuery, f.name);
      if (score === null) continue;
      result.push({
        id: `ws:${f.path}`, kind: 'workspace-file', label: f.name, detail: f.rel,
        icon: <File size={14} style={{ color: fileColor(f.name), flexShrink: 0 }} />,
        score,
        action: () => { onFileOpen(f.path); onClose(); },
      });
    }
    result.sort((a, b) => a.score - b.score);
    return result.slice(0, 60);
  }, [isFileMode, fileQuery, tabs, wsFiles, folderPath, onFileOpen, onClose]);

  // Go to Line — un unique résultat calculé depuis la saisie (accepte « 12:5 »).
  const lineItems = useMemo<PaletteItem[]>(() => {
    if (!isLineMode || !onGoToLine) return [];
    const m = /^(\d+)(?::(\d+))?$/.exec(lineQuery);
    if (!m) return [];
    const line = parseInt(m[1], 10);
    const col = m[2] ? parseInt(m[2], 10) : 0;
    return [{
      id: 'goto:line',
      kind: 'command',
      label: `Go to Line ${line}${col ? `, Column ${col}` : ''}`,
      detail: 'Line/Column',
      icon: <AlignLeft size={14} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />,
      score: 0,
      action: () => { onGoToLine(line, col); onClose(); },
    }];
  }, [isLineMode, lineQuery, onGoToLine, onClose]);

  // Go to Symbol — aplatit l'arbre de symboles du fichier actif.
  const symbolItems = useMemo<PaletteItem[]>(() => {
    if (!isSymbolMode || !onGoToSymbol) return [];
    const flat: { sym: OutlineSymbol; depth: number }[] = [];
    const walk = (list: OutlineSymbol[], depth: number) => {
      for (const s of list) { flat.push({ sym: s, depth }); if (s.children?.length) walk(s.children, depth + 1); }
    };
    walk(symbols ?? [], 0);
    const result: PaletteItem[] = [];
    for (const { sym, depth } of flat) {
      const score = fuzzyScore(symbolQuery, sym.name);
      if (score === null) continue;
      result.push({
        id: `sym:${sym.line}:${sym.name}`,
        kind: 'command',
        label: `${'  '.repeat(depth)}${sym.name}`,
        detail: sym.detail ?? sym.kind,
        icon: <AlignLeft size={14} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />,
        badge: <span style={{ fontSize: '10px', color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>{sym.kind}</span>,
        score,
        action: () => { onGoToSymbol(sym.line); onClose(); },
      });
    }
    result.sort((a, b) => a.score - b.score);
    return result.slice(0, 100);
  }, [isSymbolMode, symbolQuery, symbols, onGoToSymbol, onClose]);

  // Commandes (préfixe « > ») : cœur IDE (runtime) + extensions + actions de base.
  const commandItems = useMemo<PaletteItem[]>(() => {
    if (!isCmdPrefix) return [];
    const result: PaletteItem[] = [];
    const activeIsMarkdown =
      !!activeTab && !activeTab.startsWith('__') && /\.(md|mdx)$/i.test(activeTab);
    const cmds = [
      ...(activeIsMarkdown ? [{
        label: 'Open Markdown Preview',
        tokens: 'markdown preview md render',
        detail: 'Render the active Markdown file in a preview tab',
        icon: <FileText size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />,
        shortcut: undefined as string | undefined,
        action: () => { onOpenMarkdownPreview(activeTab!); onClose(); },
      }] : []),
      { label: 'New File',       tokens: 'new create untitled',        detail: 'Create a new untitled file',       icon: <FilePlus  size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+n'), action: () => { onNewFile(); onClose(); } },
      { label: 'Open Folder…',   tokens: 'open folder workspace',       detail: 'Open a project folder',            icon: <FolderOpen size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+k o'), action: () => { onOpenFolder(); onClose(); } },
      { label: 'Open File…',     tokens: 'open file browse disk',       detail: 'Open a file from disk',            icon: <FileInput  size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+o'), action: () => { onOpenFile(); onClose(); } },
      { label: 'Open Settings',  tokens: 'settings preferences config', detail: 'Manage API keys, themes and more', icon: <Settings   size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+,'), action: () => { onOpenSettings(); onClose(); } },
      { label: terminalOpen ? 'Hide Terminal' : 'Show Terminal', tokens: 'terminal toggle panel', detail: terminalOpen ? 'Close the terminal panel' : 'Open the terminal panel', icon: <Terminal size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+`'), action: () => { onToggleTerminal(); onClose(); } },
      { label: sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar', tokens: 'sidebar toggle explorer', detail: sidebarOpen ? 'Close the file explorer' : 'Open the file explorer', icon: <PanelLeft size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />, shortcut: formatShortcut('ctrl+b'), action: () => { onToggleSidebar(); onClose(); } },
      ...themes.filter(t => t.name !== theme.name).map(t => ({
        label: `Switch to ${t.name}`,
        tokens: `theme color ${t.type} appearance`,
        detail: `Change the IDE color theme`,
        icon: t.type === 'dark'
          ? <Moon size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />
          : <Sun  size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />,
        shortcut: undefined as string | undefined,
        action: () => { setTheme(t); onClose(); },
      })),
    ];
    for (const cmd of cmds) {
      const score = fuzzyScore(cmdQuery, cmd.label + ' ' + cmd.tokens);
      if (score === null) continue;
      result.push({ id: `cmd:${cmd.label}`, kind: 'command', label: cmd.label, detail: cmd.detail, icon: cmd.icon, shortcut: cmd.shortcut, score: score + 50000, action: cmd.action });
    }

    // Commandes du cœur IDE (registry runtime peuplée par App). Priorité la
    // plus haute : ce sont les actions VS Code natives de l'éditeur.
    for (const cmd of runtimeCommands as RuntimeCommand[]) {
      if (cmd.enabled === false) continue;
      const haystack = `${cmd.title} ${cmd.category} ${cmd.keywords ?? ''} ${cmd.id}`;
      const score = fuzzyScore(cmdQuery, haystack);
      if (score === null) continue;
      const shortcut = formatShortcut(getEffectiveKey(cmd.id)) || undefined;
      result.push({
        id: `rt-cmd:${cmd.id}`,
        kind: 'command',
        label: cmd.title,
        detail: cmd.category,
        icon: <Settings size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />,
        shortcut,
        score: score + 60000,
        action: () => { void runRuntimeCommand(cmd.id); onClose(); },
      });
    }

    // Commandes d'extension (niveau 2).
    for (const ext of extensionCommands) {
      // Titre déjà résolu (`%key%` → texte) via `extTitles` ; repli sur l'id.
      const title = extTitles.get(ext.id) ?? ext.title.replace(/%/g, '');
      const category = ext.category ?? '';
      const haystack = `${title} ${category} ${ext.id}`;
      const score = fuzzyScore(cmdQuery, haystack);
      if (score === null) continue;
      result.push({
        id: `ext-cmd:${ext.id}`,
        kind: 'command',
        label: title,
        detail: category,
        icon: <Puzzle size={14} style={{ flexShrink: 0, color: 'var(--origin-accent-blue)' }} />,
        badge: <span style={{ fontSize: '10px', color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>extension</span>,
        score: score + 20000,
        action: () => {
          void executeCommand(ext.id).catch((err: unknown) => {
            console.error(`[extension] command "${ext.id}" failed:`, err);
          });
          onClose();
        },
      });
    }

    result.sort((a, b) => a.score - b.score);
    return result.slice(0, 200);
  }, [isCmdPrefix, cmdQuery, terminalOpen, sidebarOpen, theme, themes, setTheme, extensionCommands, extTitles, runtimeCommands,
      onClose, onNewFile, onOpenFolder, onOpenFile, onToggleSidebar, onToggleTerminal, onOpenSettings,
      activeTab, onOpenMarkdownPreview]);

  const textItems = useMemo<PaletteItem[]>(() =>
    textResults.map(r => {
      const fileName = r.path.replace(/\\/g, '/').split('/').pop() ?? r.path;
      return {
        id: `text:${r.path}:${r.line}:${r.col}`,
        kind: 'text-match' as ItemKind,
        label: r.text,
        detail: `${fileName} · Line ${r.line}`,
        icon: <AlignLeft size={14} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />,
        score: 0,
        action: () => { onFileOpenAtLine(r.path, r.line); onClose(); },
      };
    }),
  [textResults, onFileOpenAtLine, onClose]);

  // Liste plate unique (VS Code n'affiche pas de groupes dans la palette).
  const flat = useMemo<PaletteItem[]>(
    () => isTextMode ? textItems
      : isFileMode ? fileItems
      : isLineMode ? lineItems
      : isSymbolMode ? symbolItems
      : isCmdPrefix ? commandItems
      : quickOpenItems,
    [isTextMode, isFileMode, isLineMode, isSymbolMode, isCmdPrefix, textItems, fileItems, lineItems, symbolItems, commandItems, quickOpenItems],
  );

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset selection to top whenever the result set changes
  useEffect(() => { setSelected(0); }, [flat.length, q, cmdQuery, isTextMode, isFileMode, isLineMode, isSymbolMode, isCmdPrefix]);

  // Keyboard — capture phase so it beats CM6 and other listeners
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); setSelected(s => Math.min(s + 1, flat.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter')   { e.preventDefault(); flat[selected]?.action(); }
      else if (e.key === 'Escape')  { e.preventDefault(); onClose(); }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [flat, selected, onClose]);

  // Scroll active row into view
  useEffect(() => {
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const isLoading = isTextMode && textLoading;
  const activeQuery = isTextMode ? textQuery
    : isFileMode ? fileQuery
    : isLineMode ? lineQuery
    : isSymbolMode ? symbolQuery
    : isCmdPrefix ? cmdQuery
    : q;

  // Hauteur centrée verticale haute, comme VS Code (panneau collé en haut).
  const pos = useMemo(() => ({
    left: Math.max(0, Math.round((window.innerWidth - PALETTE_W) / 2)),
    top: 0,
  }), []);

  // Message vide propre à chaque mode (formulation VS Code).
  const emptyMessage = isCmdPrefix ? 'No matching commands'
    : isQuickOpen ? 'No matching results'
    : isFileMode ? 'No matching files'
    : isSymbolMode ? 'No matching symbols'
    : isLineMode ? 'Type a line number to jump to it'
    : 'No results';

  return createPortal(
    <>
      {/* Scrim léger : clic hors palette pour fermer (VS Code assombrit à peine). */}
      <div
        onMouseDown={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'transparent',
        }}
      />
      <div
        ref={paletteRef}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          width: PALETTE_W,
          maxWidth: 'calc(100vw - 24px)',
          zIndex: 10000,
          background: 'var(--origin-bg-panel, var(--origin-bg-base))',
          color: 'var(--origin-fg-default)',
          border: '1px solid var(--origin-border-default)',
          borderTop: 'none',
          borderBottomLeftRadius: '6px',
          borderBottomRightRadius: '6px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        {/* Search input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '9px 12px',
          borderBottom: '1px solid var(--origin-border-subtle)',
        }}>
          <Search size={15} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={
              isLineMode ? 'Type a line number (or line:column)…'
              : isSymbolMode ? 'Type a symbol name…'
              : 'Search files by name (@ files · % text · : line · # symbol · > commands)'
            }
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: '13px', lineHeight: '1.4',
              color: 'var(--origin-fg-default)', fontFamily: 'var(--font-sans)',
            }}
          />
          {isLoading && <Loader size={14} style={{ color: 'var(--origin-fg-muted)', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />}
        </div>

        {/* Results — liste plate, lignes compactes comme VS Code */}
        {flat.length > 0 && (
          <div ref={listRef} style={{ maxHeight: 440, overflowY: 'auto', padding: '3px 6px 5px' }}>
            {flat.map((item, i) => (
              <Row key={item.id} item={item} active={i === selected} query={activeQuery} onHover={() => setSelected(i)} />
            ))}
          </div>
        )}

        {/* Empty / hint states */}
        {flat.length === 0 && !isLoading && (
          <div style={{ padding: '18px 12px', textAlign: 'center', color: 'var(--origin-fg-subtle)', fontSize: '13px' }}>
            {emptyMessage}{activeQuery ? ` for "${activeQuery}"` : ''}
          </div>
        )}
        {flat.length === 0 && isLoading && (
          <div style={{ padding: '18px 12px', textAlign: 'center', color: 'var(--origin-fg-subtle)', fontSize: '13px' }}>
            Searching…
          </div>
        )}

        {/* Footer : compteur de résultats, comme VS Code */}
        {flat.length > 0 && (
          <div style={{
            padding: '4px 12px',
            borderTop: '1px solid var(--origin-border-subtle)',
            fontSize: '11px', color: 'var(--origin-fg-subtle)',
            display: 'flex', justifyContent: 'space-between',
          }}>
            <span>{flat.length}{flat.length >= 60 ? '+ results' : ` result${flat.length === 1 ? '' : 's'}`}</span>
            <span>Enter to open · Esc to close</span>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

// ── sub-components ───────────────────────────────────────────────────────────

function HighlightMatch({ text, query, active }: { text: string; query: string; active?: boolean }) {
  // Sur fond accentué, le surlignage bleu serait invisible : on se contente du gras.
  const hlColor = active ? 'inherit' : 'var(--origin-accent-blue)';
  if (!query) return <>{text}</>;
  const ql = query.toLowerCase(), tl = text.toLowerCase();
  const idx = tl.indexOf(ql);
  if (idx !== -1) return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: hlColor, fontWeight: 600 }}>
        {text.slice(idx, idx + ql.length)}
      </span>
      {text.slice(idx + ql.length)}
    </>
  );
  const nodes: React.ReactNode[] = [];
  let qi = 0;
  for (let i = 0; i < text.length; i++) {
    if (qi < ql.length && tl[i] === ql[qi]) {
      nodes.push(<span key={i} style={{ color: hlColor, fontWeight: 600 }}>{text[i]}</span>);
      qi++;
    } else { nodes.push(text[i]); }
  }
  return <>{nodes}</>;
}

function Row({ item, active, query, onHover }: {
  item: PaletteItem; active: boolean; query: string; onHover: () => void;
}) {
  // Sur la ligne active (fond accentué bleu), on force un texte clair : les
  // couleurs « muted/subtle » du thème n'ont pas assez de contraste sur le bleu.
  const labelColor = active ? '#ffffff' : 'var(--origin-fg-default)';
  const subColor   = active ? 'rgba(255,255,255,0.75)' : 'var(--origin-fg-subtle)';
  return (
    <div
      onMouseEnter={onHover}
      onClick={item.action}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '4px 8px', borderRadius: '4px', cursor: 'pointer',
        minHeight: '22px',
        background: active ? 'var(--origin-accent-blue, var(--origin-bg-hover))' : 'transparent',
        transition: 'background 0.05s',
      }}
    >
      <span style={{ flexShrink: 0, display: 'flex', opacity: active ? 0.95 : 1 }}>{item.icon}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: '13px', color: labelColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <HighlightMatch text={item.label} query={query} active={active} />
        {item.detail && (
          <span style={{ fontSize: '11px', color: subColor, marginLeft: '8px' }}>
            {item.detail}
          </span>
        )}
      </span>
      {item.badge}
      {item.shortcut && (
        <kbd style={{ fontSize: '11px', color: subColor, fontFamily: 'var(--font-sans)', flexShrink: 0 }}>
          {item.shortcut}
        </kbd>
      )}
    </div>
  );
}
