import { useCallback, useMemo, useState } from "react";
import {
  File, FilePlus, FolderPlus, Pencil, Trash2, Copy, Scissors,
  ClipboardPaste, ExternalLink, ChevronsDownUp, RefreshCw, Eye, Columns2,
} from "lucide-react";
import { revealInExplorer, type FsEntry } from "../lib/fs";
import { useWorkspace } from "../context/WorkspaceContext";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import { useToast } from "./ui/Toast";
import ExplorerTree from "./explorer/ExplorerTree";
import CreateInput from "./explorer/CreateInput";
import { useExplorer } from "../lib/explorer/useExplorer";
import { deleteEntries } from "../lib/explorer/ops";
import { baseName, parentOf } from "../lib/explorer/treeModel";

interface Props {
  onFileOpen: (path: string) => void;
  onMarkdownPreview?: (path: string) => void;
  /** Ouvre le fichier dans un nouvel onglet à droite (Open to the Side). */
  onFileOpenToSide?: (path: string) => void;
  refreshKey?: number;
}

/**
 * Explorateur de fichiers façon VS Code : arbre virtualisé, multi-sélection,
 * drag & drop interne + import depuis l'OS, presse-papier, création/renommage
 * inline, raccourcis clavier et menu contextuel complet.
 */
export default function FileTree({
  onFileOpen, onMarkdownPreview = () => {}, onFileOpenToSide, refreshKey,
}: Props) {
  const { folderPath } = useWorkspace();
  const { showToast } = useToast();
  const explorer = useExplorer(folderPath ?? null, refreshKey, onFileOpen);
  const {
    rootName, rows, gitDecorations, selected, anchor, renamingPath, pendingCreate,
    dragPaths, dropTarget, canPaste,
    toggleExpanded, setExpandedAll, select, setSelected,
    beginDrag, endDrag, setDropTarget, dropInto, importInto,
    copyToClipboard, pasteInto, pruneSelection,
    startRename, cancelRename, commitRename,
    startCreate, cancelCreate, commitCreate, refresh,
  } = explorer;

  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);

  const selectedPaths = useMemo(() => [...selected], [selected]);

  /**
   * Dossier de création ciblé par les actions « New File/Folder » de l'en-tête :
   * le dossier sélectionné, sinon le parent du fichier sélectionné, sinon la
   * racine — exactement comme VS Code. Sans cela, la création ignorait la
   * sélection et tombait toujours à la racine.
   */
  const createTargetNow = useCallback((): string => {
    if (!folderPath) return "";
    for (const p of selectedPaths) {
      const row = rows.find(r => r.entry.path === p);
      if (row?.entry.is_dir) return p;
    }
    if (selectedPaths.length > 0) return parentOf(selectedPaths[0]);
    return folderPath;
  }, [rows, selectedPaths, folderPath]);


  // ── Suppression avec confirmation (style VS Code) ─────────────────────────────
  const requestDelete = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const label = paths.length === 1
      ? `"${baseName(paths[0])}"`
      : `${paths.length} items`;
    if (!window.confirm(`Are you sure you want to delete ${label}?`)) return;
    const ctx = { workspaceRoot: folderPath!, onChanged: () => {} };
    const results = await deleteEntries(ctx, paths);
    const failed = results.filter(r => !r.ok);
    if (failed.length) showToast(String(failed[0].error), "error");
    // Retire de la sélection les chemins réellement supprimés, sinon l'action
    // suivante (supprimer, couper…) viserait des chemins devenus inexistants.
    pruneSelection(results.filter(r => r.ok && r.path).map(r => r.path as string));
    // Le refresh global recharge les dossiers parents touchés.
    refresh();
  }, [folderPath, showToast, refresh, pruneSelection]);

  // ── Copier / couper / coller ──────────────────────────────────────────────────
  const doCopy = useCallback((paths: string[], mode: "copy" | "cut") => {
    copyToClipboard(paths, mode);
    if (mode === "cut") showToast(`Cut ${paths.length} item${paths.length > 1 ? "s" : ""}`, "info");
    else showToast(`Copied ${paths.length} item${paths.length > 1 ? "s" : ""}`, "info");
  }, [copyToClipboard, showToast]);

  const doPaste = useCallback(async (targetDir: string) => {
    await pasteInto(targetDir);
  }, [pasteInto]);

  // ── Drop interne (déplacement par glisser-déposer) ────────────────────────────
  const handleDropInto = useCallback(async (targetDir: string, sources: string[]) => {
    const results = await dropInto(targetDir, sources);
    const failed = results.filter(r => !r.ok);
    if (failed.length) showToast(String(failed[0].error), "error");
  }, [dropInto, showToast]);

  // ── Menu contextuel ───────────────────────────────────────────────────────────
  const openMenu = useCallback((x: number, y: number, entry: FsEntry | null) => {
    cancelRename();
    cancelCreate();
    setMenu({ x, y, entry });
  }, [cancelRename, cancelCreate]);

  const buildItems = useCallback((entry: FsEntry | null): MenuEntry[] => {
    if (!entry) {
      return [
        { label: "New File", icon: <FilePlus size={13} />, action: () => startCreate(folderPath!, "file") },
        { label: "New Folder", icon: <FolderPlus size={13} />, action: () => startCreate(folderPath!, "folder") },
        ...(canPaste ? [{ separator: true as const }, { label: "Paste", icon: <ClipboardPaste size={13} />, action: () => doPaste(folderPath!) }] : []),
        { separator: true },
        { label: "Refresh", icon: <RefreshCw size={13} />, action: refresh },
        { label: "Collapse All", icon: <ChevronsDownUp size={13} />, action: () => setExpandedAll(false) },
      ];
    }

    if (entry.is_dir) {
      const paths = selected.has(entry.path) ? selectedPaths : [entry.path];
      return [
        { label: "New File", icon: <FilePlus size={13} />, action: () => startCreate(entry.path, "file") },
        { label: "New Folder", icon: <FolderPlus size={13} />, action: () => startCreate(entry.path, "folder") },
        { separator: true },
        { label: "Cut", icon: <Scissors size={13} />, action: () => doCopy(paths, "cut") },
        { label: "Copy", icon: <Copy size={13} />, action: () => doCopy(paths, "copy") },
        ...(canPaste ? [{ label: "Paste", icon: <ClipboardPaste size={13} />, action: () => doPaste(entry.path) }] : []),
        { separator: true },
        { label: "Rename", icon: <Pencil size={13} />, action: () => startRename(entry.path) },
        { label: "Delete", icon: <Trash2 size={13} />, danger: true, action: () => requestDelete(paths) },
        { separator: true },
        { label: "Copy Path", icon: <Copy size={13} />, action: () => navigator.clipboard.writeText(entry.path) },
        { label: "Reveal in File Manager", icon: <ExternalLink size={13} />, action: () => revealInExplorer(entry.path) },
      ];
    }

    // Fichier.
    const root = (folderPath ?? "").replace(/[/\\]+$/, "");
    const rel = entry.path.startsWith(root) ? entry.path.slice(root.length + 1) : entry.path;
    const isMarkdown = /\.(md|mdx)$/i.test(entry.name);
    const paths = selected.has(entry.path) ? selectedPaths : [entry.path];

    return [
      { label: "Open", icon: <File size={13} />, action: () => onFileOpen(entry.path) },
      ...(onFileOpenToSide
        ? [{ label: "Open to the Side", icon: <Columns2 size={13} />, action: () => onFileOpenToSide(entry.path) }]
        : []),
      ...(isMarkdown
        ? [{ label: "Open Markdown Preview", icon: <Eye size={13} />, action: () => onMarkdownPreview(entry.path) }]
        : []),
      { separator: true },
      { label: "Cut", icon: <Scissors size={13} />, action: () => doCopy(paths, "cut") },
      { label: "Copy", icon: <Copy size={13} />, action: () => doCopy(paths, "copy") },
      { separator: true },
      { label: "Rename", icon: <Pencil size={13} />, action: () => startRename(entry.path) },
      { label: "Delete", icon: <Trash2 size={13} />, danger: true, action: () => requestDelete(paths) },
      { separator: true },
      { label: "Copy Path", icon: <Copy size={13} />, action: () => navigator.clipboard.writeText(entry.path) },
      { label: "Copy Relative Path", icon: <Copy size={13} />, action: () => navigator.clipboard.writeText(rel) },
      { label: "Reveal in File Manager", icon: <ExternalLink size={13} />, action: () => revealInExplorer(entry.path) },
    ];
  }, [
    folderPath, selected, selectedPaths, canPaste, startCreate, doPaste, refresh,
    setExpandedAll, startRename, requestDelete, doCopy, onFileOpen, onFileOpenToSide,
    onMarkdownPreview,
  ]);

  // ── Raccourcis clavier ────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>, activePath: string | null) => {
    // Supprimer (Del / Backspace).
    if ((e.key === "Delete" || e.key === "Backspace") && selectedPaths.length) {
      e.preventDefault();
      void requestDelete(selectedPaths);
      return;
    }
    // F2 → renommer.
    if (e.key === "F2" && activePath) {
      e.preventDefault();
      startRename(activePath);
      return;
    }
    // Ctrl/Cmd+N → nouveau fichier ; Ctrl/Cmd+Shift+N → nouveau dossier.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      const target = activePath ? parentOf(activePath) : folderPath!;
      startCreate(target, e.shiftKey ? "folder" : "file");
      return;
    }
    // Ctrl/Cmd+C / X / V → copier / couper / coller.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedPaths.length) {
      e.preventDefault();
      doCopy(selectedPaths, "copy");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selectedPaths.length) {
      e.preventDefault();
      doCopy(selectedPaths, "cut");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && canPaste) {
      e.preventDefault();
      // Colle dans le dossier actif, sinon dans son parent, sinon à la racine.
      const activeRow = activePath ? rows.find(r => r.entry.path === activePath) : null;
      const target = activeRow
        ? (activeRow.entry.is_dir ? activePath! : parentOf(activePath!))
        : folderPath!;
      void doPaste(target);
      return;
    }
    // Cmd/Ctrl+A → tout sélectionner.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(rows.map(r => r.entry.path));
      return;
    }

    // Navigation dans l'arbre (flèches / Entrée / Espace).
    const visiblePaths = rows.map(r => r.entry.path);
    const idx = activePath ? visiblePaths.indexOf(activePath) : -1;
    if (visiblePaths.length === 0) return;

    const currentRow = idx >= 0 ? rows[idx] : null;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(visiblePaths.length - 1, (idx < 0 ? (dir > 0 ? -1 : 0) : idx) + dir));
        const nextPath = visiblePaths[nextIdx];
        select(nextPath, { shift: e.shiftKey, meta: false });
        focusRow(nextPath);
        break;
      }
      case "ArrowRight": {
        if (!currentRow) break;
        e.preventDefault();
        if (currentRow.entry.is_dir && !currentRow.open) toggleExpanded(currentRow.entry.path, true);
        else if (currentRow.entry.is_dir && currentRow.open && idx + 1 < rows.length) {
          const child = rows[idx + 1].entry.path;
          select(child, {});
          focusRow(child);
        }
        break;
      }
      case "ArrowLeft": {
        if (!currentRow) break;
        e.preventDefault();
        if (currentRow.entry.is_dir && currentRow.open) toggleExpanded(currentRow.entry.path, false);
        else {
          const parent = parentOf(currentRow.entry.path);
          if (visiblePaths.includes(parent)) { select(parent, {}); focusRow(parent); }
        }
        break;
      }
      case "Enter": {
        if (!currentRow) break;
        e.preventDefault();
        if (currentRow.entry.is_dir) toggleExpanded(currentRow.entry.path);
        else onFileOpen(currentRow.entry.path);
        break;
      }
      case " ": {
        if (!currentRow) break;
        e.preventDefault();
        select(currentRow.entry.path, { meta: true });
        break;
      }
      default:
        break;
    }
  }, [rows, selectedPaths, canPaste, folderPath, requestDelete, startRename, startCreate, doCopy, doPaste, setSelected, select, toggleExpanded, onFileOpen]);

  if (!folderPath) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs" style={{ color: "var(--origin-fg-subtle)" }}>No folder open</p>
      </div>
    );
  }

  const selectedCount = selected.size;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* En-tête : nom de la racine + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "8px 8px 6px 12px", userSelect: "none" }}>
        <span style={{
          flex: 1, fontSize: 11, fontWeight: 600, letterSpacing: "0.8px",
          textTransform: "uppercase", color: "var(--origin-fg-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {rootName}{selectedCount > 1 ? ` · ${selectedCount} selected` : ""}
        </span>
        <button title="New File" onClick={() => startCreate(createTargetNow(), "file")} style={headerBtn}><FilePlus size={14} /></button>
        <button title="New Folder" onClick={() => startCreate(createTargetNow(), "folder")} style={headerBtn}><FolderPlus size={14} /></button>
        <button title="Refresh" onClick={refresh} style={headerBtn}><RefreshCw size={14} /></button>
        <button title="Collapse All" onClick={() => setExpandedAll(false)} style={headerBtn}><ChevronsDownUp size={14} /></button>
      </div>

      {/* Ligne de création à la racine */}
      {pendingCreate && pendingCreate.parentPath === folderPath && (
        <CreateRootRow
          kind={pendingCreate.kind}
          initialName={pendingCreate.initialName}
          onCommit={name => commitCreate(pendingCreate.parentPath, pendingCreate.kind, name)}
          onCancel={cancelCreate}
        />
      )}

      <ExplorerTree
        rows={rows}
        rootPath={folderPath}
        gitDecorations={gitDecorations}
        selected={selected}
        anchor={anchor}
        renamingPath={renamingPath}
        pendingCreate={pendingCreate?.parentPath === folderPath ? null : pendingCreate}
        dragPaths={dragPaths}
        dropTarget={dropTarget}
        onToggle={toggleExpanded}
        onSelect={select}
        onOpenFile={onFileOpen}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
        onCreateCommit={commitCreate}
        onCreateCancel={cancelCreate}
        onBeginDrag={beginDrag}
        onEndDrag={endDrag}
        onDropInto={handleDropInto}
        onImportInto={importInto}
        onSetDropTarget={setDropTarget}
        onContextMenu={openMenu}
        onKeyDown={handleKeyDown}
      />

      {rows.length === 0 && (
        <div style={{ padding: "12px", fontSize: 12, color: "var(--origin-fg-subtle)" }}>
          {explorer.loading ? "Loading…" : "Empty folder"}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

    </div>
  );
}

/** Ligne de création affichée directement sous l'en-tête (création à la racine). */
function CreateRootRow({
  kind, initialName, onCommit, onCancel,
}: {
  kind: "file" | "folder";
  initialName?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return <CreateInput kind={kind} depth={0} initialName={initialName} onCommit={onCommit} onCancel={onCancel} />;
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}

/** Donne le focus clavier à une ligne de l'arbre (navigation flèches/Entrée). */
function focusRow(path: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-origin-tree-row][data-path="${cssEscape(path)}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  });
}

const headerBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 22, height: 22, borderRadius: 4, border: "none",
  background: "transparent", cursor: "pointer",
  color: "var(--origin-fg-muted)", flexShrink: 0,
};
