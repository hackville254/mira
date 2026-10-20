import { useState, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, readFileBase64, writeFile } from "../lib/fs";
import { fileKindOf, imageMimeOf, mediaMimeOf, isBinaryReadable } from "../lib/fileKind";
import { applyLspEdits, type FileEdits } from "../lib/lspEdits";
import type { Tab } from "../components/editor/TabBar";
import { useToast } from "../components/ui/Toast";

export function useTabs() {
  const { showToast } = useToast();

  const [tabs, setTabs]               = useState<Tab[]>([]);
  const [activeTab, setActiveTab]     = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  /** Contenu binaire (image/PDF) en base64 par chemin, séparé du texte éditable. */
  const [binaryData, setBinaryData] = useState<Record<string, { base64: string; mime: string }>>({});
  const [jumpRequest, setJumpRequest] = useState<{ path: string; line: number; col: number; key: number } | null>(null);
  const [fileTreeVersion, setFileTreeVersion] = useState(0);
  const untitledCount = useRef(0);

  // Always-current snapshots used by callbacks that fire before re-render
  const activeTabRef      = useRef<string | null>(activeTab);
  const fileContentsRef   = useRef<Record<string, string>>(fileContents);
  const tabsRef           = useRef<Tab[]>(tabs);
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current values visible to pre-render callbacks
  activeTabRef.current    = activeTab;
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current values visible to pre-render callbacks
  fileContentsRef.current = fileContents;
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current values visible to pre-render callbacks
  tabsRef.current         = tabs;

  useEffect(() => {
    if (!activeTab || activeTab.startsWith('__')) return;
    // Fichier binaire affichable (image/PDF) : chargé en base64, hors du cache
    // texte éditable.
    if (isBinaryReadable(activeTab)) {
      if (binaryData[activeTab] !== undefined) return;
      const kind = fileKindOf(activeTab);
      const mime = kind === 'image' ? imageMimeOf(activeTab) : mediaMimeOf(activeTab);
      readFileBase64(activeTab)
        .then(base64 => setBinaryData(prev => ({ ...prev, [activeTab]: { base64, mime } })))
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          const name = activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab;
          showToast(`Failed to read ${name}: ${msg}`, 'error');
          setFileErrors(prev => ({ ...prev, [activeTab]: msg }));
        });
      return;
    }
    // Fichier binaire sans lecteur dédié : pas de lecture, on affiche un message.
    if (fileKindOf(activeTab) === 'binary') return;
    if (fileContents[activeTab] !== undefined) return;
    readFile(activeTab)
      .then(content => setFileContents(prev => ({ ...prev, [activeTab]: content })))
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        const name = activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab;
        showToast(`Failed to read ${name}: ${msg}`, 'error');
        setFileErrors(prev => ({ ...prev, [activeTab]: msg }));
        setFileContents(prev => ({ ...prev, [activeTab]: '' }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast is stable; including it would re-run this file-load effect needlessly
  }, [activeTab, fileContents, binaryData]);

  function openTab(path: string) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    setTabs(prev => prev.find(t => t.path === path) ? prev : [...prev, { path, name, isDirty: false }]);
    setActiveTab(path);
  }

  function openTabAtLine(path: string, line: number, col: number) {
    openTab(path);
    setJumpRequest({ path, line, col, key: Date.now() });
  }

  function closeTab(path: string) {
    setTabs(prev => {
      const idx  = prev.findIndex(t => t.path === path);
      const next = prev.filter(t => t.path !== path);
      if (activeTab === path) {
        setActiveTab((next[idx] ?? next[idx - 1] ?? null)?.path ?? null);
      }
      return next;
    });
  }

  function handleNewFile() {
    untitledCount.current += 1;
    const id = `__untitled__${untitledCount.current}`;
    setTabs(prev => [...prev, { path: id, name: `Untitled-${untitledCount.current}`, isDirty: true, isUntitled: true }]);
    setFileContents(prev => ({ ...prev, [id]: '' }));
    setActiveTab(id);
  }

  function handleEditorChange(path: string, value: string) {
    setFileContents(prev => ({ ...prev, [path]: value }));
    setTabs(prev => prev.map(t => t.path === path ? { ...t, isDirty: true } : t));
  }

  function openAiDiffTab(data: {
    approvalId: string;
    filePath: string;
    proposedContent: string;
    originalContent: string;
    approve: () => void;
    reject: () => void;
  }) {
    const tabPath  = `__diff__${data.approvalId}`;
    const fileName = data.filePath.split(/[\\/]/).filter(Boolean).pop() ?? data.filePath;
    const approveAndRefresh = () => {
      data.approve();
      setFileContents(prev => ({ ...prev, [data.filePath]: data.proposedContent }));
      setTabs(prev => prev.map(t => t.path === data.filePath ? { ...t, isDirty: false } : t));
      setFileTreeVersion(v => v + 1);
    };
    setTabs(prev => prev.find(t => t.path === tabPath) ? prev : [...prev, {
      path: tabPath,
      name: `${fileName} (diff)`,
      isDirty: false,
      kind: 'ai-diff' as const,
      filePath: data.filePath,
      originalContent: data.originalContent,
      proposedContent: data.proposedContent,
      approve: approveAndRefresh,
      reject: data.reject,
    }]);
    setActiveTab(tabPath);
  }

  /**
   * Rafraîchit, pour un lot de chemins, l'état de l'éditeur après une action
   * EXTERNE (typ. « Undo all » / « revert » de l'agent) : les fichiers revenus
   * sur disque sont relus, les fichiers supprimés voient leur onglet fermé et
   * l'arbre est rafraîchi. On efface aussi les erreurs de lecture périmées.
   *
   * Un onglet non sauvegardé n'est PAS écrasé (aucune perte silencieuse). Sans
   * ce rafraîchissement, l'éditeur continuerait d'afficher le contenu que
   * l'agent venait justement d'annuler — d'où l'impression de « bypass ».
   */
  async function applyExternalFileChanges(paths: string[]): Promise<void> {
    const unique = [...new Set(paths)];
    for (const path of unique) {
      if (!path || path.startsWith('__')) continue;
      const isOpen = tabsRef.current.some(t => t.path === path);
      const wasLoaded = fileContentsRef.current[path] !== undefined;
      if (!isOpen && !wasLoaded) continue;
      if (fileKindOf(path) === 'binary') continue;

      let content: string | null = null;
      try {
        content = await readFile(path);
      } catch {
        content = null; // fichier supprimé (ou illisible) → on ferme l'onglet
      }

      if (content === null) {
        setTabs(prev => prev.filter(t => t.path !== path));
        setFileContents(prev => { const { [path]: _gone, ...rest } = prev; return rest; });
        setFileErrors(prev => { const { [path]: _err, ...rest } = prev; return rest; });
        continue;
      }

      // Ne jamais écraser des modifications locales non sauvegardées.
      if (tabsRef.current.some(t => t.path === path && t.isDirty)) continue;

      setFileContents(prev => ({ ...prev, [path]: content as string }));
      setTabs(prev => prev.map(t => t.path === path ? { ...t, isDirty: false } : t));
      setFileErrors(prev => { const { [path]: _err, ...rest } = prev; return rest; });
    }
    setFileTreeVersion(v => v + 1);
  }

  /**
   * Ouvre (ou réactive) un onglet « Git diff » (lecture seule) comparant
   * `filePath` à sa version HEAD. Une seule instance par fichier.
   */
  function openGitDiffTab(filePath: string, repoPath: string) {
    const tabPath = `__gitdiff__${filePath}`;
    const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    setTabs(prev => prev.find(t => t.path === tabPath)
      ? prev
      : [...prev, {
          path: tabPath,
          name: `${fileName} (git diff)`,
          isDirty: false,
          kind: 'git-diff' as const,
          filePath,
          originalContent: repoPath,
        }]
    );
    setActiveTab(tabPath);
  }

  function openPreviewTab() {
    const tabPath = '__preview__';
    setTabs(prev => prev.find(t => t.path === tabPath)
      ? prev
      : [...prev, { path: tabPath, name: 'Live Preview', isDirty: false, kind: 'preview' as const }]
    );
    setActiveTab(tabPath);
  }

  /**
   * Ouvre (ou réactive) un onglet de prévisualisation Markdown pour `filePath`.
   * L'onglet est identifié par `__mdpreview__<filePath>` : une seule instance par
   * fichier. Le rendu lit le contenu courant via `fileContents[filePath]`, donc
   * l'aperçu reste synchronisé avec les modifications de l'éditeur.
   */
  function openMarkdownPreviewTab(filePath: string) {
    const tabPath = `__mdpreview__${filePath}`;
    const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    setTabs(prev => prev.find(t => t.path === tabPath)
      ? prev
      : [...prev, { path: tabPath, name: `${fileName} (preview)`, isDirty: false, kind: 'markdown-preview' as const, filePath }]
    );
    setActiveTab(tabPath);
  }

  async function handleSave(path: string, contentOverride?: string) {
    const content = contentOverride ?? fileContentsRef.current[path];
    if (content === undefined) return;
    const tab = tabs.find(t => t.path === path);
    if (tab?.isUntitled) {
      const dest = await save({ defaultPath: tab.name });
      if (!dest) return;
      await writeFile(dest, content);
      const newName = dest.split(/[\\/]/).filter(Boolean).pop() ?? dest;
      setTabs(prev => prev.map(t => t.path === path ? { ...t, path: dest, name: newName, isDirty: false, isUntitled: false } : t));
      setActiveTab(dest);
      setFileContents(prev => { const next = { ...prev, [dest]: content }; delete next[path]; return next; });
    } else {
      await writeFile(path, content);
      setTabs(prev => prev.map(t => t.path === path ? { ...t, isDirty: false } : t));
    }
  }

  async function handleSaveAs() {
    const path = activeTabRef.current;
    if (!path) return;
    const content = fileContentsRef.current[path];
    if (content === undefined) return;
    const tab  = tabs.find(t => t.path === path);
    const dest = await save({ defaultPath: tab?.name });
    if (!dest) return;
    const newName = dest.split(/[\\/]/).filter(Boolean).pop() ?? dest;
    await writeFile(dest, content);
    setTabs(prev => prev.map(t => t.path === path ? { ...t, path: dest, name: newName, isDirty: false, isUntitled: false } : t));
    setActiveTab(dest);
    setFileContents(prev => { const next = { ...prev, [dest]: content }; if (dest !== path) delete next[path]; return next; });
  }

  async function handleSaveAll() {
    const dirty = tabs.filter(t => t.isDirty && !t.isUntitled);
    for (const tab of dirty) await handleSave(tab.path);
  }

  /**
   * Applique des éditions LSP (rename / code action) touchant d'autres fichiers
   * que l'éditeur courant. Les fichiers ouverts sont modifiés en mémoire (et
   * marqués comme modifiés) ; les fichiers fermés sont patchés directement sur
   * le disque, comme le fait VS Code.
   */
  async function applyWorkspaceEdits(edits: FileEdits[]): Promise<void> {
    for (const { path, edits: fileEdits } of edits) {
      const open = fileContentsRef.current[path];
      if (open !== undefined) {
        const next = applyLspEdits(open, fileEdits);
        if (next === open) continue;
        setFileContents(prev => ({ ...prev, [path]: next }));
        setTabs(prev => prev.map(t => t.path === path ? { ...t, isDirty: true } : t));
      } else {
        try {
          const current = await readFile(path);
          const next = applyLspEdits(current, fileEdits);
          if (next === current) continue;
          await writeFile(path, next);
          setFileTreeVersion(v => v + 1);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
          showToast(`Failed to update ${name}: ${msg}`, 'error');
        }
      }
    }
  }

  /**
   * Recharge depuis le disque le contenu des fichiers ouverts après une action
   * externe (ex: replace in files). Les fichiers non ouverts sont ignorés.
   * Un onglet comportant des modifications non sauvegardées n'est PAS écrasé,
   * pour éviter une perte de données silencieuse. L'utilisateur devra
   * sauvegarder ou fermer l'onglet avant.
   */
  async function reloadFilesFromDisk(paths: string[]): Promise<void> {
    const dirty = new Set(tabsRef.current.filter(t => t.isDirty).map(t => t.path));
    for (const path of paths) {
      if (fileContentsRef.current[path] === undefined) continue;
      if (fileKindOf(path) === 'binary') continue;
      if (dirty.has(path)) continue; // modifications locales en cours : ne pas écraser
      try {
        const content = await readFile(path);
        setFileContents(prev => ({ ...prev, [path]: content }));
        setTabs(prev => prev.map(t => t.path === path ? { ...t, isDirty: false } : t));
      } catch {
        // Fichier supprimé ou illisible : on laisse l'état courant.
      }
    }
  }

  return {
    tabs, setTabs,
    activeTab, setActiveTab,
    fileContents, setFileContents,
    binaryData,
    fileErrors,
    jumpRequest,
    fileTreeVersion,
    activeTabRef,
    fileContentsRef,
    tabsRef,
    openTab, openTabAtLine, closeTab,
    handleNewFile, handleEditorChange, openAiDiffTab, openPreviewTab, openMarkdownPreviewTab, openGitDiffTab,
    handleSave, handleSaveAs, handleSaveAll, applyWorkspaceEdits, reloadFilesFromDisk,
    applyExternalFileChanges,
  };
}
