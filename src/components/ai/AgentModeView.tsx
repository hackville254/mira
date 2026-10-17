import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import AiPanel, { type AiDiffTabInput, type AgentSurfaceState } from "./AiPanel";
import AgentPanel from "./AgentPanel";
import DiffViewPanel from "./DiffViewPanel";
import DocViewPanel from "./DocViewPanel";
import TaskRail from "./TaskRail";
import TaskProgressBar from "./TaskProgressBar";
import { activeFlowTab, shouldFlow, type FlowTabId } from "../../lib/agent/flow";
import Sidebar from "../Sidebar";
import TabBar, { type Tab } from "../editor/TabBar";
import Editor, { type EditorHandle, type EditorContext } from "../editor/Editor";
import EditorEmptyState from "../editor/EditorEmptyState";
import EditorWelcome from "../editor/EditorWelcome";
import AiDiffPane, { type AiDiffTabData } from "../editor/AiDiffPane";
import WebPreviewPane from "../editor/WebPreviewPane";
import ImageViewerPane from "../editor/ImageViewerPane";
import PdfViewerPane from "../editor/PdfViewerPane";
import VideoViewerPane from "../editor/VideoViewerPane";
import AudioViewerPane from "../editor/AudioViewerPane";
import UnsupportedFilePane from "../editor/UnsupportedFilePane";
import { fileKindOf } from "../../lib/fileKind";
import TerminalPanel, { type TerminalPanelHandle } from "../terminal/TerminalPanel";
import SettingsPanel from "../settings/SettingsPanel";
import type { AiCompletionFn } from "../../lib/aiAutocomplete";
import type { MissingServerInfo } from "../../lib/lspCm6";
import type { FileEdits } from "../../lib/lspEdits";

type ToolTabId =
  | "terminal" | "editor" | "docview" | "settings" | "diffview" | "agents" | "browser";

interface ToolTabDef {
  id: ToolTabId;
  label: string;
  icon: string;
  color?: string;
}

const TOOL_TABS: ToolTabDef[] = [
  { id: "terminal", label: "Terminal",  icon: "lucide:terminal", color: "var(--origin-fg-muted)" },
  { id: "editor",   label: "Editor",   icon: "lucide:code-2",   color: "#34d399" },
  { id: "docview", label: "DocView", icon: "lucide:file-text", color: "#a78bfa" },
  { id: "settings", label: "Settings", icon: "lucide:settings", color: "var(--origin-fg-muted)" },
  { id: "diffview", label: "DiffView", icon: "lucide:git-compare", color: "#34d399" },
  { id: "agents",  label: "Agents",  icon: "lucide:bot",       color: "var(--origin-fg-default)" },
  { id: "browser", label: "Browser", icon: "lucide:globe",     color: "#60a5fa" },
];

interface AgentModeViewProps {
  folderPath: string | null;
  // Editor
  tabs: Tab[];
  activeTab: string | null;
  fileContents: Record<string, string>;
  fileErrors: Record<string, string>;
  /** Contenu binaire (image/PDF) en base64 par chemin. */
  binaryData: Record<string, { base64: string; mime: string }>;
  jumpRequest?: { path: string; line: number; col: number; key: number } | null;
  fileTreeVersion: number;
  editorRef: React.RefObject<EditorHandle | null>;
  cursorPositions: Record<string, { line: number; col: number }>;
  pinnedContext: EditorContext | null;
  openTab: (path: string) => void;
  openTabAtLine: (path: string, line: number, col: number) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  handleEditorChange: (path: string, content: string) => void;
  handleSave: (path: string) => void;
  handleNewFile: () => void;
  setPinnedContext: (ctx: EditorContext | null) => void;
  setCursorPositions: (updater: (prev: Record<string, { line: number; col: number }>) => Record<string, { line: number; col: number }>) => void;
  openAiDiffTab: (data: AiDiffTabInput) => void;
  /** Rafraîchit l'éditeur après une action externe (Undo all / revert de l'agent). */
  onExternalFileChanges?: (paths: string[]) => Promise<void>;
  getAiCompletion?: AiCompletionFn;
  handleMissingServer?: (info: MissingServerInfo) => void;
  /** Incrémenté après l'installation d'un serveur LSP → recrée l'extension LSP. */
  lspGeneration?: number;
  onDefinitionJump?: (filePath: string, line: number, col: number) => void;
  /** Applique les éditions LSP (rename / code action) touchant d'autres fichiers. */
  onApplyWorkspaceEdits?: (edits: FileEdits[]) => void;
  // Terminal
  terminalRef: React.RefObject<TerminalPanelHandle | null>;
  terminalHeight: number;
  setTerminalHeight: (h: number) => void;
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
}

/**
 * Full-screen Agent mode layout:
 *   [TaskRail] [Agent surface] [Tool panels (tabs)] [Explorer]
 *
 * Reuses the existing AiPanel, Editor, Terminal, WebPreviewPane, and Sidebar.
 */
export default function AgentModeView(props: AgentModeViewProps) {
  const {
    folderPath,
    tabs, activeTab, fileContents, binaryData, fileErrors, jumpRequest, fileTreeVersion,
    editorRef, cursorPositions, pinnedContext,
    openTab, openTabAtLine, closeTab, setActiveTab, handleEditorChange,
    handleSave, handleNewFile, setPinnedContext, setCursorPositions, openAiDiffTab,
    getAiCompletion, handleMissingServer, onDefinitionJump, lspGeneration,
    onApplyWorkspaceEdits, onExternalFileChanges,
    terminalRef, terminalHeight, setTerminalHeight, setTerminalOpen,
  } = props;

  // Session bridging between TaskRail and AiPanel.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [newChatNonce, setNewChatNonce] = useState(0);

  // État de la « surface agent » remonté par AiPanel (fichiers en revue, dernier
  // document, plan). Alimente les tool panels DiffView / DocView sans dupliquer
  // de logique : le parent ne fait que déléguer l'affichage (parité Trae).
  const [surface, setSurface] = useState<AgentSurfaceState | null>(null);

  // Open tool tabs (top bar). User can add/remove tabs via + and × buttons.
  const [openTabs, setOpenTabs] = useState<ToolTabId[]>(["editor", "browser", "terminal"]);
  const [activeToolTab, setActiveToolTab] = useState<ToolTabId | null>("editor");
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const openToolTab = useCallback((id: ToolTabId) => {
    setOpenTabs(prev => prev.includes(id) ? prev : [...prev, id]);
    setActiveToolTab(id);
    setAddMenuOpen(false);
  }, []);

  // ── Flow (parité Trae) ────────────────────────────────────────────────────
  //
  // Pendant un run, le panneau d'outils suit l'étape de l'agent : lecture →
  // Editor, écriture → DiffView, commande → Terminal, web → Browser. L'utilisateur
  // garde la main : dès qu'il clique lui-même un onglet, le Flow se met en pause
  // pour le reste du tour (il reprendra au tour suivant). Cette logique de
  // décision est isolée dans `lib/agent/flow.ts` (testable sans DOM).
  const flowPausedRef = useRef(false);
  const prevRunningRef = useRef(false);

  // Un clic utilisateur (ou l'ouverture manuelle d'un onglet) suspend le Flow.
  const selectToolTab = useCallback((id: ToolTabId) => {
    flowPausedRef.current = true;
    setActiveToolTab(id);
  }, []);

  useEffect(() => {
    const running = surface?.isRunning ?? false;
    // Front montant d'un run : le Flow reprend la main (nouveau tour).
    if (running && !prevRunningRef.current) flowPausedRef.current = false;
    prevRunningRef.current = running;

    if (!shouldFlow(running) || flowPausedRef.current) return;
    const target: FlowTabId | undefined = activeFlowTab(surface?.runningTools ?? []);
    if (!target) return;
    // On s'assure que l'onglet cible est bien ouvert, puis on l'active.
    // Ces deux updaters sont « no-op » si la valeur ne change pas (même
    // référence) : le Flow ne déclenche un rendu QUE lors d'une vraie bascule.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronisation volontaire agent→UI (Flow)
    setOpenTabs(prev => prev.includes(target) ? prev : [...prev, target]);
    setActiveToolTab(prev => (prev === target ? prev : target));
  }, [surface]);

  const closeToolTab = useCallback((id: ToolTabId) => {
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== id);
      if (id === activeToolTab) {
        setActiveToolTab(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [activeToolTab]);

  const handleSelectTask = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setOpenSessionId(sessionId);
  }, []);

  const handleNewTask = useCallback(() => {
    setActiveSessionId(null);
    setOpenSessionId(null);
    setNewChatNonce(n => n + 1);
  }, []);

  const handleActiveSessionChange = useCallback((sessionId: string | null) => {
    setActiveSessionId(sessionId);
  }, []);

  return (
    <div className="flex flex-1 overflow-hidden gap-1">
      {/* Task rail */}
      <TaskRail
        activeSessionId={activeSessionId}
        onSelect={handleSelectTask}
        onNewTask={handleNewTask}
      />

      {/* Agent surface (left) */}
      <AiPanel
        renderMode="agent"
        openSessionId={openSessionId}
        newChatNonce={newChatNonce}
        onActiveSessionChange={handleActiveSessionChange}
        getEditorContext={() => editorRef.current?.getEditorContext() ?? null}
        getActiveFilePath={() => activeTab}
        forcedContext={pinnedContext}
        onForcedContextConsumed={() => setPinnedContext(null)}
        onApplyCode={(code, filePath) => {
          if (filePath) {
            openTab(filePath);
            handleEditorChange(filePath, code);
            handleSave(filePath);
          }
        }}
        getOpenTabPaths={() => tabs.map(t => t.path)}
        getFileContents={() => fileContents}
        onOpenDiffTab={openAiDiffTab}
        onOpenFile={(path, line, col) => openTabAtLine(path, line ?? 1, col ?? 1)}
        onExternalFileChanges={onExternalFileChanges}
        onAgentSurface={setSurface}
      />

      {/* Tool panels (center) — always open */}
      <div className="flex flex-1 flex-col overflow-hidden gap-1">
        {/* Multitasking : bandeau des tâches actives (no-op en mono-tâche) */}
        <TaskProgressBar activeSessionId={activeSessionId} onSelect={handleSelectTask} />

        {/* Tool tab bar — fond noir uni (mode IA), onglet actif légèrement éclairci */}
        <div
          style={{
            display: "flex", alignItems: "center",
            height: 38, flexShrink: 0,
            padding: "0 6px",
            backgroundColor: "var(--origin-bg-editor)",
            borderBottom: "1px solid var(--origin-border-default)",
          }}
        >
          {openTabs.map(tabId => {
            const def = TOOL_TABS.find(t => t.id === tabId);
            if (!def) return null;
            const active = activeToolTab === tabId;
            return (
              <div
                key={tabId}
                onClick={() => selectToolTab(tabId)}
                style={{
                  position: "relative",
                  display: "flex", alignItems: "center", gap: 6,
                  height: 30, margin: "0 2px", padding: "0 8px 0 12px",
                  borderRadius: 6,
                  background: active ? "var(--origin-bg-hover)" : "transparent",
                  color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                  cursor: "pointer", fontSize: 12, letterSpacing: "0.01em",
                  fontWeight: active ? 600 : 500,
                  userSelect: "none",
                  transition: "background 120ms ease, color 120ms ease",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                {active && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute", left: 8, right: 8, bottom: -1,
                      height: 2, borderRadius: 2,
                      background: "var(--origin-accent-blue, #62a6ff)",
                    }}
                  />
                )}
                <Icon icon={def.icon} width={14} style={{ color: def.color }} />
                <span>{def.label}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); closeToolTab(tabId); }}
                  title="Close"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 16, height: 16, borderRadius: 4,
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "var(--origin-fg-subtle)", marginLeft: 2, padding: 0,
                    opacity: active ? 1 : 0.6,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-active)"; e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.opacity = "1"; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--origin-fg-subtle)"; e.currentTarget.style.opacity = active ? "1" : "0.6"; }}
                >
                  <Icon icon="lucide:x" width={12} />
                </button>
              </div>
            );
          })}

          {/* Add tab button with dropdown */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setAddMenuOpen(o => !o)}
              title="Open tab"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, borderRadius: 6,
                background: addMenuOpen ? "var(--origin-bg-hover)" : "transparent",
                border: "none", cursor: "pointer",
                color: addMenuOpen ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
              }}
              onMouseEnter={e => { if (!addMenuOpen) e.currentTarget.style.color = "var(--origin-fg-default)"; }}
              onMouseLeave={e => { if (!addMenuOpen) e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
            >
              <Icon icon="lucide:plus" width={15} />
            </button>

            {addMenuOpen && (
              <>
                {/* Click-away overlay */}
                <div
                  onClick={() => setAddMenuOpen(false)}
                  style={{
                    position: "fixed", inset: 0, zIndex: 50,
                  }}
                />
                {/* Dropdown menu */}
                <div style={{
                  position: "absolute", top: 32, left: 0, zIndex: 60,
                  minWidth: 200, padding: 6,
                  backgroundColor: "var(--origin-bg-panel)",
                  border: "1px solid var(--origin-border-default)",
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: "var(--origin-fg-subtle)",
                    textTransform: "uppercase", letterSpacing: "0.05em",
                    padding: "4px 8px 8px",
                  }}>
                    Open tab
                  </div>
                  {TOOL_TABS.filter(t => !openTabs.includes(t.id)).length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--origin-fg-subtle)", padding: "8px" }}>
                      All tabs are open
                    </div>
                  ) : (
                    TOOL_TABS.filter(t => !openTabs.includes(t.id)).map(t => (
                      <button
                        key={t.id}
                        onClick={() => openToolTab(t.id)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          width: "100%", padding: "6px 8px",
                          background: "transparent", border: "none", borderRadius: 6,
                          cursor: "pointer", textAlign: "left",
                          fontSize: 12, color: "var(--origin-fg-default)",
                        }}
                        onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"}
                        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <Icon icon={t.icon} width={14} style={{ color: t.color }} />
                        <span>{t.label}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Right side controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 8 }}>
            <button
              title="Split"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 4,
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--origin-fg-muted)",
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <Icon icon="lucide:square-split-horizontal" width={15} />
            </button>
            <button
              title="Maximize"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 4,
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--origin-fg-muted)",
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <Icon icon="lucide:maximize-2" width={15} />
            </button>
          </div>
        </div>

        {/* Tool content */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
          {activeToolTab === null ? (
            <div
              style={{
                flex: 1, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 14, color: "var(--origin-fg-subtle)",
              }}
              onDoubleClick={() => openToolTab("editor")}
            >
              <Icon icon="lucide:layout-panel-top" width={36} style={{ opacity: 0.4 }} />
              <div style={{ fontSize: 13, textAlign: "center" }}>
                No tabs open
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", maxWidth: 320 }}>
                {TOOL_TABS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => openToolTab(t.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "6px 10px", borderRadius: 6,
                      border: "1px solid var(--origin-border-default)",
                      backgroundColor: "var(--origin-bg-panel)",
                      color: "var(--origin-fg-default)",
                      fontSize: 12, cursor: "pointer",
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = "var(--origin-bg-panel)"}
                  >
                    <Icon icon={t.icon} width={13} style={{ color: t.color }} />
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>
                Double-click to open Editor
              </div>
            </div>
          ) : activeToolTab === "editor" && (
            <>
              <TabBar
                tabs={tabs}
                activeTab={activeTab}
                onSelect={setActiveTab}
                onClose={(path) => {
                  if (path === "__preview__") localStorage.removeItem("origin-preview-url");
                  closeTab(path);
                }}
              />
              <div
                className="flex-1 flex overflow-hidden"
                style={{ position: "relative" }}
                onDoubleClick={() => { if (tabs.length === 0) handleNewFile(); }}
              >
                {!folderPath ? (
                  <EditorEmptyState onOpenFolder={() => {}} onOpenProject={() => {}} />
                ) : tabs.length === 0 ? (
                  <EditorWelcome />
                ) : activeTab?.startsWith("__diff__") ? (
                  (() => {
                    const diffTab = tabs.find(t => t.path === activeTab) as AiDiffTabData | undefined;
                    if (!diffTab) return null;
                    return <AiDiffPane tab={diffTab} onClose={() => closeTab(activeTab)} />;
                  })()
                ) : activeTab === "__preview__" ? (
                  <WebPreviewPane />
                ) : activeTab && fileKindOf(activeTab) === "image" ? (
                  binaryData[activeTab] ? (
                    <ImageViewerPane
                      base64={binaryData[activeTab].base64}
                      mime={binaryData[activeTab].mime}
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                    />
                  ) : (
                    <UnsupportedFilePane
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                      reason={fileErrors[activeTab]}
                    />
                  )
                ) : activeTab && fileKindOf(activeTab) === "pdf" ? (
                  binaryData[activeTab] ? (
                    <PdfViewerPane
                      base64={binaryData[activeTab].base64}
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                    />
                  ) : (
                    <UnsupportedFilePane
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                      reason={fileErrors[activeTab]}
                    />
                  )
                ) : activeTab && fileKindOf(activeTab) === "binary" ? (
                  <UnsupportedFilePane
                    fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                  />
                ) : activeTab && fileKindOf(activeTab) === "video" ? (
                  binaryData[activeTab] ? (
                    <VideoViewerPane
                      base64={binaryData[activeTab].base64}
                      mime={binaryData[activeTab].mime}
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                    />
                  ) : (
                    <UnsupportedFilePane
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                      reason={fileErrors[activeTab]}
                    />
                  )
                ) : activeTab && fileKindOf(activeTab) === "audio" ? (
                  binaryData[activeTab] ? (
                    <AudioViewerPane
                      base64={binaryData[activeTab].base64}
                      mime={binaryData[activeTab].mime}
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                    />
                  ) : (
                    <UnsupportedFilePane
                      fileName={activeTab.split(/[\\/]/).filter(Boolean).pop() ?? activeTab}
                      reason={fileErrors[activeTab]}
                    />
                  )
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
                    onAddToAiContext={ctx => { setPinnedContext(ctx); }}
                    onAcceptDiff={() => handleSave(activeTab)}
                    rootPath={folderPath}
                    onDefinitionJump={onDefinitionJump}
                    onMissingServer={handleMissingServer}
                    lspGeneration={lspGeneration}
                    getAiCompletion={getAiCompletion}
                    onApplyWorkspaceEdits={onApplyWorkspaceEdits}
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
                      Loading<span style={{ animation: "origin-ellipsis 1.2s steps(4, end) infinite" }}>…</span>
                    </span>
                  </div>
                )}
              </div>
            </>
          )}

          {activeToolTab === "browser" && <WebPreviewPane />}

          {activeToolTab === "terminal" && (
            <TerminalPanel
              ref={terminalRef}
              cwd={folderPath ?? "."}
              height={terminalHeight}
              onResize={setTerminalHeight}
              onClose={() => setTerminalOpen(false)}
              hidden={false}
              rootPath={folderPath}
              onOpenFile={(path, line, col) => openTabAtLine(path, line, col)}
              agentSessionId={activeSessionId}
            />
          )}

          {activeToolTab === "settings" && (
            <div className="flex-1 overflow-auto" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
              <SettingsPanel onClose={() => {}} />
            </div>
          )}

          {activeToolTab === "agents" && <AgentPanel />}

          {activeToolTab === "diffview" && (
            <DiffViewPanel
              files={surface?.reviewFiles ?? []}
              onOpenDiff={surface?.openDiff}
              onUndoAll={surface?.undoAll}
              onKeepAll={surface?.keepAll}
            />
          )}

          {activeToolTab === "docview" && (
            <DocViewPanel
              markdown={surface?.docMarkdown ?? ""}
              plan={surface?.plan}
            />
          )}
        </div>
      </div>

      {/* Explorer (right) — collapsed by default in AI mode */}
      <Sidebar
        defaultCollapsed
        onFileOpen={openTab}
        onFileOpenAtLine={openTabAtLine}
        fileTreeKey={fileTreeVersion}
      />
    </div>
  );
}
