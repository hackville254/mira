import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import Onboarding from "./components/onboarding/Onboarding";
import TabBar from "./components/editor/TabBar";
import EditorArea from "./components/editor/EditorArea";
import type { EditorHandle, EditorContext } from "./components/editor/Editor";
import StatusBar from "./components/StatusBar";
import TerminalPanel, { type TerminalPanelHandle } from "./components/terminal/TerminalPanel";
import CommandPalette from "./components/palette/CommandPalette";
import AiPanel from "./components/ai/AiPanel";
import AgentModeView from "./components/ai/AgentModeView";
import SettingsPanel from "./components/settings/SettingsPanel";
import DebugToolbar from "./components/DebugToolbar";
import { setSetting, pushRecentProject } from "./lib/settings";
import { useToast } from "./components/ui/Toast";
import { streamText } from "ai";
import { buildLanguageModel } from "./lib/agent/providers";
import { loadApiKey, resolveDefaultModel, resolveDefaultProvider } from "./lib/secrets";
import type { AiCompletionFn } from "./lib/aiAutocomplete";
import { getBranch } from "./lib/git";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { languageLabel } from "./components/editor/languageSupport";
import type { MissingServerInfo } from "./lib/lspCm6";
import { invalidateLspClient } from "./lib/lspCm6";
import { resolveRunConfig, trustWorkspace } from "./lib/runConfigStore";
import { pickTaskForFile, substituteArgs } from "./lib/runTasks";
import { useWorkspace } from "./context/WorkspaceContext";
import { useMobileProject } from "./lib/mobileFrameworks";
import { useDebugContext } from "./context/DebugContext";
import { useDiagnostics } from "./context/DiagnosticsContext";
import { useExtensions, setHostDelegate, createDefaultHostServices } from "./context/ExtensionsContext";
import { consentStatus, requiredCapabilities } from "./lib/extensions/permissions";
import { readExtensionManifest } from "./lib/extensions";
import { CommandContext } from "./context/CommandContext";
import { useTabs } from "./hooks/useTabs";
import { useAutoSave } from "./hooks/useAutoSave";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";
import { registerCommands, type RuntimeCommand } from "./lib/commands/registry";
import { setActiveEditor } from "./lib/commands/editorBridge";
import { outlineFromLsp, outlineFromText, languageIdOf, hasLspForFile, type OutlineSymbol } from "./lib/outline";
import type { FileEdits } from "./lib/lspEdits";

function App() {
  const { folderPath, setFolderPath } = useWorkspace();
  const mobileFrameworks = useMobileProject(folderPath);
  const diagnostics = useDiagnostics();
  const [onboardingDone, setOnboardingDone] = useState(
    () => localStorage.getItem('origin-onboarding') === 'true'
  );

  const {
    tabs, setTabs: _setTabs,
    activeTab, setActiveTab,
    fileContents,
    binaryData,
    fileErrors,
    jumpRequest,
    fileTreeVersion,
    activeTabRef,
    fileContentsRef,
    tabsRef,
    openTab, openTabAtLine, closeTab,
    handleNewFile, handleEditorChange, openAiDiffTab, openMarkdownPreviewTab,
    handleSave, handleSaveAs, handleSaveAll, applyWorkspaceEdits, reloadFilesFromDisk,
    applyExternalFileChanges,
  } = useTabs();

  // Sauvegarde automatique (parité VS Code `files.autoSave`) : lit les snapshots
  // toujours à jour de useTabs et réécrit les onglets modifiés selon le mode choisi.
  useAutoSave({ tabsRef, fileContentsRef, activeTabRef, handleSave });

  const {
    sidebarOpen, setSidebarOpen,
    aiPanelOpen, setAiPanelOpen,
    terminalOpen, setTerminalOpen,
    terminalHeight, setTerminalHeight,
    appMode, setAppMode,
  } = useWorkspacePersistence();

  // Once the terminal has been opened, keep it mounted so PTY sessions survive toggle.
  const [terminalMounted, setTerminalMounted] = useState(terminalOpen);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-way latch: mount terminal once opened
  useEffect(() => { if (terminalOpen) setTerminalMounted(true); }, [terminalOpen]);

  // Auto-hide sidebars when entering live preview; restore on exit.
  // Auto-hide all panels when entering live preview; restore on exit.
  const prePreviewPanels = useRef<{ sidebarOpen: boolean; aiPanelOpen: boolean; terminalOpen: boolean } | null>(null);
  useEffect(() => {
    if (activeTab === '__preview__') {
      prePreviewPanels.current = { sidebarOpen, aiPanelOpen, terminalOpen };
      setSidebarOpen(false);
      setAiPanelOpen(false);
      setTerminalOpen(false);
    } else if (prePreviewPanels.current !== null) {
      setSidebarOpen(prePreviewPanels.current.sidebarOpen);
      setAiPanelOpen(prePreviewPanels.current.aiPanelOpen);
      setTerminalOpen(prePreviewPanels.current.terminalOpen);
      prePreviewPanels.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to activeTab transitions; panel state is read intentionally fresh
  }, [activeTab]);

  const debugCtx = useDebugContext();

  const { showToast } = useToast();
  const editorRef      = useRef<EditorHandle>(null);
  // Split editor : second groupe d'onglets (panneau droit). `null` = pas de split.
  const splitEditorRef = useRef<EditorHandle>(null);
  const [splitTab, setSplitTab] = useState<string | null>(null);
  const terminalRef    = useRef<TerminalPanelHandle>(null);
  const pendingDiffRef = useRef<{ code: string; targetPath: string } | null>(null);
  const [pendingDiffTick, setPendingDiffTick] = useState(0);
  // Incrémenté après l'installation d'un serveur LSP : force les éditeurs à
  // recréer leur extension LSP (activation « zéro action » de la complétion).
  const [lspGeneration, setLspGeneration] = useState(0);
  const [_zoom,          setZoom]          = useState(1.0);
  const [pinnedContext,  setPinnedContext]  = useState<EditorContext | null>(null);
  const [cursorPositions, setCursorPositions] = useState<Record<string, { line: number; col: number }>>({});
  // Ligne du haut visible par fichier — alimente la synchronisation du scroll de
  // la preview Markdown (rapport ligne visible / total).
  const [topLines, setTopLines] = useState<Record<string, number>>({});
  const [gitBranch,      setGitBranch]     = useState<string | null>(null);
  const [paletteOpen,    setPaletteOpen]   = useState(false);
  const [paletteMode,    setPaletteMode]   = useState<'quickopen' | 'command' | 'line' | 'symbol' | 'workspace-symbol'>('command');
  const [paletteSymbols, setPaletteSymbols] = useState<OutlineSymbol[]>([]);
  const [settingsOpen,   setSettingsOpen]  = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  // Apparence de l'éditeur — pilotée par les commandes « Toggle … » de la palette.
  const [minimap,            setMinimap]            = useState(true);
  const [stickyScroll,       setStickyScroll]       = useState(true);
  const [bracketColorization, setBracketColorization] = useState(true);

  // ── Level-2 extension host: publish the app's services as a HostDelegate.
  // App.tsx owns the workspace/editor/toast wiring, so it builds the delegate
  // here; the ExtensionsProvider reads it lazily. File ops are still confined
  // to the workspace root by the host before they reach these functions.
  const { extensions, activate, reload: reloadExtensions } = useExtensions();
  useEffect(() => {
    setHostDelegate({
      getWorkspaceRoot: () => folderPath,
      ...createDefaultHostServices(),
      getActiveEditor: () => {
        const path = activeTabRef.current;
        if (!path || path.startsWith("__")) return null;
        const text = fileContentsRef.current[path];
        if (text === undefined) return null;
        const base = path.split(/[\\/]/).pop() ?? path;
        const dot = base.lastIndexOf(".");
        const extId = dot > 0 ? base.slice(dot + 1) : "";
        return { uri: `file://${path}`, path, languageId: extId, getText: () => text };
      },
      notify: (kind, message) => showToast(message, kind === "error" ? "error" : "info"),
      // Extension "open" of a file routes through the app's own tab opener.
      executeCommand: async (id, args) => {
        const { executeCommand } = await import("./lib/extensions/registry");
        return executeCommand(id, ...args);
      },
      // Read-only metadata for `vscode.extensions.*`. The real `package.json`
      // is exposed (not a synthetic stub) because extensions inspect their own
      // `contributes` tree synchronously at module load.
      getExtensionInfo: async (id) => {
        const ext = extensions.find((e) => e.id === id || e.name === id);
        if (!ext) return undefined;
        const manifest = await readExtensionManifest(ext.id);
        return {
          id: ext.id,
          extensionPath: ext.path,
          isActive: true,
          packageJSON: manifest ?? {
            name: ext.name,
            displayName: ext.display_name,
            publisher: ext.publisher,
            version: ext.version,
            description: ext.description,
          },
        };
      },
      getInstalledExtensions: async () =>
        Promise.all(
          extensions.map(async (ext) => {
            const manifest = await readExtensionManifest(ext.id);
            return {
              id: ext.id,
              extensionPath: ext.path,
              isActive: true,
              packageJSON: manifest ?? {
                name: ext.name,
                displayName: ext.display_name,
                publisher: ext.publisher,
                version: ext.version,
                description: ext.description,
              },
            };
          }),
        ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-publish so the delegate's getWorkspaceRoot sees the current folder
  }, [folderPath, showToast, openTab, extensions]);

  // Auto-activate extensions on load whose code is already consented. Nothing
  // runs without prior consent (consentStatus gates it); errors surface in the
  // Extensions panel rather than blocking the app.
  useEffect(() => {
    for (const ext of extensions) {
      if (!ext.main) continue;
      const required = requiredCapabilities({ main: ext.main, commands: ext.commands, activation_events: ext.activation_events });
      if (required.length === 0) continue;
      if (consentStatus(ext.id, required).granted) {
        void activate(ext).catch(() => { /* surfaced in the panel record */ });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when the installed set changes
  }, [extensions]);

  // Stable async-generator callback for AI inline autocomplete.
  // Reads localStorage at call time so model/provider/enabled changes take effect immediately.
  const getAiCompletion = useMemo<AiCompletionFn>(() => {
    return async function* (prefix, suffix, signal) {
      if (localStorage.getItem('origin-editor-ai-autocomplete') === 'false') return;
      // CUE › Tab-Cue : coupe réellement les requêtes de complétion inline.
      if (localStorage.getItem('origin-cue-tab') === 'false') return;
      const providerId = await resolveDefaultProvider('anthropic');
      const modelId    = await resolveDefaultModel('claude-haiku-4-5-20251001');
      const apiKey = await loadApiKey(providerId);
      const LOCAL_IDS = ['ollama', 'lmstudio', 'vllm'];
      if (!apiKey && !LOCAL_IDS.includes(providerId)) return;
      const model = buildLanguageModel(providerId, modelId, apiKey ?? '');
      const result = streamText({
        model,
        system: [
          'You perform fill-in-the-middle code completion.',
          'You receive PREFIX (code before cursor) and SUFFIX (code after cursor).',
          'Your output is inserted EXACTLY at the cursor. PREFIX + your_output + SUFFIX must form valid, syntactically-correct code.',
          'Output the next chunk you can predict with high confidence. Stop when the next decision becomes genuinely ambiguous.',
          'Hard rules:',
          '1. NEVER repeat any text already in PREFIX or SUFFIX.',
          '2. NEVER write code that belongs after SUFFIX.',
          '3. Match surrounding indentation, quoting, and naming conventions exactly.',
          '4. Output empty string when no confident completion exists — never guess.',
          '5. Output format: raw insertion text only. No markdown fences. No commentary.',
        ].join('\n'),
        prompt: `PREFIX:\n<<<\n${prefix}\n>>>\n\nSUFFIX:\n<<<\n${suffix}\n>>>\n\nOutput the text to insert at the cursor.`,
        abortSignal: signal,
      });
      for await (const chunk of result.textStream) yield chunk;
    };
  }, []); // Empty deps — reads localStorage lazily at call time

  // Persist folderPath to Tauri store (WorkspaceContext handles localStorage)
  useEffect(() => { setSetting('workspace.folder', folderPath ?? ''); }, [folderPath]);

  // Refresh git branch on folder change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- guard reset when no folder is open
    if (!folderPath) { setGitBranch(null); return; }
    getBranch(folderPath).then(setGitBranch).catch(() => setGitBranch(null));
  }, [folderPath]);

  // Poke CodeMirror + xterm to re-measure after window geometry changes
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    const notify = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      });
    };
    const win = getCurrentWindow();
    win.onResized(notify).then(fn => unlisteners.push(fn));
    win.listen('tauri://resize', notify).then(fn => unlisteners.push(fn));
    window.visualViewport?.addEventListener('resize', notify);
    return () => {
      cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener('resize', notify);
      unlisteners.forEach(fn => fn());
    };
  }, []);

  // Check for updates once on startup; show a persistent toast if one is available.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  useEffect(() => {
    checkForUpdate().then(async (update) => {
      if (!update) return;
      showToast(`Update available — v${update.version}`, 'info', {
        label: 'Install & Restart',
        onClick: async () => {
          try {
            showToast('Downloading update...', 'info');
            await update.downloadAndInstall();
            await relaunch();
          } catch {
            showToast('Update failed. Try again later.', 'error');
          }
        },
      });
    }).catch(() => { /* offline or no update endpoint configured */ });
  }, []);

  // Apply a queued diff once the target tab is active and its content is loaded.
  // pendingDiffTick is incremented whenever a new pending diff is enqueued so the
  // effect fires even when activeTab and fileContents haven't changed (already-active
  // tab edge case where editorRef.current was transiently null at enqueue time).
  useEffect(() => {
    const pending = pendingDiffRef.current;
    if (!pending) return;
    if (activeTab !== pending.targetPath) return;
    if (fileContents[pending.targetPath] === undefined) return;
    if (!editorRef.current) return;
    pendingDiffRef.current = null;
    editorRef.current.showDiff(pending.code, fileContents[pending.targetPath]);
  }, [activeTab, fileContents, pendingDiffTick]);

  // Wire the debug navigation callback so DebugContext can open/jump to a paused file.
  useEffect(() => {
    debugCtx.setNavigationCallback(openTabAtLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debugCtx is stable; only re-wire when the callback changes
  }, [openTabAtLine]);

  // Push breakpoint + paused-line state into the editor whenever debug session changes.
  useEffect(() => {
    if (!activeTab || activeTab.startsWith('__')) return;
    const lines = (debugCtx.session.breakpoints.get(activeTab) ?? []).map(e => e.line);
    const topFrame = debugCtx.session.stackFrames[0];
    const pausedLine =
      topFrame?.source?.path === activeTab ? topFrame.line : null;
    editorRef.current?.syncBreakpoints(lines, pausedLine);
  }, [activeTab, debugCtx.session.breakpoints, debugCtx.session.stackFrames]);

  // Format-on-save : formate le document actif via le serveur LSP avant écriture
  // (désactivable dans Réglages > General). Le contenu formaté est relu depuis la
  // vue CodeMirror pour rester synchronisé avec les éditions dispatchées.
  async function saveActiveFormatted() {
    const path = activeTabRef.current;
    if (!path) return;
    const formatOnSave = localStorage.getItem('origin-editor-format-on-save') !== 'false';
    let content: string | undefined;
    if (formatOnSave && !path.startsWith('__') && editorRef.current) {
      await editorRef.current.formatDocument();
      content = editorRef.current.getContent();
    }
    await handleSave(path, content);
  }

  // Applique les éditions LSP (rename / code actions) touchant d'autres fichiers.
  function handleApplyWorkspaceEdits(edits: FileEdits[]) {
    void applyWorkspaceEdits(edits);
  }

  const { isFullscreen, toggleFullscreen } = useGlobalKeybindings({
    saveActive:        () => { void saveActiveFormatted(); },
    toggleTerminal:    () => setTerminalOpen(v => !v),
    togglePalette:     () => setPaletteOpen(v => !v),
    toggleSettings:    () => setSettingsOpen(v => !v),
    newFile:           () => handleNewFile(),
    openFile:          () => handleOpenFile(),
    closeTab:          () => { if (activeTab) closeTab(activeTab); },
    toggleSidebar:     () => setSidebarOpen(v => !v),
    toggleSplit:       () => setSplitTab(prev => (prev !== null ? null : (activeTab && !activeTab.startsWith('__') ? activeTab : null))),
    zoomIn:            () => handleZoomIn(),
    zoomOut:           () => handleZoomOut(),
    zoomReset:         () => handleZoomReset(),
    runFile:           () => { void handleRunActiveFile(); },
    startDebug:        () => { setSidebarOpen(true); },
    stopDebug:         () => debugCtx.stopSession(),
    stepOver:          () => debugCtx.stepOver?.(),
    stepInto:          () => debugCtx.stepIn?.(),
    stepOut:           () => debugCtx.stepOut?.(),
  });

  // L'input chat (et d'autres composants) peuvent demander l'ouverture des
  // Réglages : `origin-open-settings` ouvre le panneau avec l'onglet voulu.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ section?: string }>).detail;
      setSettingsSection(detail?.section);
      setSettingsOpen(true);
    }
    window.addEventListener("origin-open-settings", onOpen);
    return () => window.removeEventListener("origin-open-settings", onOpen);
  }, []);

  async function completeOnboarding() {
    localStorage.setItem('origin-onboarding', 'true');
    setOnboardingDone(true);
    await setSetting('onboarding.done', true);
  }

  async function handleOpenFolder() {
    const result = await open({ directory: true, multiple: false });
    if (!result) return;
    const path = result as string;
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    await pushRecentProject({ path, name });
    setFolderPath(path);
  }

  async function handleOpenFile() {
    const result = await open({ multiple: false });
    if (!result) return;
    openTab(result as string);
  }

  function handleOpenProject(path: string) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    pushRecentProject({ path, name }).catch(() => { /* store indisponible : on ouvre quand même */ });
    setFolderPath(path);
  }

  /**
   * Clone un dépôt distant puis l'ouvre. Le client choisit l'URL puis le dossier
   * parent ; le sous-dossier de destination est dérivé du nom du dépôt et validé
   * côté Rust (refus d'écraser un dossier non vide, filtrage des schémas git
   * dangereux type `ext::`).
   */
  async function handleCloneRepo() {
    const parent = await open({ directory: true, multiple: false, title: "Choose a parent folder for the clone" });
    if (!parent) return;
    const url = window.prompt("Git repository URL (https, ssh or git):");
    if (!url || !url.trim()) return;
    const trimmed = url.trim();
    // Nom de dépôt dérivé de l'URL, sans le suffixe `.git`.
    const repoName =
      trimmed.replace(/\.git$/, "").split(/[\\/:]/).filter(Boolean).pop() ?? "repository";
    if (!repoName || repoName.startsWith("-")) {
      showToast("Invalid repository URL.", "error");
      return;
    }
    const sep = (parent as string).includes("\\") && !(parent as string).includes("/") ? "\\" : "/";
    const dest = `${parent}${(parent as string).endsWith(sep) ? "" : sep}${repoName}`;
    try {
      showToast(`Cloning ${repoName}…`, "info");
      const cloned = await invoke<string>("git_clone", { url: trimmed, dest });
      const name = cloned.split(/[\\/]/).filter(Boolean).pop() ?? cloned;
      await pushRecentProject({ path: cloned, name });
      setFolderPath(cloned);
      showToast(`Cloned ${name}.`, "success");
    } catch (e) {
      showToast(`Clone failed: ${String(e)}`, "error");
    }
  }

  function handleApplyCode(code: string, filePath?: string, _ctx?: EditorContext) {
    const currentActiveTab    = activeTabRef.current;
    const currentFileContents = fileContentsRef.current;
    const targetPath = filePath ?? currentActiveTab;
    if (!targetPath) return;

    if (
      targetPath === currentActiveTab &&
      editorRef.current &&
      currentFileContents[targetPath] !== undefined
    ) {
      editorRef.current.showDiff(code, currentFileContents[targetPath]);
    } else {
      pendingDiffRef.current = { code, targetPath };
      openTab(targetPath);
      setPendingDiffTick(v => v + 1);
    }
  }

  function handleNewWindow() {
    new WebviewWindow(`mira-${Date.now()}`, {
      url: '/',
      title: 'Mira',
      width: 1280,
      height: 800,
      decorations: false,
      backgroundColor: '#0a0a0a',
    });
  }

  function handleZoomIn() {
    setZoom(prev => {
      const next = Math.min(+(prev + 0.1).toFixed(1), 2.0);
      document.documentElement.style.zoom = String(next);
      return next;
    });
  }

  function handleZoomOut() {
    setZoom(prev => {
      const next = Math.max(+(prev - 0.1).toFixed(1), 0.5);
      document.documentElement.style.zoom = String(next);
      return next;
    });
  }

  function handleZoomReset() {
    setZoom(1.0);
    document.documentElement.style.zoom = '1';
  }

  function handleNewTerminalTab() {
    if (!terminalOpen) setTerminalOpen(true);
    else terminalRef.current?.addTab();
  }

  // ── Serveur LSP introuvable : installation en un clic ──────────────────────
  // POLITIQUE PRODUIT : jamais de commande shell manuelle. Si le serveur est
  // installable par l'app, on propose un bouton « Installer » qui appelle
  // `lsp_install` (téléchargement vérifié côté Rust). Sinon on explique pourquoi
  // en une phrase courte (chaîne d'outils externe requise).
  async function handleMissingServer(info: MissingServerInfo) {
    if (info.needs) {
      const reason =
        info.needs === 'NEEDS_GO_TOOLCHAIN'
          ? 'Go toolchain required (install Go, then gopls via "go install")'
          : info.needs === 'NEEDS_LLVM_TOOLCHAIN'
            ? 'LLVM toolchain required (clangd ships with LLVM)'
            : 'Java toolchain required (install a JDK, then jdtls)';
      showToast(`${info.label}: ${reason}`, 'info');
      return;
    }

    showToast(`${info.label} language server not found`, 'info', {
      label: 'Install',
      onClick: () => {
        const label = info.label;
        // Progression live : Rust émet `lsp://install-progress`. Le toast se met
        // à jour en place (l'utilisateur voit le pourcentage sur un gros download).
        let unlisten: (() => void) | null = null;
        listen<{ serverId: string; phase: string; percent: number }>(
          'lsp://install-progress',
          ev => {
            if (ev.payload.serverId !== info.id) return;
            showToast(`Installing ${label}… ${ev.payload.percent}%`, 'info');
          },
        ).then(fn => { unlisten = fn; });

        invoke('lsp_install', { serverId: info.id })
          .then(() => {
            invalidateLspClient(info.id);
            setLspGeneration(g => g + 1);
            showToast(`${label} installed successfully`, 'success');
          })
          .catch((e: unknown) => {
            // Rust renvoie un JSON structuré { code, reason } : on le traduit en
            // message actionnable plutôt que d'afficher le JSON brut.
            const raw = e instanceof Error ? e.message : String(e);
            let code = '';
            let reason = '';
            try {
              const parsed = JSON.parse(raw) as { code?: string; reason?: string };
              code = parsed.code ?? '';
              reason = parsed.reason ?? '';
            } catch {
              // Message non structuré : on l'affiche tel quel.
            }
            if (reason === 'NEEDS_PYTHON') {
              showToast(
                `${label}: Python not found. Install Python 3 and try again (the server will install automatically).`,
                'error',
              );
            } else if (reason === 'NEEDS_NODE') {
              showToast(
                `${label}: Node.js not found. Install Node and try again (the server will install automatically).`,
                'error',
              );
            } else if (code === 'LSP_NOT_AUTO_INSTALLABLE') {
              showToast(`${label} cannot be installed automatically.`, 'info');
            } else {
              showToast(`Installation failed: ${raw}`, 'error');
            }
          })
          .finally(() => { unlisten?.(); });
      },
    });
  }

  // ── Run : lance la tâche adaptée au fichier actif ──────────────────────────
  // Les tâches du workspace ne sont exécutées qu'après confirmation explicite.
  const [trustPrompt, setTrustPrompt] = useState<
    { label: string; program: string; args: string[]; raw: string | null } | null
  >(null);

  function startTask(label: string, program: string, args: string[]) {
    setTerminalOpen(true);
    // Laisse le panneau se monter avant de créer l'onglet de tâche.
    setTimeout(() => terminalRef.current?.runTaskInNewTab(label, program, args), 60);
  }

  async function handleRunActiveFile() {
    if (!activeTab || activeTab.startsWith('__')) {
      showToast('No file to run', 'info');
      return;
    }
    if (!folderPath) {
      showToast('Open a folder to run tasks', 'info');
      return;
    }

    const { config, needsTrust, workspaceRaw } = await resolveRunConfig(folderPath);
    const task = pickTaskForFile(config.tasks, activeTab);
    if (!task) {
      showToast('No task configured for this file', 'info');
      return;
    }

    const ctx = { file: activeTab, workspaceFolder: folderPath };
    const args = (task.args ?? []).map(a => substituteArgs(a, ctx));

    if (needsTrust) {
      setTrustPrompt({ label: task.label, program: task.program, args, raw: workspaceRaw });
      return;
    }
    startTask(task.label, task.program, args);
  }

  // Zoom in/out/reset handled below.
  const commands = {
    sidebarOpen, onToggleSidebar: () => setSidebarOpen(v => !v),
    terminalOpen, onToggleTerminal: () => setTerminalOpen(v => !v),
    aiPanelOpen, onToggleAiPanel: () => setAiPanelOpen(v => !v),
    onSetAiPanel: (open: boolean) => setAiPanelOpen(open),
    appMode, onSetAppMode: (mode: 'ide' | 'ai') => setAppMode(mode),
    isFullscreen, onToggleFullscreen: toggleFullscreen,
    onOpenFolder: handleOpenFolder,
    onOpenFile: handleOpenFile,
    onNewFile: handleNewFile,
    onNewWindow: handleNewWindow,
    onOpenPalette: () => { setPaletteMode('command'); setPaletteOpen(true); },
    onOpenSettings: () => setSettingsOpen(true),
    onOpenProject: handleOpenProject,
    onCloneRepo: () => { void handleCloneRepo(); },
    gitBranch,
    dirtyCount: tabs.filter(t => t.isDirty).length,
    hasActiveTab: !!activeTab && !activeTab.startsWith('__diff__'),
    hasFolderOpen: !!folderPath,
    onSave: () => { void saveActiveFormatted(); },
    onSaveAs: handleSaveAs,
    onSaveAll: handleSaveAll,
    onCloseEditor: () => { if (activeTab) closeTab(activeTab); },
    onCloseFolder: () => setFolderPath(null),
    onEditorUndo: () => editorRef.current?.undo(),
    onEditorRedo: () => editorRef.current?.redo(),
    onEditorPrevFile: () => {
      if (!activeTab || tabs.length < 2) return;
      const idx = tabs.findIndex(t => t.path === activeTab);
      if (idx < 0) return;
      setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].path);
    },
    onEditorNextFile: () => {
      if (!activeTab || tabs.length < 2) return;
      const idx = tabs.findIndex(t => t.path === activeTab);
      if (idx < 0) return;
      setActiveTab(tabs[(idx + 1) % tabs.length].path);
    },
    onEditorCut: () => editorRef.current?.cut(),
    onEditorCopy: () => editorRef.current?.copy(),
    onEditorPaste: () => editorRef.current?.paste(),
    onEditorSelectAll: () => editorRef.current?.selectAll(),
    onEditorFind: () => editorRef.current?.openFind(),
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut,
    onZoomReset: handleZoomReset,
    onNewTerminalTab: handleNewTerminalTab,
    onClearTerminal: () => terminalRef.current?.clearActive(),
    onKillTerminal: () => terminalRef.current?.killActive(),
    onRunFile: handleRunActiveFile,
    onStartDebugging: () => {
      setSidebarOpen(true);
    },
    onStopDebugging: () => debugCtx.stopSession(),
    isDebugActive: debugCtx.session.status !== 'idle' && debugCtx.session.status !== 'terminated',
  };

  // ── Registry de commandes runtime ────────────────────────────────────────
  // Publie le handle de l'éditeur « actif » (split prioritaire si le focus y est)
  // pour que les commandes puissent piloter CodeMirror hors focus.
  useEffect(() => {
    // On expose en priorité le handle de l'éditeur splitté lorsqu'il existe,
    // sinon l'éditeur principal. Les commandes éditeur passent par la vue
    // CodeMirror publiée séparément par Editor (setActiveEditorView).
    if (splitTab && splitEditorRef.current) setActiveEditor(splitEditorRef.current);
    else setActiveEditor(editorRef.current);
  });

  const editorOfSplit = () => splitTab && splitEditorRef.current ? splitEditorRef.current : editorRef.current;

  // Ouvre la palette en mode « Go to Symbol » : charge les symboles du fichier
  // actif (LSP si dispo, sinon fallback regex sur le contenu en mémoire).
  const openSymbolPalette = async () => {
    const path = activeTabRef.current;
    if (!path || path.startsWith('__')) return;
    let symbols: OutlineSymbol[] = [];
    if (folderPath && hasLspForFile(path)) {
      symbols = (await outlineFromLsp(path, folderPath)) ?? [];
    }
    if (symbols.length === 0) {
      symbols = outlineFromText(fileContentsRef.current[path] ?? '', languageIdOf(path));
    }
    setPaletteSymbols(symbols);
    setPaletteMode('symbol');
    setPaletteOpen(true);
  };

  // Va à une ligne/colonne dans l'éditeur actif (mode « Go to Line »).
  const goToLineInEditor = (line: number, col: number) => {
    editorOfSplit()?.goToLine(line, col);
  };

  // Enregistre toutes les commandes du cœur de l'IDE dans la registry runtime.
  // La Command Palette et le listener global les lisent : une source unique pour
  // « quelles commandes existent et comment les exécuter ».
  useEffect(() => {
    const cmds: RuntimeCommand[] = [
      // ── File ──
      { id: 'origin.newFile',       title: 'New File',        category: 'File',  keywords: 'create untitled',  run: () => handleNewFile() },
      { id: 'origin.openFile',      title: 'Open File…',      category: 'File',  keywords: 'browse disk',      run: () => { void handleOpenFile(); } },
      { id: 'origin.openFolder',    title: 'Open Folder…',    category: 'File',  keywords: 'workspace project', run: () => { void handleOpenFolder(); } },
      { id: 'origin.save',          title: 'Save',            category: 'File',  keywords: 'write',            run: () => { void saveActiveFormatted(); } },
      { id: 'origin.saveAs',        title: 'Save As…',        category: 'File',  run: () => { void handleSaveAs(); } },
      { id: 'origin.saveAll',       title: 'Save All',        category: 'File',  run: () => { void handleSaveAll(); } },
      { id: 'origin.closeTab',      title: 'Close Editor',    category: 'File',  keywords: 'tab',              run: () => { if (activeTabRef.current) closeTab(activeTabRef.current); } },
      { id: 'origin.closeFolder',   title: 'Close Folder',    category: 'File',  run: () => setFolderPath(null) },
      { id: 'origin.newWindow',     title: 'New Window',      category: 'File',  run: () => { void handleNewWindow(); } },

      // ── Edit ──
      { id: 'origin.editorUndo',    title: 'Undo',            category: 'Edit',  run: () => editorOfSplit()?.undo() },
      { id: 'origin.editorRedo',    title: 'Redo',            category: 'Edit',  run: () => editorOfSplit()?.redo() },
      { id: 'origin.editorCut',     title: 'Cut',             category: 'Edit',  run: () => editorOfSplit()?.cut() },
      { id: 'origin.editorCopy',    title: 'Copy',            category: 'Edit',  run: () => editorOfSplit()?.copy() },
      { id: 'origin.editorPaste',   title: 'Paste',           category: 'Edit',  run: () => editorOfSplit()?.paste() },
      { id: 'origin.editorSelectAll', title: 'Select All',    category: 'Edit',  run: () => editorOfSplit()?.selectAll() },
      { id: 'origin.editorFind',    title: 'Find',            category: 'Edit',  keywords: 'search',           run: () => editorOfSplit()?.openFind() },
      { id: 'origin.editorReplace', title: 'Replace',         category: 'Edit',  keywords: 'search substitute', run: () => editorOfSplit()?.openReplace() },
      { id: 'editor.formatDocument',title: 'Format Document', category: 'Edit',  keywords: 'prettier beautify', run: () => { void editorOfSplit()?.formatDocument(); } },
      { id: 'editor.renameSymbol',  title: 'Rename Symbol',   category: 'Edit',  keywords: 'refactor f2',      run: () => editorOfSplit()?.renameSymbol() },
      { id: 'editor.quickFix',      title: 'Quick Fix…',      category: 'Edit',  keywords: 'code action lightbulb', run: () => editorOfSplit()?.showCodeActions() },
      { id: 'editor.transformToUpper', title: 'Transform to Uppercase', category: 'Edit', keywords: 'case upper', run: () => editorOfSplit()?.transformToUpper() },
      { id: 'editor.transformToLower', title: 'Transform to Lowercase', category: 'Edit', keywords: 'case lower', run: () => editorOfSplit()?.transformToLower() },
      { id: 'editor.transformToTitle', title: 'Transform to Title Case', category: 'Edit', keywords: 'case title', run: () => editorOfSplit()?.transformToTitle() },
      { id: 'editor.transformToToggleCase', title: 'Transform to Toggle Case', category: 'Edit', keywords: 'case toggle invert', run: () => editorOfSplit()?.transformToToggleCase() },
      { id: 'editor.sortLinesAsc',  title: 'Sort Lines Ascending',  category: 'Edit', keywords: 'sort order', run: () => editorOfSplit()?.sortLinesAsc() },
      { id: 'editor.sortLinesDesc', title: 'Sort Lines Descending', category: 'Edit', keywords: 'sort order', run: () => editorOfSplit()?.sortLinesDesc() },

      // ── Selection ──
      { id: 'editor.selectLine',        title: 'Select Line',              category: 'Selection', keywords: 'expand',       run: () => editorOfSplit()?.selectLine() },
      { id: 'editor.selectNextOccurrence', title: 'Select Next Occurrence', category: 'Selection', keywords: 'cmd+d word',  run: () => editorOfSplit()?.selectNextOccurrence() },
      { id: 'editor.selectAllOccurrences', title: 'Select All Occurrences', category: 'Selection', keywords: 'cmd+shift+l word', run: () => editorOfSplit()?.selectAllOccurrences() },
      { id: 'editor.addCursorBelow',    title: 'Add Cursor Below',         category: 'Selection', run: () => editorOfSplit()?.addCursorBelow() },
      { id: 'editor.addCursorAbove',    title: 'Add Cursor Above',         category: 'Selection', run: () => editorOfSplit()?.addCursorAbove() },
      { id: 'editor.addCursorToLineEnd', title: 'Add Cursors to Line Ends', category: 'Selection', run: () => editorOfSplit()?.addCursorToLineEnd() },

      // ── Lines ──
      { id: 'editor.duplicateLineUp',   title: 'Duplicate Line Up',   category: 'Lines', keywords: 'copy', run: () => editorOfSplit()?.duplicateLineUp() },
      { id: 'editor.duplicateLineDown', title: 'Duplicate Line Down', category: 'Lines', keywords: 'copy', run: () => editorOfSplit()?.duplicateLineDown() },
      { id: 'editor.moveLineUp',        title: 'Move Line Up',        category: 'Lines', run: () => editorOfSplit()?.moveLineUp() },
      { id: 'editor.moveLineDown',      title: 'Move Line Down',      category: 'Lines', run: () => editorOfSplit()?.moveLineDown() },
      { id: 'editor.deleteLines',       title: 'Delete Line',         category: 'Lines', keywords: 'cut remove', run: () => editorOfSplit()?.deleteLines() },
      { id: 'editor.insertLineBelow',   title: 'Insert Line Below',   category: 'Lines', run: () => editorOfSplit()?.insertLineBelow() },
      { id: 'editor.insertLineAbove',   title: 'Insert Line Above',   category: 'Lines', run: () => editorOfSplit()?.insertLineAbove() },
      { id: 'editor.toggleComment',     title: 'Toggle Line Comment', category: 'Lines', keywords: 'comment', run: () => editorOfSplit()?.toggleComment() },
      { id: 'editor.indentMore',        title: 'Indent Lines',        category: 'Lines', keywords: 'tab',  run: () => editorOfSplit()?.indentMore() },
      { id: 'editor.indentLess',        title: 'Outdent Lines',       category: 'Lines', keywords: 'tab',  run: () => editorOfSplit()?.indentLess() },

      // ── View ──
      { id: 'origin.toggleSidebar',  title: 'Toggle Sidebar',     category: 'View', enabled: sidebarOpen,      run: () => setSidebarOpen(v => !v) },
      { id: 'origin.toggleTerminal', title: 'Toggle Terminal',    category: 'View', enabled: terminalOpen,     run: () => setTerminalOpen(v => !v) },
      { id: 'origin.toggleSplit',    title: 'Toggle Split Editor', category: 'View', run: () => setSplitTab(prev => (prev !== null ? null : (activeTabRef.current && !activeTabRef.current.startsWith('__') ? activeTabRef.current : null))) },
      { id: 'origin.toggleAiPanel',  title: 'Toggle AI Panel',    category: 'View', run: () => setAiPanelOpen(v => !v) },
      { id: 'origin.toggleSettings', title: 'Open Settings',      category: 'View', keywords: 'preferences config', run: () => setSettingsOpen(true) },
      { id: 'origin.togglePalette',  title: 'Command Palette',    category: 'View', keywords: 'palette commands', run: () => { setPaletteMode('command'); setPaletteOpen(true); } },
      { id: 'origin.showCommands',   title: 'Show All Commands',  category: 'View', keywords: 'command palette list', run: () => { setPaletteMode('command'); setPaletteOpen(true); } },
      { id: 'origin.quickOpen',      title: 'Go to File…',        category: 'Go',   keywords: 'quick open file', run: () => { setPaletteMode('quickopen'); setPaletteOpen(true); } },
      { id: 'origin.toggleFullscreen', title: 'Toggle Full Screen', category: 'View', run: () => toggleFullscreen() },
      { id: 'origin.setModeIde',     title: 'Switch to IDE Mode', category: 'View', run: () => setAppMode('ide') },
      { id: 'origin.setModeAi',      title: 'Switch to AI Mode',  category: 'View', run: () => setAppMode('ai') },
      { id: 'origin.zoomIn',         title: 'Zoom In',            category: 'View', run: () => handleZoomIn() },
      { id: 'origin.zoomOut',        title: 'Zoom Out',           category: 'View', run: () => handleZoomOut() },
      { id: 'origin.zoomReset',      title: 'Reset Zoom',         category: 'View', run: () => handleZoomReset() },
      // Appearance — on expose ce qui est réellement câblé (pas de commande factice).
      { id: 'origin.toggleMinimap',  title: 'Toggle Minimap',      category: 'View', keywords: 'appearance editor overview', run: () => setMinimap(v => !v) },
      { id: 'origin.toggleStickyScroll', title: 'Toggle Sticky Scroll', category: 'View', keywords: 'appearance bonds header', run: () => setStickyScroll(v => !v) },
      { id: 'origin.toggleBracketColorization', title: 'Toggle Bracket Pair Colorization', category: 'View', keywords: 'appearance rainbow brackets', run: () => setBracketColorization(v => !v) },
      // Ouvre la prévisualisation Markdown de l'onglet actif (si c'est un fichier .md).
      { id: 'origin.openMarkdownPreview', title: 'Open Markdown Preview', category: 'View', keywords: 'markdown preview rendu md', enabled: !!activeTabRef.current && /\.mdx?$/i.test(activeTabRef.current), run: () => { const p = activeTabRef.current; if (p && /\.mdx?$/i.test(p)) openMarkdownPreviewTab(p); } },

      // ── Go ──
      { id: 'origin.goToLine',       title: 'Go to Line/Column…', category: 'Go', keywords: 'goto line number', run: () => { setPaletteMode('line'); setPaletteOpen(true); } },
      { id: 'origin.gotoSymbol',     title: 'Go to Symbol in File…', category: 'Go', keywords: 'symbol outline', run: () => { void openSymbolPalette(); } },
      { id: 'origin.gotoWorkspaceSymbol', title: 'Go to Symbol in Workspace…', category: 'Go', keywords: 'workspace symbol project ctrl+t', run: () => { setPaletteMode('workspace-symbol'); setPaletteOpen(true); } },

      // ── Terminal ──
      { id: 'origin.newTerminal',    title: 'Create New Terminal', category: 'Terminal', keywords: 'shell new',  run: () => handleNewTerminalTab() },
      { id: 'origin.clearTerminal',  title: 'Clear Terminal',      category: 'Terminal', keywords: 'reset console', run: () => terminalRef.current?.clearActive() },
      { id: 'origin.killTerminal',   title: 'Kill Terminal',       category: 'Terminal', keywords: 'stop close session', run: () => terminalRef.current?.killActive() },

      // ── Run / Debug ──
      { id: 'origin.runFile',        title: 'Run Active File',    category: 'Run',   keywords: 'execute',        run: () => { void handleRunActiveFile(); } },
      { id: 'origin.startDebug',     title: 'Start Debugging',    category: 'Debug', keywords: 'launch f5',      run: () => setSidebarOpen(true) },
      { id: 'origin.stopDebug',      title: 'Stop Debugging',     category: 'Debug', enabled: debugCtx.session.status !== 'idle', run: () => debugCtx.stopSession() },
      { id: 'origin.stepOver',       title: 'Step Over',          category: 'Debug', run: () => debugCtx.stepOver?.() },
      { id: 'origin.stepInto',       title: 'Step Into',          category: 'Debug', run: () => debugCtx.stepIn?.() },
      { id: 'origin.stepOut',        title: 'Step Out',           category: 'Debug', run: () => debugCtx.stepOut?.() },
      { id: 'origin.pauseDebug',     title: 'Pause',              category: 'Debug', enabled: debugCtx.session.status === 'running', run: () => debugCtx.pause?.() },

      // ── Developer ──
      // « Reload Window » recharge le webview sans redémarrer le process natif :
      // c'est l'équivalent VS Code le plus proche et il est instantané.
      { id: 'origin.reloadWindow',   title: 'Reload Window',      category: 'Developer', keywords: 'restart refresh webview', run: () => window.location.reload() },
      // Redémarre l'application native entière (utile après un changement de config).
      { id: 'origin.restartWindow',  title: 'Restart Application', category: 'Developer', keywords: 'relaunch process', run: () => { void relaunch(); } },
      { id: 'origin.reloadExtensions', title: 'Reload Extensions', category: 'Developer', keywords: 'extensions refresh', run: () => { void reloadExtensions(); } },

      // ── Window ──
      { id: 'origin.closeWindow',    title: 'Close Window',       category: 'Window', keywords: 'quit exit',      run: () => { void getCurrentWindow().close(); } },
      { id: 'origin.minimizeWindow', title: 'Minimize Window',    category: 'Window', run: () => { void getCurrentWindow().minimize(); } },
      { id: 'origin.maximizeWindow', title: 'Toggle Maximize Window', category: 'Window', keywords: 'zoom full', run: () => { void getCurrentWindow().toggleMaximize(); } },

      // ── Help ──
      { id: 'origin.welcome',        title: 'Welcome',            category: 'Help', keywords: 'get started onboarding', run: () => setPaletteOpen(false) },
      { id: 'origin.keyboardShortcuts', title: 'Keyboard Shortcuts', category: 'Help', keywords: 'keybindings reference', run: () => { setPaletteMode('command'); setPaletteOpen(true); } },
      { id: 'origin.checkUpdates',   title: 'Check for Updates…', category: 'Help', keywords: 'upgrade version', run: () => { void checkForUpdate().then(u => { showToast(u ? `Update available — v${u.version}` : 'Mira is up to date', 'info'); }).catch(() => showToast('Update check failed', 'error')); } },
    ];
    return registerCommands(cmds);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- les handlers de commande lisent l'état via refs/closure à jour ; ré-enregistrer à chaque changement d'état UI pertinent
  }, [sidebarOpen, terminalOpen, splitTab, appMode, debugCtx.session.status, minimap, stickyScroll, bracketColorization]);

  return (
    <CommandContext.Provider value={commands}>
    <div
      className="h-full w-full flex flex-col gap-1"
      style={{ backgroundColor: "var(--origin-bg-base)", color: "var(--origin-fg-default)" }}
    >
      {onboardingDone && <TitleBar />}
      {!onboardingDone ? (
        <Onboarding onComplete={completeOnboarding} />
      ) : (
        <>
        {appMode === 'ai' ? (
          <AgentModeView
          folderPath={folderPath}
          tabs={tabs}
          activeTab={activeTab}
          fileContents={fileContents}
          fileErrors={fileErrors}
          binaryData={binaryData}
          jumpRequest={jumpRequest}
          fileTreeVersion={fileTreeVersion}
          editorRef={editorRef}
          cursorPositions={cursorPositions}
          pinnedContext={pinnedContext}
          openTab={openTab}
          openTabAtLine={openTabAtLine}
          closeTab={closeTab}
          setActiveTab={setActiveTab}
          handleEditorChange={handleEditorChange}
          handleSave={handleSave}
          handleNewFile={handleNewFile}
          setPinnedContext={setPinnedContext}
          setCursorPositions={setCursorPositions}
          openAiDiffTab={openAiDiffTab}
          getAiCompletion={getAiCompletion}
          handleMissingServer={handleMissingServer}
          lspGeneration={lspGeneration}
          onDefinitionJump={(fp, line, col) => openTabAtLine(fp, line, col)}
          onApplyWorkspaceEdits={handleApplyWorkspaceEdits}
          terminalRef={terminalRef}
          terminalHeight={terminalHeight}
          setTerminalHeight={setTerminalHeight}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden gap-1">
            {sidebarOpen && <Sidebar onFileOpen={openTab} onFileOpenAtLine={openTabAtLine} onMarkdownPreview={openMarkdownPreviewTab} fileTreeKey={fileTreeVersion} onFilesChanged={reloadFilesFromDisk} onExternalFileChanges={applyExternalFileChanges} activePath={activeTab ?? undefined} activeContent={activeTab ? fileContents[activeTab] : undefined} rootPath={folderPath ?? undefined} />}
            <div className="flex flex-1 overflow-hidden gap-1">
              <div className="flex-1 flex flex-col overflow-hidden gap-1">
                <TabBar
                  tabs={tabs}
                  activeTab={activeTab}
                  onSelect={setActiveTab}
                  onClose={(path) => {
                    if (path === '__preview__') localStorage.removeItem('origin-preview-url');
                    closeTab(path);
                  }}
                />
                <main className="flex-1 flex overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)", position: "relative" }}>
                  {debugCtx.session.status !== 'idle' && debugCtx.session.status !== 'terminated' && (
                    <DebugToolbar
                      status={debugCtx.session.status}
                      onContinue={debugCtx.continueExec}
                      onStepOver={debugCtx.stepOver}
                      onStepIn={debugCtx.stepIn}
                      onStepOut={debugCtx.stepOut}
                      onPause={debugCtx.pause}
                      onStop={debugCtx.stopSession}
                    />
                  )}
                  <EditorArea
                    folderPath={folderPath}
                    tabs={tabs}
                    activeTab={activeTab}
                    fileContents={fileContents}
                    binaryData={binaryData}
                    fileErrors={fileErrors}
                    cursorPositions={cursorPositions}
                    jumpRequest={jumpRequest}
                    editorRef={editorRef}
                    lspGeneration={lspGeneration}
                    getAiCompletion={getAiCompletion}
                    onEditorChange={handleEditorChange}
                    onCursorChange={(path, line, col) => setCursorPositions(prev => ({ ...prev, [path]: { line, col } }))}
                    topLines={topLines}
                    onScrollLine={(path, line) => setTopLines(prev => prev[path] === line ? prev : ({ ...prev, [path]: line }))}
                    onCloseTab={path => { if (path === '__preview__') localStorage.removeItem('origin-preview-url'); closeTab(path); }}
                    onAddToAiContext={ctx => { setPinnedContext(ctx); setAiPanelOpen(true); }}
                    onAcceptDiff={handleSave}
                    onDefinitionJump={(fp, line, col) => openTabAtLine(fp, line, col)}
                    onMissingServer={handleMissingServer}
                    onToggleBreakpoint={(fp, line) => debugCtx.toggleBreakpoint(fp, line)}
                    onApplyWorkspaceEdits={handleApplyWorkspaceEdits}
                    onOpenFolder={handleOpenFolder}
                    onOpenProject={handleOpenProject}
                    minimap={minimap}
                    stickyScroll={stickyScroll}
                    bracketColorization={bracketColorization}
                  />
                  {terminalOpen && (
                    <div
                      style={{
                        position: "absolute", bottom: 0, left: 0, right: 0, height: 20,
                        background: "linear-gradient(to bottom, transparent, var(--origin-bg-panel))",
                        pointerEvents: "none", zIndex: 10,
                      }}
                    />
                  )}
                </main>
                {terminalMounted && (
                  <TerminalPanel
                    ref={terminalRef}
                    cwd={folderPath ?? "."}
                    height={terminalHeight}
                    onResize={setTerminalHeight}
                    onClose={() => setTerminalOpen(false)}
                    hidden={!terminalOpen}
                    rootPath={folderPath}
                    onOpenFile={(path, line, col) => openTabAtLine(path, line, col)}
                    onAddSelectionToAi={(text) => {
                      // Même canal « contexte épinglé » que l'éditeur : le chat
                      // (AiPanel) le consomme identiquement. `type: 'terminal'`
                      // indique une sélection de terminal (sans lignes de fichier).
                      setPinnedContext({
                        filename: "Terminal",
                        language: "shell",
                        code: text,
                        type: "terminal",
                        startLine: 0,
                        endLine: 0,
                      });
                      setAiPanelOpen(true);
                    }}
                  />
                )}
              </div>
              {splitTab !== null && (
                <div className="flex-1 flex flex-col overflow-hidden gap-1 min-w-0" style={{ borderLeft: "1px solid var(--origin-border-default)" }}>
                  <TabBar
                    tabs={tabs}
                    activeTab={splitTab}
                    onSelect={setSplitTab}
                    onClose={(path) => {
                      if (path === '__preview__') localStorage.removeItem('origin-preview-url');
                      closeTab(path);
                      if (path === splitTab) setSplitTab(null);
                    }}
                  />
                  <main className="flex-1 flex overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)", position: "relative" }}>
                    <EditorArea
                      folderPath={folderPath}
                      tabs={tabs}
                      activeTab={splitTab}
                      fileContents={fileContents}
                      binaryData={binaryData}
                      fileErrors={fileErrors}
                      cursorPositions={cursorPositions}
                      jumpRequest={jumpRequest}
                      editorRef={splitEditorRef}
                      lspGeneration={lspGeneration}
                      getAiCompletion={getAiCompletion}
                      onEditorChange={handleEditorChange}
                      onCursorChange={(path, line, col) => setCursorPositions(prev => ({ ...prev, [path]: { line, col } }))}
                      topLines={topLines}
                      onScrollLine={(path, line) => setTopLines(prev => prev[path] === line ? prev : ({ ...prev, [path]: line }))}
                      onCloseTab={path => { if (path === '__preview__') localStorage.removeItem('origin-preview-url'); closeTab(path); if (path === splitTab) setSplitTab(null); }}
                      onAddToAiContext={ctx => { setPinnedContext(ctx); setAiPanelOpen(true); }}
                      onAcceptDiff={handleSave}
                      onDefinitionJump={(fp, line, col) => openTabAtLine(fp, line, col)}
                      onMissingServer={handleMissingServer}
                      onToggleBreakpoint={(fp, line) => debugCtx.toggleBreakpoint(fp, line)}
                      onApplyWorkspaceEdits={handleApplyWorkspaceEdits}
                      onOpenFolder={handleOpenFolder}
                      onOpenProject={handleOpenProject}
                      minimap={minimap}
                      stickyScroll={stickyScroll}
                      bracketColorization={bracketColorization}
                    />
                  </main>
                </div>
              )}
              {aiPanelOpen && (
                <AiPanel
                  getEditorContext={() => editorRef.current?.getEditorContext() ?? null}
                  getActiveFilePath={() => activeTab}
                  forcedContext={pinnedContext}
                  onForcedContextConsumed={() => setPinnedContext(null)}
                  onApplyCode={handleApplyCode}
                  getOpenTabPaths={() => tabs.map(t => t.path)}
                  getFileContents={() => fileContentsRef.current}
                  onOpenDiffTab={openAiDiffTab}
                  onOpenFile={(path, line, col) => openTabAtLine(path, line ?? 1, col ?? 1)}
                  onExternalFileChanges={applyExternalFileChanges}
                  onOpenFolder={handleOpenFolder}
                />
              )}
            </div>
          </div>
      )}
      <StatusBar
        language={languageLabel(activeTab)}
        line={cursorPositions[activeTab ?? '']?.line ?? 1}
        col={cursorPositions[activeTab ?? '']?.col ?? 1}
        branch={gitBranch}
        errors={diagnostics.errors}
        warnings={diagnostics.warnings}
        mobileFrameworks={mobileFrameworks}
        onShowProblems={() => { setTerminalOpen(true); requestAnimationFrame(() => terminalRef.current?.showProblems()); }}
        onOpenLaunchpad={() => { setPaletteMode('command'); setPaletteOpen(true); }}
        debugStatus={
          debugCtx.session.status === 'paused' ? 'paused' :
          debugCtx.session.status === 'running' ? 'running' : null
        }
      />
      </>
      )}
      {paletteOpen && (
        <CommandPalette
          tabs={tabs}
          activeTab={activeTab}
          openMode={paletteMode}
          symbols={paletteSymbols}
          onGoToLine={(line, col) => { goToLineInEditor(line, col); }}
          onGoToSymbol={(line) => { const p = activeTabRef.current; if (p) openTabAtLine(p, line, 1); }}
          onGoToWorkspaceSymbol={(path, line, col) => { setPaletteOpen(false); openTabAtLine(path, line, col); }}
          onFileOpen={openTab}
          onFileOpenAtLine={(path, line) => { setPaletteOpen(false); openTabAtLine(path, line, 0); }}
          onClose={() => { setPaletteOpen(false); setPaletteMode('command'); }}
          onNewFile={() => { setPaletteOpen(false); handleNewFile(); }}
          onOpenFolder={() => { setPaletteOpen(false); handleOpenFolder(); }}
          onOpenFile={() => { setPaletteOpen(false); handleOpenFile(); }}
          onToggleSidebar={() => { setPaletteOpen(false); setSidebarOpen(v => !v); }}
          onToggleTerminal={() => { setPaletteOpen(false); setTerminalOpen(v => !v); }}
          onOpenSettings={() => { setPaletteOpen(false); setSettingsOpen(true); }}
          onOpenMarkdownPreview={(path) => { setPaletteOpen(false); openMarkdownPreviewTab(path); }}
          terminalOpen={terminalOpen}
          sidebarOpen={sidebarOpen}
        />
      )}
      {settingsOpen && <SettingsPanel initialSection={settingsSection} onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }} />}
      {trustPrompt && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 10000,
            backgroundColor: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setTrustPrompt(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 460, maxWidth: "90vw",
              borderRadius: 10, padding: "20px 22px",
              backgroundColor: "var(--origin-bg-panel)",
              border: "1px solid var(--origin-border-default)",
              boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: 8 }}>
              Run a task from this workspace?
            </div>
            <div style={{ fontSize: 12.5, color: "var(--origin-fg-muted)", lineHeight: 1.6, marginBottom: 12 }}>
              A task defined in this project wants to run a command. Only allow this if you trust the
              repository.
            </div>
            <pre style={{
              margin: 0, padding: "10px 12px", borderRadius: 8,
              backgroundColor: "var(--origin-bg-base)",
              border: "1px solid var(--origin-border-default)",
              color: "var(--origin-fg-default)", fontSize: 12,
              fontFamily: "var(--font-mono)", overflowX: "auto", whiteSpace: "pre-wrap",
            }}>
              {trustPrompt.program} {trustPrompt.args.join(" ")}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setTrustPrompt(null)}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  border: "1px solid var(--origin-border-default)",
                  backgroundColor: "transparent", color: "var(--origin-fg-default)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const p = trustPrompt;
                  setTrustPrompt(null);
                  startTask(p.label, p.program, p.args);
                }}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  border: "1px solid var(--origin-border-default)",
                  backgroundColor: "transparent", color: "var(--origin-fg-default)",
                }}
              >
                Run once
              </button>
              <button
                onClick={() => {
                  const p = trustPrompt;
                  setTrustPrompt(null);
                  if (folderPath && p.raw) trustWorkspace(folderPath, p.raw);
                  startTask(p.label, p.program, p.args);
                }}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  border: "none",
                  backgroundColor: "var(--origin-accent-blue)",
                  color: "#fff", fontWeight: 500,
                }}
              >
                Always trust this workspace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </CommandContext.Provider>
  );
}

export default App;
