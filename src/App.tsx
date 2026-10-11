import { useState, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import Onboarding from "./components/onboarding/Onboarding";
import EditorEmptyState from "./components/editor/EditorEmptyState";
import EditorWelcome from "./components/editor/EditorWelcome";
import TabBar from "./components/editor/TabBar";
import Editor, { type EditorHandle, type EditorContext } from "./components/editor/Editor";
import AiDiffPane, { type AiDiffTabData } from "./components/editor/AiDiffPane";
import WebPreviewPane from "./components/editor/WebPreviewPane";
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
import { loadApiKey } from "./lib/secrets";
import type { AiCompletionFn } from "./lib/aiAutocomplete";
import { getBranch } from "./lib/git";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { languageLabel } from "./components/editor/languageSupport";
import { useWorkspace } from "./context/WorkspaceContext";
import { useDebugContext } from "./context/DebugContext";
import { useDiagnostics } from "./context/DiagnosticsContext";
import { useExtensions, setHostDelegate, createDefaultHostServices } from "./context/ExtensionsContext";
import { consentStatus, requiredCapabilities } from "./lib/extensions/permissions";
import { readExtensionManifest } from "./lib/extensions";
import { CommandContext } from "./context/CommandContext";
import { useTabs } from "./hooks/useTabs";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";

function App() {
  const { folderPath, setFolderPath } = useWorkspace();
  const diagnostics = useDiagnostics();
  const [onboardingDone, setOnboardingDone] = useState(
    () => localStorage.getItem('origin-onboarding') === 'true'
  );

  const {
    tabs, setTabs: _setTabs,
    activeTab, setActiveTab,
    fileContents,
    fileErrors,
    jumpRequest,
    fileTreeVersion,
    activeTabRef,
    fileContentsRef,
    openTab, openTabAtLine, closeTab,
    handleNewFile, handleEditorChange, openAiDiffTab,
    handleSave, handleSaveAs, handleSaveAll,
  } = useTabs();

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
  const terminalRef    = useRef<TerminalPanelHandle>(null);
  const pendingDiffRef = useRef<{ code: string; targetPath: string } | null>(null);
  const [pendingDiffTick, setPendingDiffTick] = useState(0);
  const [_zoom,          setZoom]          = useState(1.0);
  const [pinnedContext,  setPinnedContext]  = useState<EditorContext | null>(null);
  const [cursorPositions, setCursorPositions] = useState<Record<string, { line: number; col: number }>>({});
  const [gitBranch,      setGitBranch]     = useState<string | null>(null);
  const [paletteOpen,    setPaletteOpen]   = useState(false);
  const [settingsOpen,   setSettingsOpen]  = useState(false);

  // ── Level-2 extension host: publish the app's services as a HostDelegate.
  // App.tsx owns the workspace/editor/toast wiring, so it builds the delegate
  // here; the ExtensionsProvider reads it lazily. File ops are still confined
  // to the workspace root by the host before they reach these functions.
  const { extensions, activate } = useExtensions();
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
      const providerId = localStorage.getItem('origin-ai-provider') ?? 'anthropic';
      const modelId    = localStorage.getItem('origin-ai-model')    ?? 'claude-haiku-4-5-20251001';
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

  const { isFullscreen, toggleFullscreen } = useGlobalKeybindings({
    saveActive:        () => { if (activeTab) handleSave(activeTab); },
    toggleTerminal:    () => setTerminalOpen(v => !v),
    togglePalette:     () => setPaletteOpen(v => !v),
    toggleSettings:    () => setSettingsOpen(v => !v),
    newFile:           () => handleNewFile(),
    openFile:          () => handleOpenFile(),
    closeTab:          () => { if (activeTab) closeTab(activeTab); },
    toggleSidebar:     () => setSidebarOpen(v => !v),
    zoomIn:            () => handleZoomIn(),
    zoomOut:           () => handleZoomOut(),
    zoomReset:         () => handleZoomReset(),
    startDebug:        () => { setSidebarOpen(true); },
    stopDebug:         () => debugCtx.stopSession(),
    stepOver:          () => debugCtx.stepOver?.(),
    stepInto:          () => debugCtx.stepIn?.(),
    stepOut:           () => debugCtx.stepOut?.(),
  });

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
    new WebviewWindow(`origin-${Date.now()}`, {
      url: '/',
      title: 'Origin IDE',
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

  function handleMissingServer(language: string, installCmd: string) {
    const names: Record<string, string> = { typescript: 'TypeScript', rust: 'Rust', python: 'Python' };
    const langName = names[language] ?? language;
    // Open terminal now so TerminalPanel is mounted by the time the user clicks Install
    setTerminalOpen(true);
    showToast(
      `${langName} language server not found`,
      'info',
      {
        label: 'Install',
        onClick: () => { terminalRef.current?.runInNewTab(installCmd); },
      },
    );
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
    onOpenPalette: () => setPaletteOpen(true),
    onOpenSettings: () => setSettingsOpen(true),
    gitBranch,
    dirtyCount: tabs.filter(t => t.isDirty).length,
    hasActiveTab: !!activeTab && !activeTab.startsWith('__diff__'),
    hasFolderOpen: !!folderPath,
    onSave: () => { if (activeTab) handleSave(activeTab); },
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
    onStartDebugging: () => {
      setSidebarOpen(true);
    },
    onStopDebugging: () => debugCtx.stopSession(),
    isDebugActive: debugCtx.session.status !== 'idle' && debugCtx.session.status !== 'terminated',
  };

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
          onDefinitionJump={(fp, line, col) => openTabAtLine(fp, line, col)}
          terminalRef={terminalRef}
          terminalHeight={terminalHeight}
          setTerminalHeight={setTerminalHeight}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden gap-1">
            {sidebarOpen && <Sidebar onFileOpen={openTab} onFileOpenAtLine={openTabAtLine} fileTreeKey={fileTreeVersion} />}
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
                  {!folderPath ? (
                    <EditorEmptyState
                      onOpenFolder={handleOpenFolder}
                      onOpenProject={handleOpenProject}
                    />
                  ) : tabs.length === 0 ? (
                    <EditorWelcome />
                  ) : activeTab?.startsWith('__diff__') ? (
                    (() => {
                      const diffTab = tabs.find(t => t.path === activeTab) as AiDiffTabData | undefined;
                      if (!diffTab) return null;
                      return <AiDiffPane tab={diffTab} onClose={() => closeTab(activeTab)} />;
                    })()
                  ) : activeTab === '__preview__' ? (
                    <WebPreviewPane />
                  ) : activeTab && fileContents[activeTab] !== undefined ? (
                    <Editor
                      ref={editorRef}
                      path={activeTab}
                      content={fileContents[activeTab]}
                      onChange={v => handleEditorChange(activeTab, v)}
                      onCursorChange={(line, col) =>
                        setCursorPositions(prev => ({ ...prev, [activeTab]: { line, col } }))
                      }
                      initialCursor={cursorPositions[activeTab]}
                      jumpTo={jumpRequest?.path === activeTab ? jumpRequest : undefined}
                      onAddToAiContext={ctx => { setPinnedContext(ctx); setAiPanelOpen(true); }}
                      onAcceptDiff={() => handleSave(activeTab)}
                      rootPath={folderPath}
                      onDefinitionJump={(fp, line, col) => openTabAtLine(fp, line, col)}
                      onMissingServer={handleMissingServer}
                      getAiCompletion={getAiCompletion}
                      onToggleBreakpoint={(fp, line) => debugCtx.toggleBreakpoint(fp, line)}
                    />
                  ) : activeTab && fileErrors[activeTab] ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2">
                      <p className="text-xs" style={{ color: "var(--origin-semantic-error)" }}>
                        Failed to read {activeTab.split(/[\\/]/).pop()}
                      </p>
                      <p className="text-xs" style={{ color: "var(--origin-fg-subtle)" }}>
                        {fileErrors[activeTab]}
                      </p>
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <span className="text-xs" style={{ color: "var(--origin-fg-subtle)", opacity: 0.6, letterSpacing: "0.12em" }}>
                        Loading
                        <span style={{ animation: "origin-ellipsis 1.2s steps(4, end) infinite" }}>…</span>
                      </span>
                    </div>
                  )}
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
                  />
                )}
              </div>
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
        onShowProblems={() => { setTerminalOpen(true); requestAnimationFrame(() => terminalRef.current?.showProblems()); }}
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
          onFileOpen={openTab}
          onFileOpenAtLine={(path, line) => { setPaletteOpen(false); openTabAtLine(path, line, 0); }}
          onClose={() => setPaletteOpen(false)}
          onNewFile={() => { setPaletteOpen(false); handleNewFile(); }}
          onOpenFolder={() => { setPaletteOpen(false); handleOpenFolder(); }}
          onOpenFile={() => { setPaletteOpen(false); handleOpenFile(); }}
          onToggleSidebar={() => { setPaletteOpen(false); setSidebarOpen(v => !v); }}
          onToggleTerminal={() => { setPaletteOpen(false); setTerminalOpen(v => !v); }}
          onOpenSettings={() => { setPaletteOpen(false); setSettingsOpen(true); }}
          terminalOpen={terminalOpen}
          sidebarOpen={sidebarOpen}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
    </CommandContext.Provider>
  );
}

export default App;
