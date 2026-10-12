import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "../fs";
import { getStatusFiles, type StatusFile } from "../git";
import { loadExpanded, saveExpanded } from "../explorerState";
import * as ops from "./ops";
import {
  flattenTree, nextSelection, parentOf, normalize, isAncestorOrSelf, baseName,
  type FlatRow, type SelectMods,
} from "./treeModel";

// ── Décoration git ────────────────────────────────────────────────────────────

export interface GitStatus { code: string; color: string; label: string; }

/** Map chemin → statut git (fichiers + dossiers parents, comme VS Code). */
export function buildGitDecoration(root: string, files: StatusFile[]): Map<string, GitStatus> {
  const map = new Map<string, GitStatus>();
  const sepChar = root.includes("\\") ? "\\" : "/";

  function statusFor(raw: string): GitStatus {
    const s = raw.replace(/\s/g, "");
    if (s === "??" || s === "U") return { code: "U", color: "var(--origin-git-untracked)", label: "Untracked" };
    if (s[0] === "A") return { code: "A", color: "var(--origin-git-added)", label: "Added" };
    if (s[0] === "D" || s[1] === "D") return { code: "D", color: "var(--origin-git-deleted)", label: "Deleted" };
    if (s[0] === "R") return { code: "R", color: "var(--origin-accent-blue)", label: "Renamed" };
    if (s[0] === "M" || s[1] === "M") return { code: "M", color: "var(--origin-git-modified)", label: "Modified" };
    return { code: "?", color: "var(--origin-fg-muted)", label: "Changed" };
  }

  const rank: Record<string, number> = { M: 5, A: 4, R: 3, D: 2, U: 1, "?": 0 };

  for (const f of files) {
    const abs = f.path.includes(sepChar) ? f.path : `${root.replace(/[/\\]+$/, "")}${sepChar}${f.path}`;
    const st = statusFor(f.status);
    map.set(abs, st);
    let dir = parentOf(abs);
    const rootNorm = root.replace(/[/\\]+$/, "");
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

// ── Presse-papier interne ─────────────────────────────────────────────────────

export interface Clipboard {
  mode: "copy" | "cut";
  paths: string[];
}

export interface PendingCreate {
  parentPath: string;
  kind: "file" | "folder";
  /** Nom pré-rempli optionnel (renommage via « rename adjacent »). */
  initialName?: string;
}

export interface UseExplorerResult {
  rootName: string;
  rows: FlatRow[];
  loading: boolean;
  gitDecorations: Map<string, GitStatus>;
  expanded: Set<string>;
  selected: Set<string>;
  anchor: string | null;
  clipboard: Clipboard | null;
  dragPaths: string[];
  dropTarget: string | null;
  renamingPath: string | null;
  pendingCreate: PendingCreate | null;
  // actions
  toggleExpanded: (path: string, open?: boolean) => void;
  setExpandedAll: (open: boolean) => void;
  select: (path: string, mods: SelectMods) => void;
  setSelected: (paths: string[]) => void;
  beginDrag: (paths: string[]) => void;
  endDrag: () => void;
  setDropTarget: (p: string | null) => void;
  dropInto: (targetDir: string, sources?: string[]) => Promise<ops.OpResult[]>;
  importInto: (targetDir: string, externalPaths: string[]) => Promise<void>;
  copyToClipboard: (paths: string[], mode: "copy" | "cut") => void;
  pasteInto: (targetDir: string) => Promise<void>;
  startRename: (path: string) => void;
  cancelRename: () => void;
  commitRename: (from: string, newName: string) => Promise<void>;
  startCreate: (parentPath: string, kind: "file" | "folder", initialName?: string) => void;
  cancelCreate: () => void;
  commitCreate: (parentPath: string, kind: "file" | "folder", name: string) => Promise<void>;
  canPaste: boolean;
  refresh: () => void;
}

/**
 * État centralisé de l'explorateur. Possède le cache d'entrées par dossier,
 * l'expansion persistée, la sélection (avec ancre), le presse-papier interne,
 * le drag et la création/renommage inline. Le rendu est laissé au composant,
 * qui consomme `rows` (arbre déjà aplati et trié).
 */
export function useExplorer(
  folderPath: string | null,
  refreshKey: number | undefined,
  onFileOpen: (path: string) => void,
): UseExplorerResult {
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([]);
  const [cache, setCache] = useState<Record<string, FsEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [gitDecorations, setGitDecorations] = useState<Map<string, GitStatus>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => (folderPath ? loadExpanded(folderPath) : new Set()));
  const [selected, setSelectedState] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [dragPaths, setDragPaths] = useState<string[]>([]);
  // Miroir de `dragPaths` pour lecture synchrone sans recréer de callbacks.
  const dragPathsRef = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

  const root = folderPath ? normalize(folderPath) : null;
  const rootName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? "";

  // Contexte d'opérations + rafraîchissement ciblé (refs stables lues par les
  // closures d'ops sans provoquer de recréation de callbacks).
  const opsCtxRef = useRef<ops.ExplorerOpsCtx | null>(null);
  const refreshRef = useRef<(dirs: string[]) => void>(() => {});

  // ── Chargement ──────────────────────────────────────────────────────────────

  const loadDir = useCallback(async (dir: string): Promise<FsEntry[]> => {
    if (!root) return [];
    if (!isAncestorOrSelf(dir, root)) return [];
    try {
      return await ops.listDir({ workspaceRoot: root, onChanged: () => {} }, dir);
    } catch {
      return [];
    }
  }, [root]);

  const reloadGit = useCallback(() => {
    if (!folderPath) return;
    getStatusFiles(folderPath)
      .then(files => setGitDecorations(buildGitDecoration(folderPath, files)))
      .catch(() => setGitDecorations(new Map()));
  }, [folderPath]);

  // Recharge la racine puis les dossiers déjà dépliés.
  const reloadAll = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    const entries = await loadDir(root);
    setRootEntries(entries);
    const dirsToLoad = new Set<string>([root]);
    expanded.forEach(p => { if (isAncestorOrSelf(p, root)) dirsToLoad.add(p); });
    const nextCache: Record<string, FsEntry[]> = {};
    await Promise.all([...dirsToLoad].map(async dir => {
      nextCache[dir] = await loadDir(dir);
    }));
    setCache(nextCache);
    setLoading(false);
  }, [root, expanded, loadDir]);

  // Rafraîchissement ciblé : recharge uniquement les dossiers fournis.
  const refreshDirs = useCallback(async (dirs: string[]) => {
    if (!root) return;
    const next: Record<string, FsEntry[]> = {};
    let rootKids: FsEntry[] | null = null;
    for (const dir of new Set(dirs.map(normalize))) {
      if (!isAncestorOrSelf(dir, root)) continue;
      const kids = await loadDir(dir);
      if (dir === root) rootKids = kids;
      else next[dir] = kids;
    }
    if (rootKids) setRootEntries(rootKids);
    if (Object.keys(next).length) setCache(prev => ({ ...prev, ...next }));
    reloadGit();
  }, [root, loadDir, reloadGit]);

  // Câble le contexte d'ops sur l'état courant (au lieu de muter des refs au rendu).
  useEffect(() => {
    opsCtxRef.current = root
      ? { workspaceRoot: root, onChanged: (dirs) => refreshRef.current(dirs) }
      : null;
  }, [root]);
  useEffect(() => {
    refreshRef.current = (dirs) => { void refreshDirs(dirs); };
  }, [refreshDirs]);

  // Recharge le cache quand la racine change ou sur refresh externe.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load/sync external FS state on root or refresh change
    void reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, refreshKey]);

  // Décoration git + rafraîchissement périodique.
  useEffect(() => { reloadGit(); }, [reloadGit]);
  useEffect(() => {
    if (!folderPath) return;
    const id = setInterval(reloadGit, 5000);
    return () => clearInterval(id);
  }, [folderPath, reloadGit]);

  // Réinitialise sélection/expansion au changement de workspace.
  const rootKeyRef = useRef<string | null>(root);
  if (rootKeyRef.current !== root) {
    rootKeyRef.current = root;
    setExpanded(folderPath ? loadExpanded(folderPath) : new Set());
    setSelectedState(new Set());
    setAnchor(null);
    setClipboard(null);
  }

  // Persiste l'expansion.
  useEffect(() => {
    if (!folderPath) return;
    saveExpanded(folderPath, expanded);
  }, [folderPath, expanded]);

  // Charge le contenu d'un dossier déplié qui n'est pas encore en cache.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const missing = [...expanded].filter(p => isAncestorOrSelf(p, root) && cache[p] === undefined);
    if (missing.length === 0) return;
    void Promise.all(missing.map(async dir => [dir, await loadDir(dir)] as const)).then(pairs => {
      if (cancelled) return;
      setCache(prev => {
        const next = { ...prev };
        for (const [dir, kids] of pairs) next[dir] = kids;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [expanded, root, cache, loadDir]);

  // ── Expansion ───────────────────────────────────────────────────────────────

  const toggleExpanded = useCallback((path: string, open?: boolean) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const willOpen = open ?? !next.has(path);
      if (willOpen) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const setExpandedAll = useCallback((open: boolean) => {
    setExpanded(prev => {
      if (!open) return new Set();
      // Tout déplier : on garde les dossiers déjà connus (cache).
      const next = new Set(prev);
      Object.values(cache).flat().forEach(e => { if (e.is_dir) next.add(e.path); });
      return next;
    });
  }, [cache]);

  // ── Sélection ───────────────────────────────────────────────────────────────

  const rows = useMemo(
    () => flattenTree(rootEntries, expanded, p => cache[p]),
    [rootEntries, expanded, cache],
  );

  const select = useCallback((path: string, mods: SelectMods) => {
    const visible = rows.map(r => r.entry.path);
    const { selected: next, anchor: a } = nextSelection(visible, selected, anchor, path, mods);
    setSelectedState(next);
    setAnchor(a);
  }, [rows, selected, anchor]);

  const setSelected = useCallback((paths: string[]) => {
    setSelectedState(new Set(paths));
    setAnchor(paths[0] ?? null);
  }, []);

  // ── Drag & drop interne ─────────────────────────────────────────────────────

  const beginDrag = useCallback((paths: string[]) => { dragPathsRef.current = paths; setDragPaths(paths); }, []);
  const endDrag = useCallback(() => { dragPathsRef.current = []; setDragPaths([]); setDropTarget(null); }, []);

  const dropInto = useCallback(async (targetDir: string, sources?: string[]): Promise<ops.OpResult[]> => {
    // Les sources sont passées explicitement par l'appelant (session de drag) :
    // cela évite une dépendance à `dragPaths` qui recréait la fonction à chaque
    // mouvement et ré-attachait les écouteurs globaux au milieu du drag.
    const list = sources ?? dragPathsRef.current;
    endDrag();
    if (!opsCtxRef.current || list.length === 0) return [];
    const results = await ops.moveInto(opsCtxRef.current, list, targetDir);
    followMoved(results);
    return results;
  }, [endDrag, followMoved]);

  /** Drop de fichiers venus de l'OS (Finder/Explorer) → copiés dans la cible. */
  const importInto = useCallback(async (targetDir: string, externalPaths: string[]) => {
    if (!opsCtxRef.current || externalPaths.length === 0) return;
    await ops.copyInto(opsCtxRef.current, externalPaths, targetDir);
  }, []);

  // ── Presse-papier ───────────────────────────────────────────────────────────

  const copyToClipboard = useCallback((paths: string[], mode: "copy" | "cut") => {
    setClipboard(paths.length ? { mode, paths } : null);
  }, []);

  const canPaste = !!clipboard && clipboard.paths.length > 0;

  const pasteInto = useCallback(async (targetDir: string) => {
    if (!opsCtxRef.current || !clipboard || clipboard.paths.length === 0) return;
    if (clipboard.mode === "cut") {
      await ops.moveInto(opsCtxRef.current, clipboard.paths, targetDir);
      setClipboard(null);
    } else {
      await ops.copyInto(opsCtxRef.current, clipboard.paths, targetDir);
    }
  }, [clipboard]);

  // ── Renommage inline ────────────────────────────────────────────────────────

  const startRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenamingPath(path);
  }, []);
  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const commitRename = useCallback(async (from: string, newName: string) => {
    setRenamingPath(null);
    if (!opsCtxRef.current) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === baseName(from)) return;
    const res = await ops.renameEntry(opsCtxRef.current, from, trimmed);
    if (res.ok && res.path) {
      // Suit le renommage : sélection + expansion + onglet éventuel.
      setSelectedState(new Set([res.path]));
      setAnchor(res.path);
      if (expanded.has(from)) toggleExpanded(from, false);
    }
  }, [expanded, toggleExpanded]);

  // ── Création inline ─────────────────────────────────────────────────────────

  const startCreate = useCallback((parentPath: string, kind: "file" | "folder", initialName?: string) => {
    setRenamingPath(null);
    // Auto-déplie le dossier cible pour que l'input soit visible.
    toggleExpanded(parentPath, true);
    setPendingCreate({ parentPath, kind, initialName });
  }, [toggleExpanded]);
  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(async (parentPath: string, kind: "file" | "folder", name: string) => {
    setPendingCreate(null);
    if (!opsCtxRef.current) return;
    const res = kind === "folder"
      ? await ops.createFolder(opsCtxRef.current, parentPath, name)
      : await ops.createFile(opsCtxRef.current, parentPath, name);
    if (res.ok && res.path) {
      toggleExpanded(parentPath, true);
      setSelectedState(new Set([res.path]));
      setAnchor(res.path);
      if (kind === "file") onFileOpen(res.path);
    } else if (res.error) {
      // Réouvre l'input pour laisser l'utilisateur corriger (jamais de perte).
      setPendingCreate({ parentPath, kind, initialName: name });
    }
  }, [toggleExpanded, onFileOpen]);

  const refresh = useCallback(() => { void reloadAll(); }, [reloadAll]);

  return {
    rootName, rows, loading, gitDecorations,
    expanded, selected, anchor, clipboard, dragPaths, dropTarget,
    renamingPath, pendingCreate,
    toggleExpanded, setExpandedAll, select, setSelected,
    beginDrag, endDrag, setDropTarget, dropInto, importInto,
    copyToClipboard, pasteInto, canPaste,
    startRename, cancelRename, commitRename,
    startCreate, cancelCreate, commitCreate,
    refresh,
  };
}
