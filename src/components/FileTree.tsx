import { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from "react";
import {
  ChevronRight, ChevronDown, File,
  FilePlus, FolderPlus, Pencil, Trash2, Copy, ExternalLink, ChevronsDownUp,
} from "lucide-react";
import { readDir, writeFile, renamePath, deletePath, createDirCmd, revealInExplorer, type FsEntry } from "../lib/fs";
import { getStatusFiles, type StatusFile } from "../lib/git";
import { loadExpanded, saveExpanded } from "../lib/explorerState";
import FileIcon from "./FileIcon";
import { useWorkspace } from "../context/WorkspaceContext";
import ContextMenu, { type MenuEntry } from "./ContextMenu";

// ── Path utils ────────────────────────────────────────────────────────────────

function parentOf(p: string) { return p.replace(/[/\\][^/\\]+$/, ''); }
function sep(p: string) { return p.includes('\\') ? '\\' : '/'; }
function join(dir: string, name: string) { return `${dir.replace(/[/\\]+$/, '')}${sep(dir)}${name}`; }
function baseName(p: string) { return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p; }

// ── Git decoration ────────────────────────────────────────────────────────────

/** Statut git agrégé d'un chemin dans l'arbre. */
interface GitStatus { code: string; color: string; label: string; }

/**
 * Construit une map chemin → statut git à partir de `git_status_files`.
 * Les dossiers héritent du « pire » statut de leur sous-arbre (comme VS Code),
 * ce qui permet d'afficher une décoration colorée sur les dossiers parents.
 */
function buildGitDecoration(root: string, files: StatusFile[]): Map<string, GitStatus> {
  const map = new Map<string, GitStatus>();
  const sepChar = root.includes('\\') ? '\\' : '/';

  function statusFor(raw: string): GitStatus {
    const s = raw.replace(/\s/g, '');
    if (s === '??' || s === 'U') return { code: 'U', color: 'var(--origin-git-untracked)', label: 'Untracked' };
    if (s[0] === 'A') return { code: 'A', color: 'var(--origin-git-added)', label: 'Added' };
    if (s[0] === 'D' || s[1] === 'D') return { code: 'D', color: 'var(--origin-git-deleted)', label: 'Deleted' };
    if (s[0] === 'R') return { code: 'R', color: 'var(--origin-accent-blue)', label: 'Renamed' };
    if (s[0] === 'M' || s[1] === 'M') return { code: 'M', color: 'var(--origin-git-modified)', label: 'Modified' };
    return { code: '?', color: 'var(--origin-fg-muted)', label: 'Changed' };
  }

  // Priorité pour la propagation vers les dossiers parents.
  const rank: Record<string, number> = { M: 5, A: 4, R: 3, D: 2, U: 1, '?': 0 };

  for (const f of files) {
    const abs = f.path.includes(sepChar) ? f.path : join(root, f.path);
    const st = statusFor(f.status);
    map.set(abs, st);
    // Remonter vers la racine : décorer chaque dossier parent.
    let dir = parentOf(abs);
    const rootNorm = root.replace(/[/\\]+$/, '');
    while (dir.length >= rootNorm.length && dir.startsWith(rootNorm)) {
      const existing = map.get(dir);
      if (!existing || (rank[st.code] ?? 0) > (rank[existing.code] ?? 0)) {
        map.set(dir, { ...st, code: st.code });
      }
      if (dir === rootNorm) break;
      dir = parentOf(dir);
    }
  }
  return map;
}

// ── Shared context ─────────────────────────────────────────────────────────────

interface TreeCtx {
  onFileOpen: (path: string) => void;
  renamingPath: string | null;
  setRenamingPath: (p: string | null) => void;
  pendingCreate: { parentPath: string; kind: 'file' | 'folder' } | null;
  setPendingCreate: (v: { parentPath: string; kind: 'file' | 'folder' } | null) => void;
  openContextMenu: (x: number, y: number, entry: FsEntry | null) => void;
  nodeRefreshKey: Record<string, number>;
  refreshAt: (parentPath: string) => void;
  /** Chemins de dossiers dépliés (état partagé, supporte Collapse All). */
  expanded: Set<string>;
  toggleExpanded: (path: string, open?: boolean) => void;
  /** Chemins sélectionnés (multi-sélection). */
  selected: Set<string>;
  selectEntry: (entry: FsEntry, e: React.MouseEvent) => void;
  isSelected: (path: string) => boolean;
  /** Drag & drop : déplacer un ensemble de chemins vers un dossier cible. */
  beginDrag: (paths: string[]) => void;
  moveInto: (targetDir: string) => void;
  dragSourcePaths: string[];
  /** Statut git par chemin (fichier + dossiers parents). */
  gitDecorations: Map<string, GitStatus>;
  /** Chemin actuellement survolé par un drag (dossier cible). */
  dropTarget: string | null;
  setDropTarget: (p: string | null) => void;
}

const TreeCtx = createContext<TreeCtx>({
  onFileOpen: () => {},
  renamingPath: null, setRenamingPath: () => {},
  pendingCreate: null, setPendingCreate: () => {},
  openContextMenu: () => {},
  nodeRefreshKey: {},
  refreshAt: () => {},
  expanded: new Set(), toggleExpanded: () => {},
  selected: new Set(), selectEntry: () => {}, isSelected: () => false,
  beginDrag: () => {}, moveInto: () => {}, dragSourcePaths: [],
  gitDecorations: new Map(),
  dropTarget: null, setDropTarget: () => {},
});

// ── Inline rename input ───────────────────────────────────────────────────────

function RenameInput({ entry, onDone }: { entry: FsEntry; onDone: () => void }) {
  const [name, setName] = useState(entry.name);
  const { refreshAt } = useContext(TreeCtx);
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  async function commit() {
    if (committed.current) return;
    committed.current = true;
    const trimmed = name.trim();
    if (trimmed && trimmed !== entry.name) {
      try {
        await renamePath(entry.path, join(parentOf(entry.path), trimmed));
        refreshAt(parentOf(entry.path));
      } catch (e) { alert(String(e)); }
    }
    onDone();
  }

  return (
    <input
      ref={inputRef}
      value={name}
      onChange={e => setName(e.target.value)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(); else if (e.key === 'Escape') onDone(); }}
      onBlur={commit}
      onClick={e => e.stopPropagation()}
      style={{
        flex: 1, fontSize: '12px', padding: '1px 4px', minWidth: 0,
        backgroundColor: 'var(--origin-bg-active)', color: 'var(--origin-fg-default)',
        border: '1px solid var(--origin-accent-blue)', borderRadius: 3,
        outline: 'none', fontFamily: 'var(--font-sans)',
      }}
    />
  );
}

// ── Inline create input ───────────────────────────────────────────────────────

function CreateInput({ parentPath, kind, depth, onDone }: {
  parentPath: string; kind: 'file' | 'folder'; depth: number; onDone: () => void;
}) {
  const [name, setName] = useState('');
  const { refreshAt } = useContext(TreeCtx);
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function commit() {
    if (committed.current) return;
    committed.current = true;
    const trimmed = name.trim();
    if (trimmed) {
      try {
        const newPath = join(parentPath, trimmed);
        if (kind === 'folder') await createDirCmd(newPath);
        else await writeFile(newPath, '');
        refreshAt(parentPath);
      } catch (e) { alert(String(e)); }
    }
    onDone();
  }

  const indent = depth * 12 + 6;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: `3px 8px 3px ${indent}px` }}>
      {kind === 'folder'
        ? <FolderPlus size={14} style={{ flexShrink: 0, color: '#eab308' }} />
        : <FilePlus  size={14} style={{ flexShrink: 0, color: 'var(--origin-fg-muted)' }} />}
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={kind === 'folder' ? 'folder name' : 'file name'}
        onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') onDone(); }}
        onBlur={commit}
        style={{
          flex: 1, fontSize: '12px', padding: '1px 4px', minWidth: 0,
          backgroundColor: 'var(--origin-bg-active)', color: 'var(--origin-fg-default)',
          border: '1px solid var(--origin-accent-blue)', borderRadius: 3,
          outline: 'none', fontFamily: 'var(--font-sans)',
        }}
      />
    </div>
  );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const {
    onFileOpen, renamingPath, setRenamingPath, pendingCreate, setPendingCreate,
    openContextMenu, nodeRefreshKey, expanded, toggleExpanded,
    selected, selectEntry, isSelected, beginDrag, moveInto, dragSourcePaths,
    gitDecorations, dropTarget, setDropTarget,
  } = useContext(TreeCtx);
  const [children, setChildren] = useState<FsEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isRenaming = renamingPath === entry.path;
  const createHere = entry.is_dir && pendingCreate?.parentPath === entry.path;
  const isOpen = entry.is_dir && expanded.has(entry.path);
  const selectedHere = isSelected(entry.path);
  const isDropTarget = dropTarget === entry.path;
  const git = gitDecorations.get(entry.path);

  // Charge les enfants si le dossier est déplié (y compris après restauration).
  useEffect(() => {
    if (!entry.is_dir || !isOpen) return;
    let cancelled = false;
    readDir(entry.path)
      .then(c => { if (!cancelled) { setChildren(c); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setChildren([]); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [entry.is_dir, isOpen, entry.path]);

  // Auto-déplie le dossier quand une création est demandée dedans.
  useEffect(() => {
    if (!createHere) return;
    toggleExpanded(entry.path, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createHere]);

  // Refresh des enfants quand un descendant le demande.
  useEffect(() => {
    if (!loaded || !nodeRefreshKey[entry.path]) return;
    readDir(entry.path).then(setChildren).catch(() => setChildren([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeRefreshKey[entry.path]]);

  function handleClick(e: React.MouseEvent) {
    if (isRenaming) return;
    selectEntry(entry, e);
    if (entry.is_dir) toggleExpanded(entry.path);
    else onFileOpen(entry.path);
  }

  const indent = depth * 12 + 6;

  return (
    <div
      onDragOver={entry.is_dir ? (e) => {
        if (dragSourcePaths.length === 0) return;
        e.preventDefault();
        setDropTarget(entry.path);
      } : undefined}
      onDragLeave={entry.is_dir ? () => { if (isDropTarget) setDropTarget(null); } : undefined}
      onDrop={entry.is_dir ? (e) => {
        e.preventDefault();
        moveInto(entry.path);
        setDropTarget(null);
      } : undefined}
    >
      <div
        data-origin-tree-row=""
        data-path={entry.path}
        data-dir={entry.is_dir ? '1' : '0'}
        data-open={isOpen ? '1' : '0'}
        role="treeitem"
        aria-expanded={entry.is_dir ? isOpen : undefined}
        tabIndex={-1}
        draggable
        onDragStart={(e) => {
          // Démarre un drag avec toute la sélection (ou l'élément courant).
          const paths = selectedHere ? [...selected] : [entry.path];
          beginDrag(paths);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', entry.path);
        }}
        onClick={handleClick}
        onContextMenu={e => {
          e.preventDefault(); e.stopPropagation();
          if (!selectedHere) selectEntry(entry, e);
          openContextMenu(e.clientX, e.clientY, entry);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          gap: 4, padding: `3px 8px 3px ${indent}px`,
          border: 'none',
          background: selectedHere
            ? 'var(--origin-bg-active)'
            : hovered ? 'var(--origin-bg-hover)' : 'transparent',
          boxShadow: isDropTarget ? 'inset 0 0 0 1px var(--origin-accent-blue)' : 'none',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          transition: 'background 0.1s', userSelect: 'none',
        }}
      >
        <span style={{ width: 14, flexShrink: 0, color: 'var(--origin-fg-muted)', display: 'flex', alignItems: 'center' }}>
          {entry.is_dir ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>

        <FileIcon name={entry.name} isDir={entry.is_dir} expanded={isOpen} size={14} />

        {isRenaming
          ? <RenameInput entry={entry} onDone={() => setRenamingPath(null)} />
          : (
            <>
              <span style={{
                flex: 1, fontSize: 13,
                color: git ? git.color : 'var(--origin-fg-default)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                opacity: entry.name.startsWith('.') ? 0.6 : 1,
              }}>
                {entry.name}
              </span>
              {git && (
                <span
                  title={git.label}
                  style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 700,
                    color: git.color, fontFamily: 'var(--font-mono)',
                    paddingRight: 2,
                  }}
                >
                  {git.code}
                </span>
              )}
            </>
          )
        }
      </div>

      {entry.is_dir && isOpen && (
        <>
          {createHere && (
            <CreateInput
              parentPath={entry.path}
              kind={pendingCreate!.kind}
              depth={depth + 1}
              onDone={() => setPendingCreate(null)}
            />
          )}
          {children.map(child => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  );
}

// ── File Tree ─────────────────────────────────────────────────────────────────

interface Props {
  onFileOpen: (path: string) => void;
  refreshKey?: number;
}

export default function FileTree({ onFileOpen, refreshKey }: Props) {
  const { folderPath } = useWorkspace();
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const rootName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? '';

  const [menuState, setMenuState] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ parentPath: string; kind: 'file' | 'folder' } | null>(null);
  const [nodeRefreshKey, setNodeRefreshKey] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => (folderPath ? loadExpanded(folderPath) : new Set()));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gitDecorations, setGitDecorations] = useState<Map<string, GitStatus>>(new Map());
  const [dragSourcePaths, setDragSourcePaths] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // ── Data loading ────────────────────────────────────────────────────────────

  const refreshRoot = useCallback(() => {
    if (!folderPath) return;
    readDir(folderPath).then(setRootEntries).catch(() => setRootEntries([]));
  }, [folderPath]);

  const refreshAt = useCallback((parentPath: string) => {
    const rootNorm = (folderPath ?? '').replace(/[/\\]+$/, '');
    const pathNorm = parentPath.replace(/[/\\]+$/, '');
    if (pathNorm === rootNorm) {
      refreshRoot();
    } else {
      setNodeRefreshKey(prev => ({ ...prev, [parentPath]: (prev[parentPath] ?? 0) + 1 }));
    }
  }, [folderPath, refreshRoot]);

  // Recharge la racine + les décorations git.
  const reloadAll = useCallback(() => {
    if (!folderPath) return;
    readDir(folderPath).then(setRootEntries).catch(() => setRootEntries([]));
    getStatusFiles(folderPath)
      .then(files => setGitDecorations(buildGitDecoration(folderPath, files)))
      .catch(() => setGitDecorations(new Map()));
  }, [folderPath]);

  useEffect(() => { reloadAll(); }, [reloadAll, refreshKey]);

  // Pas de workspace : on vide l'arbre (synchrone, hors effet).
  if (!folderPath && rootEntries.length > 0) setRootEntries([]);

  // Réinitialise l'état (expansion restaurée + sélection) au changement de workspace.
  // Réinitialise via l'événement de changement de dossier plutôt qu'un setState synchrone.
  const rootKeyRef = useRef<string | null>(folderPath ?? null);
  if (rootKeyRef.current !== (folderPath ?? null)) {
    rootKeyRef.current = folderPath ?? null;
    setExpanded(folderPath ? loadExpanded(folderPath) : new Set());
    setSelected(new Set());
  }

  // Persiste l'expansion (debounce léger via microtask).
  useEffect(() => {
    if (!folderPath) return;
    saveExpanded(folderPath, expanded);
  }, [folderPath, expanded]);

  // Rafraîchit les décorations git périodiquement tant que le panneau est monté.
  useEffect(() => {
    if (!folderPath) return;
    const id = setInterval(() => {
      getStatusFiles(folderPath)
        .then(files => setGitDecorations(buildGitDecoration(folderPath, files)))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [folderPath]);

  // ── Expansion ───────────────────────────────────────────────────────────────

  const toggleExpanded = useCallback((path: string, open?: boolean) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const willOpen = open ?? !next.has(path);
      if (willOpen) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // Développe récursivement un dossier (et tous ses sous-dossiers) — pour la
  // navigation clavier « Right » sur une racine, on se limite au 1er niveau.
  const expandNode = useCallback(async (path: string) => {
    toggleExpanded(path, true);
  }, [toggleExpanded]);

  // ── Sélection ───────────────────────────────────────────────────────────────

  const selectEntry = useCallback((entry: FsEntry, e: React.MouseEvent) => {
    setSelected(prev => {
      // Cmd/Ctrl+clic : ajout/retrait unitaire.
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
        return next;
      }
      // Clic simple : remplace la sélection.
      return new Set([entry.path]);
    });
  }, []);

  const isSelected = useCallback((path: string) => selected.has(path), [selected]);

  // ── Drag & drop (déplacement) ───────────────────────────────────────────────

  const beginDrag = useCallback((paths: string[]) => setDragSourcePaths(paths), []);

  const moveInto = useCallback(async (targetDir: string) => {
    const sources = dragSourcePaths;
    setDragSourcePaths([]);
    if (sources.length === 0) return;
    const targetNorm = targetDir.replace(/[/\\]+$/, '');
    for (const src of sources) {
      const srcNorm = src.replace(/[/\\]+$/, '');
      // Interdit : déplacer un dossier dans lui-même ou dans un de ses descendants.
      if (targetNorm === srcNorm || targetNorm.startsWith(srcNorm + sep(srcNorm))) continue;
      // Interdit : déplacer vers son dossier parent actuel (no-op).
      if (parentOf(srcNorm) === targetNorm) continue;
      try {
        await renamePath(src, join(targetDir, baseName(src)));
      } catch (e) { alert(String(e)); }
    }
    refreshAt(targetDir);
    // Rafraîchit aussi les parents des sources (elles ont disparu de là-bas).
    for (const src of sources) refreshAt(parentOf(src));
    reloadAll();
  }, [dragSourcePaths, refreshAt, reloadAll]);

  // ── Navigation clavier ──────────────────────────────────────────────────────

  function visibleRows(): HTMLElement[] {
    if (!containerRef.current) return [];
    return Array.from(containerRef.current.querySelectorAll<HTMLElement>('[data-origin-tree-row]'));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? rows.indexOf(active) : -1;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = rows[Math.min(rows.length - 1, idx < 0 ? 0 : idx + 1)];
        next?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = rows[Math.max(0, idx <= 0 ? 0 : idx - 1)];
        prev?.focus();
        break;
      }
      case 'ArrowRight': {
        if (idx < 0) break;
        e.preventDefault();
        const row = rows[idx];
        const path = row.getAttribute('data-path');
        if (!path || row.getAttribute('data-dir') !== '1') break;
        // Fermé → on l'ouvre. Déjà ouvert → on descend au 1er enfant (VS Code).
        if (row.getAttribute('data-open') === '1') {
          const child = rows[idx + 1];
          if (child && child !== row) child.focus();
        } else {
          void expandNode(path);
        }
        break;
      }
      case 'ArrowLeft': {
        if (idx < 0) break;
        e.preventDefault();
        const row = rows[idx];
        const path = row.getAttribute('data-path');
        if (!path) break;
        // Ouvert → on le referme. Sinon → on remonte au dossier parent (VS Code).
        if (row.getAttribute('data-dir') === '1' && row.getAttribute('data-open') === '1') {
          toggleExpanded(path, false);
        } else {
          const parent = parentOf(path);
          const parentRow = rows.find(r => r.getAttribute('data-path') === parent);
          parentRow?.focus();
        }
        break;
      }
      case 'Enter': {
        if (idx < 0) break;
        e.preventDefault();
        rows[idx].click();
        break;
      }
      default:
        break;
    }
  }

  // ── Context menu ────────────────────────────────────────────────────────────

  function openContextMenu(x: number, y: number, entry: FsEntry | null) {
    setRenamingPath(null);
    setPendingCreate(null);
    setMenuState({ x, y, entry });
  }

  function buildMenuItems(entry: FsEntry | null): MenuEntry[] {
    if (!entry) {
      return [
        { label: 'New File',   icon: <FilePlus   size={13} />, action: () => setPendingCreate({ parentPath: folderPath!, kind: 'file'   }) },
        { label: 'New Folder', icon: <FolderPlus size={13} />, action: () => setPendingCreate({ parentPath: folderPath!, kind: 'folder' }) },
        { separator: true },
        { label: 'Collapse All', icon: <ChevronsDownUp size={13} />, action: collapseAll },
      ];
    }

    if (entry.is_dir) {
      return [
        { label: 'New File Here',   icon: <FilePlus   size={13} />, action: () => setPendingCreate({ parentPath: entry.path, kind: 'file'   }) },
        { label: 'New Folder Here', icon: <FolderPlus size={13} />, action: () => setPendingCreate({ parentPath: entry.path, kind: 'folder' }) },
        { separator: true },
        { label: 'Rename',        icon: <Pencil size={13} />,       action: () => setRenamingPath(entry.path) },
        { label: 'Delete Folder', icon: <Trash2 size={13} />, danger: true,
          action: async () => {
            if (!window.confirm(`Delete folder "${entry.name}" and all its contents?`)) return;
            try { await deletePath(entry.path); refreshAt(parentOf(entry.path)); } catch (e) { alert(String(e)); }
          },
        },
        { separator: true },
        { label: 'Copy Path',          icon: <Copy        size={13} />, action: () => navigator.clipboard.writeText(entry.path) },
        { label: 'Reveal in Explorer', icon: <ExternalLink size={13} />, action: () => revealInExplorer(entry.path) },
      ];
    }

    // Fichier
    const root = (folderPath ?? '').replace(/[/\\]+$/, '');
    const rel = entry.path.startsWith(root) ? entry.path.slice(root.length + 1) : entry.path;

    return [
      { label: 'Open in Editor', icon: <File size={13} />, action: () => onFileOpen(entry.path) },
      { separator: true },
      { label: 'Rename',      icon: <Pencil size={13} />,       action: () => setRenamingPath(entry.path) },
      { label: 'Delete File', icon: <Trash2 size={13} />, danger: true,
        action: async () => {
          if (!window.confirm(`Delete "${entry.name}"?`)) return;
          try { await deletePath(entry.path); refreshAt(parentOf(entry.path)); } catch (e) { alert(String(e)); }
        },
      },
      { separator: true },
      { label: 'Copy Path',          icon: <Copy        size={13} />, action: () => navigator.clipboard.writeText(entry.path) },
      { label: 'Copy Relative Path', icon: <Copy        size={13} />, action: () => navigator.clipboard.writeText(rel) },
      { label: 'Reveal in Explorer', icon: <ExternalLink size={13} />, action: () => revealInExplorer(entry.path) },
    ];
  }

  const ctxValue = useMemo<TreeCtx>(() => ({
    onFileOpen,
    renamingPath, setRenamingPath,
    pendingCreate, setPendingCreate,
    openContextMenu,
    nodeRefreshKey,
    refreshAt,
    expanded, toggleExpanded,
    selected, selectEntry, isSelected,
    beginDrag, moveInto, dragSourcePaths,
    gitDecorations,
    dropTarget, setDropTarget,
  }), [
    onFileOpen, renamingPath, pendingCreate, nodeRefreshKey, refreshAt,
    expanded, toggleExpanded, selected, selectEntry, isSelected,
    beginDrag, moveInto, dragSourcePaths, gitDecorations, dropTarget,
  ]);

  if (!folderPath) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs" style={{ color: 'var(--origin-fg-subtle)' }}>No folder open</p>
      </div>
    );
  }

  const createAtRoot = pendingCreate?.parentPath === folderPath || pendingCreate?.parentPath === folderPath?.replace(/[/\\]+$/, '');
  const selectedCount = selected.size;

  return (
    <TreeCtx.Provider value={ctxValue}>
      <div
        ref={containerRef}
        role="tree"
        tabIndex={0}
        className="flex-1 flex flex-col overflow-y-auto outline-none"
        onKeyDown={handleKeyDown}
        onContextMenu={e => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, null); }}
        onDragEnd={() => { setDragSourcePaths([]); setDropTarget(null); }}
      >
        {/* En-tête : nom de la racine + actions façon VS Code */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          padding: '8px 8px 6px 12px', userSelect: 'none',
        }}>
          <span style={{
            flex: 1, fontSize: 11, fontWeight: 600,
            letterSpacing: '0.8px', textTransform: 'uppercase',
            color: 'var(--origin-fg-muted)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {rootName}{selectedCount > 1 ? ` · ${selectedCount} selected` : ''}
          </span>
          <button title="New File"   onClick={() => setPendingCreate({ parentPath: folderPath, kind: 'file' })}   style={headerBtn}><FilePlus size={14} /></button>
          <button title="New Folder" onClick={() => setPendingCreate({ parentPath: folderPath, kind: 'folder' })} style={headerBtn}><FolderPlus size={14} /></button>
          <button title="Collapse All" onClick={collapseAll} style={headerBtn}><ChevronsDownUp size={14} /></button>
        </div>

        <div style={{ flex: 1 }}>
          {createAtRoot && (
            <CreateInput
              parentPath={folderPath}
              kind={pendingCreate!.kind}
              depth={0}
              onDone={() => setPendingCreate(null)}
            />
          )}
          {rootEntries.map(entry => (
            <TreeNode key={entry.path} entry={entry} depth={0} />
          ))}
        </div>
      </div>

      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={buildMenuItems(menuState.entry)}
          onClose={() => setMenuState(null)}
        />
      )}
    </TreeCtx.Provider>
  );
}

const headerBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, borderRadius: 4, border: 'none',
  background: 'transparent', cursor: 'pointer',
  color: 'var(--origin-fg-muted)', flexShrink: 0,
};
