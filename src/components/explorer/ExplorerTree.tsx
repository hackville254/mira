import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import FileIcon from "../FileIcon";
import { type FsEntry } from "../../lib/fs";
import { type FlatRow } from "../../lib/explorer/treeModel";
import { type GitStatus } from "../../lib/explorer/useExplorer";
import RenameInput from "./RenameInput";
import CreateInput from "./CreateInput";

const ROW_HEIGHT = 22;
const OVERSCAN = 8;

interface Props {
  rows: FlatRow[];
  gitDecorations: Map<string, GitStatus>;
  selected: Set<string>;
  anchor: string | null;
  renamingPath: string | null;
  pendingCreate: { parentPath: string; kind: "file" | "folder"; initialName?: string } | null;
  dragPaths: string[];
  dropTarget: string | null;
  /** Racine du workspace : cible d'un import OS déposé hors d'une ligne. */
  rootPath: string | null;
  onToggle: (path: string, open?: boolean) => void;
  onSelect: (path: string, mods: { meta?: boolean; shift?: boolean }) => void;
  onOpenFile: (path: string) => void;
  onRenameCommit: (from: string, newName: string) => void;
  onRenameCancel: () => void;
  onCreateCommit: (parentPath: string, kind: "file" | "folder", name: string) => void;
  onCreateCancel: () => void;
  onBeginDrag: (paths: string[]) => void;
  onEndDrag: () => void;
  onDropInto: (targetDir: string, sources: string[]) => void;
  onImportInto: (targetDir: string, externalPaths: string[]) => void;
  onSetDropTarget: (p: string | null) => void;
  onContextMenu: (x: number, y: number, entry: FsEntry | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>, activePath: string | null) => void;
}

export default function ExplorerTree(props: Props) {
  const {
    rows, gitDecorations, selected, anchor, renamingPath, pendingCreate,
    dragPaths, dropTarget,
    onToggle, onSelect, onOpenFile, onRenameCommit, onRenameCancel,
    onCreateCommit, onCreateCancel, onBeginDrag, onEndDrag, onDropInto,
    onImportInto, onSetDropTarget, onContextMenu, onKeyDown,
  } = props;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  // Chemin du dossier survolé par un drag (interne ou OS) et non lâché, ou null.
  const [osDropPath, setOsDropPath] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  // Session de drag interne (Pointer Events : l'API HTML5 DnD est bloquée par
  // Tauri 2 quand dragDropEnabled est actif, cf. import OS ci-dessous).
  const dragSession = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    paths: string[];
    active: boolean;
  } | null>(null);
  // Empêche le clic qui suit un drag (ouverture de fichier / toggle dossier).
  const suppressClick = useRef(false);
  // Position du curseur pendant un drag interne (pour le « ghost » qui suit).
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; count: number } | null>(null);

  // Taille du viewport (ResizeObserver) pour le fenêtrage.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Drop de fichiers depuis l'OS (Tauri 2) ───────────────────────────────────
  // En Tauri 2, le drag-drop natif est intercepté par le runtime : les events
  // HTML `drop` ne reçoivent PAS les fichiers et `File.path` est vide. On utilise
  // donc l'API officielle `onDragDropEvent` qui fournit les vrais chemins. On
  // hit-teste la ligne sous le curseur (position physique → logique via dpr).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        setOsDropPath(inExplorer(scrollerRef.current, payload.position.x, payload.position.y)
          ? targetDirAt(payload.position.x, payload.position.y, true)
          : null);
      } else if (payload.type === "drop") {
        setOsDropPath(null);
        if (payload.paths.length === 0) return;
        if (!inExplorer(scrollerRef.current, payload.position.x, payload.position.y)) return;
        // Cible = dossier survolé, sinon la racine de l'explorateur.
        const dir = targetDirAt(payload.position.x, payload.position.y, true);
        if (dir) onImportInto(dir, payload.paths);
        else if (props.rootPath) onImportInto(props.rootPath, payload.paths);
      } else if (payload.type === "leave") {
        setOsDropPath(null);
      }
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => { /* environnement non-Tauri (tests) : on ignore. */ });

    return () => { disposed = true; unlisten?.(); };
  }, [onImportInto, props.rootPath]);

  // ── Drag & drop interne (Pointer Events) ─────────────────────────────────────
  // Démarre une session au pointerdown sur une ligne (bouton gauche uniquement),
  // ne l'active qu'après un seuil de mouvement (pour ne pas gêner le clic), puis
  // suit le curseur pour désigner le dossier cible et dépose au relâchement.
  const onRowPointerDown = useCallback((e: React.PointerEvent, paths: string[]) => {
    if (e.button !== 0) return;
    // Empêche le drag natif de l'élément et la **sélection de texte** par le
    // navigateur : sans ça, glisser sur les lignes démarre une sélection de
    // texte (voire un `pointercancel`) au lieu de notre drag de fichiers.
    e.preventDefault();
    // Capture le pointeur : garantit que `pointermove`/`pointerup` nous
    // reviennent même si le curseur quitte la ligne, et empêche le navigateur
    // (WKWebView/WebView2) de démarrer un drag natif concurrent.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignoré */ }
    dragSession.current = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      paths, active: false,
    };
  }, []);

  useEffect(() => {
    const DRAG_THRESHOLD = 5; // px : au-delà, c'est un drag (pas un clic).

    // Cible interne du drag : le dossier sous le curseur, sinon la **racine** du
    // workspace quand on lâche dans la zone vide de l'explorateur (comme VS Code,
    // ce qui permet de ressortir un fichier d'un sous-dossier vers la racine).
    const internalTargetAt = (x: number, y: number): string | null => {
      const dir = targetDirAt(x, y);
      if (dir) return dir;
      const root = scrollerRef.current;
      if (!root) return null;
      const r = root.getBoundingClientRect();
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      return inside ? props.rootPath : null;
    };

    const onMove = (e: PointerEvent) => {
      const s = dragSession.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.active) {
        const dx = e.clientX - s.startX;
        const dy = e.clientY - s.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        s.active = true;
        suppressClick.current = true;
        // Verrouille la sélection de texte pour toute la durée du drag, même
        // quand le curseur sort de l'arbre.
        document.body.style.userSelect = "none";
        onBeginDrag(s.paths);
        document.body.style.cursor = "grabbing";
      }
      // Ghost qui suit le curseur + désigne le dossier sous le curseur.
      setDragGhost({ x: e.clientX, y: e.clientY, count: s.paths.length });
      onSetDropTarget(internalTargetAt(e.clientX, e.clientY));
    };

    const cleanupDragStyles = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const onUp = (e: PointerEvent) => {
      const s = dragSession.current;
      if (!s || e.pointerId !== s.pointerId) return;
      dragSession.current = null;
      cleanupDragStyles();
      setDragGhost(null);
      if (s.active) {
        // Dépôt dans l'input du chat ? On teste l'élément SOUS le curseur plutôt
        // que l'ordre des listeners `window` (non garanti) : si le relâchement a
        // lieu au-dessus d'une zone marquée `data-chat-drop`, on délègue à
        // l'input (qui attachera les chemins comme contexte) et on NE fait PAS
        // le déplacement interne — sinon le dossier serait à la fois attaché au
        // chat et déplacé dans l'arbre.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const chatDrop = el?.closest?.("[data-chat-drop]");
        if (chatDrop) {
          chatDrop.dispatchEvent(new CustomEvent("origin-chat-drop", {
            bubbles: true,
            detail: { paths: s.paths },
          }));
          onEndDrag();
          return;
        }
        const dir = internalTargetAt(e.clientX, e.clientY);
        // La racine et les lignes peuvent être des cibles ; on ignore seulement
        // quand la cible est l'un des éléments glissés (ou son sous-arbre).
        if (dir && !s.paths.includes(dir)) void onDropInto(dir, s.paths);
        else onEndDrag();
      }
    };

    const onCancel = () => {
      cleanupDragStyles();
      setDragGhost(null);
      if (dragSession.current?.active) onEndDrag();
      dragSession.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [onBeginDrag, onEndDrag, onDropInto, onSetDropTarget, props.rootPath]);

  // Fenêtrage : ne rend que les lignes visibles (+ overscan).
  const { startIndex, endIndex } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
    return { startIndex: start, endIndex: Math.min(rows.length, start + visibleCount) };
  }, [scrollTop, viewportH, rows.length]);

  const windowRows = rows.slice(startIndex, endIndex);
  const totalHeight = rows.length * ROW_HEIGHT;
  const offsetY = startIndex * ROW_HEIGHT;

  // Fait défiler une ligne dans la vue (navigation clavier).
  const ensureVisible = useCallback((index: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, []);

  // Expose le défilement impératif via un attribut sur le scroller.
  useEffect(() => {
    const el = scrollerRef.current as (HTMLDivElement & { __ensureVisible?: (i: number) => void }) | null;
    if (el) el.__ensureVisible = ensureVisible;
  }, [ensureVisible]);

  // L'entrée de création à afficher : soit à la racine, soit sous un dossier.
  const createParent = pendingCreate?.parentPath ?? null;

  // La ligne de création inline n'est rendue que si sa ligne tombe dans la
  // fenêtre virtualisée : on défile vers le dossier cible dès qu'une création
  // sous-dossier débute, sinon l'input resterait invisible hors écran.
  useEffect(() => {
    if (createParent === null) return;
    const idx = rows.findIndex(r => r.entry.path === createParent);
    if (idx >= 0) ensureVisible(idx + 1);
  }, [createParent, rows, ensureVisible]);

  const rootIsDropTarget = !!dropTarget && dropTarget === props.rootPath;

  return (
    <div
      ref={scrollerRef}
      className="flex-1 overflow-y-auto outline-none"
      role="tree"
      tabIndex={0}
      style={rootIsDropTarget
        ? { boxShadow: "inset 0 0 0 2px var(--origin-accent-blue)", background: "var(--origin-bg-hover)" }
        : undefined}
      onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      onClickCapture={e => {
        // Neutralise le clic qui suit immédiatement un drag (relâchement).
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onKeyDown={e => {
        const active = document.activeElement as HTMLElement | null;
        const activePath = active?.getAttribute("data-path") ?? null;
        onKeyDown(e, activePath);
      }}
      onContextMenu={e => {
        // Clic droit dans le vide → menu de la racine.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY, null);
        }
      }}
      data-explorer-scroller=""
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {/* Ligne de création affichée tout en haut du dossier cible si celui-ci
              est la racine (les sous-dossiers l'affichent inline ci-dessous). */}
          {createParent === null && null}
          {windowRows.map((row, i) => {
            const index = startIndex + i;
            const isRenaming = renamingPath === row.entry.path;
            const showCreateAfter =
              !!pendingCreate &&
              row.entry.is_dir &&
              row.open &&
              pendingCreate.parentPath === row.entry.path;
            const isExternalDrop = osDropPath === row.entry.path;
            return (
              <div key={row.entry.path}>
                <Row
                  row={row}
                  index={index}
                  selected={selected.has(row.entry.path)}
                  isAnchor={anchor === row.entry.path}
                  git={gitDecorations.get(row.entry.path)}
                  hovered={hoveredPath === row.entry.path}
                  isDropTarget={!isExternalDrop && dropTarget === row.entry.path}
                  isExternalDrop={isExternalDrop}
                  isRenaming={isRenaming}
                  dragging={dragPaths.includes(row.entry.path)}
                  selectedPaths={[...selected]}
                  onHover={setHoveredPath}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onOpenFile={onOpenFile}
                  onContextMenu={onContextMenu}
                  onPointerDown={onRowPointerDown}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                />
                {showCreateAfter && pendingCreate && (
                  <CreateInput
                    kind={pendingCreate.kind}
                    depth={row.depth + 1}
                    initialName={pendingCreate.initialName}
                    onCommit={name => onCreateCommit(pendingCreate.parentPath, pendingCreate.kind, name)}
                    onCancel={onCreateCancel}
                    onEnsureVisible={() => ensureVisible(index + 1)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {dragGhost && (
        <div
          style={{
            position: "fixed",
            left: dragGhost.x + 12,
            top: dragGhost.y + 12,
            zIndex: 9999,
            pointerEvents: "none",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 12,
            background: "var(--origin-bg-active)",
            color: "var(--origin-fg-default)",
            border: "1px solid var(--origin-accent-blue)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
        >
          {dragGhost.count} élément{dragGhost.count > 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

/** Position physique (événement Tauri) → pixels logiques (CSS). */
function logical(x: number, y: number): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: x / dpr, y: y / dpr };
}

/**
 * Le drop natif OS est global à la webview : on n'agit que si le curseur tombe
 * dans la zone de l'explorateur, sinon on laisse l'éditeur gérer son propre dépôt
 * (on n'importe rien dans le workspace par surprise).
 */
function inExplorer(root: HTMLElement | null, physX: number, physY: number): boolean {
  if (!root) return false;
  const r = root.getBoundingClientRect();
  const p = logical(physX, physY);
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/**
 * Ligne de dossier sous le curseur, ou null.
 * `phys` force la conversion depuis une position physique (événement Tauri) ;
 * par défaut on considère des coordonnées logiques (PointerEvent).
 */
function targetDirAt(x: number, y: number, phys = false): string | null {
  const p = phys ? logical(x, y) : { x, y };
  const el = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
  const row = el?.closest<HTMLElement>("[data-dir='1'][data-path]");
  return row?.getAttribute("data-path") ?? null;
}

interface RowProps {
  row: FlatRow;
  index: number;
  selected: boolean;
  isAnchor: boolean;
  git?: GitStatus;
  hovered: boolean;
  isDropTarget: boolean;
  isExternalDrop: boolean;
  isRenaming: boolean;
  dragging: boolean;
  selectedPaths: string[];
  onHover: (p: string | null) => void;
  onToggle: (path: string, open?: boolean) => void;
  onSelect: (path: string, mods: { meta?: boolean; shift?: boolean }) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (x: number, y: number, entry: FsEntry) => void;
  onPointerDown: (e: React.PointerEvent, paths: string[]) => void;
  onRenameCommit: (from: string, newName: string) => void;
  onRenameCancel: () => void;
}

function Row(p: RowProps) {
  const { entry, depth, open } = p.row;
  const indent = depth * 12 + 6;
  const git = p.git;

  const handleClick = (e: React.MouseEvent) => {
    if (p.isRenaming) return;
    const meta = e.metaKey || e.ctrlKey;
    p.onSelect(entry.path, { meta, shift: e.shiftKey });
    // Un clic avec modificateur sert à la sélection, pas à ouvrir/plier.
    if (meta || e.shiftKey) return;
    if (entry.is_dir) p.onToggle(entry.path);
    else p.onOpenFile(entry.path);
  };

  return (
    <div
      data-origin-tree-row=""
      data-path={entry.path}
      data-dir={entry.is_dir ? "1" : "0"}
      data-open={open ? "1" : "0"}
      role="treeitem"
      aria-expanded={entry.is_dir ? open : undefined}
      aria-selected={p.selected}
      tabIndex={-1}
      onPointerDown={e => {
        if (p.isRenaming) return;
        const mods = { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey };
        // Clic simple sur une ligne non sélectionnée : on la sélectionne au
        // mousedown pour pouvoir la glisser aussitôt (comportement VS Code).
        // Avec Shift/Ctrl on laisse le `onClick` étendre/ajouter à la sélection.
        if (!p.selected && !mods.meta && !mods.shift) p.onSelect(entry.path, mods);
        // Glisse toute la sélection si la ligne en fait partie, sinon la ligne.
        const paths = p.selected ? [...p.selectedPaths] : [entry.path];
        p.onPointerDown(e, paths);
      }}
      onClick={handleClick}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        if (!p.selected) p.onSelect(entry.path, {});
        p.onContextMenu(e.clientX, e.clientY, entry);
      }}
      onMouseEnter={() => p.onHover(entry.path)}
      onMouseLeave={() => p.onHover(null)}
      style={{
        height: ROW_HEIGHT,
        display: "flex", alignItems: "center", gap: 4,
        padding: `0 8px 0 ${indent}px`,
        background: (p.isDropTarget || p.isExternalDrop)
          ? "var(--origin-bg-hover)"
          : p.selected ? "var(--origin-bg-active)" : p.hovered ? "var(--origin-bg-hover)" : "transparent",
        boxShadow: p.isDropTarget || p.isExternalDrop ? "inset 0 0 0 1px var(--origin-accent-blue)" : "none",
        transition: "box-shadow 80ms ease, background 80ms ease",
        opacity: p.dragging ? 0.5 : 1,
        cursor: p.dragging ? "grabbing" : "pointer", fontFamily: "inherit", textAlign: "left",
        userSelect: "none",
      }}
    >
      <span style={{ width: 14, flexShrink: 0, color: "var(--origin-fg-muted)", display: "flex", alignItems: "center" }}>
        {entry.is_dir
          ? <button
              onClick={e => { e.stopPropagation(); p.onToggle(entry.path); }}
              style={{ display: "flex", alignItems: "center", background: "none", border: "none", padding: 0, color: "inherit", cursor: "pointer" }}
              tabIndex={-1}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          : null}
      </span>

      <FileIcon name={entry.name} isDir={entry.is_dir} expanded={open} size={14} />

      {p.isRenaming ? (
        <RenameInput
          initial={entry.name}
          onCommit={name => p.onRenameCommit(entry.path, name)}
          onCancel={p.onRenameCancel}
        />
      ) : (
        <>
          <span style={{
            flex: 1, fontSize: 13,
            color: git ? git.color : "var(--origin-fg-default)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            opacity: entry.name.startsWith(".") ? 0.6 : 1,
          }}>
            {entry.name}
          </span>
          {git && (
            <span title={git.label} style={{
              flexShrink: 0, fontSize: 11, fontWeight: 700, color: git.color,
              fontFamily: "var(--font-mono)", paddingRight: 2,
            }}>
              {git.code}
            </span>
          )}
        </>
      )}
    </div>
  );
}
