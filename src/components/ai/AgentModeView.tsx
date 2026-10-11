import { useCallback, useState } from "react";
import { Icon } from "@iconify/react";
import AiPanel, { type AiDiffTabInput } from "./AiPanel";
import TaskRail from "./TaskRail";
import Sidebar from "../Sidebar";
import TabBar, { type Tab } from "../editor/TabBar";
import Editor, { type EditorHandle, type EditorContext } from "../editor/Editor";
import EditorEmptyState from "../editor/EditorEmptyState";
import EditorWelcome from "../editor/EditorWelcome";
import AiDiffPane, { type AiDiffTabData } from "../editor/AiDiffPane";
import WebPreviewPane from "../editor/WebPreviewPane";
import TerminalPanel, { type TerminalPanelHandle } from "../terminal/TerminalPanel";
import SettingsPanel from "../settings/SettingsPanel";
import type { AiCompletionFn } from "../../lib/aiAutocomplete";

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
  getAiCompletion?: AiCompletionFn;
  handleMissingServer?: (language: string, installCmd: string) => void;
  onDefinitionJump?: (filePath: string, line: number, col: number) => void;
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
    tabs, activeTab, fileContents, fileErrors, jumpRequest, fileTreeVersion,
    editorRef, cursorPositions, pinnedContext,
    openTab, openTabAtLine, closeTab, setActiveTab, handleEditorChange,
    handleSave, handleNewFile, setPinnedContext, setCursorPositions, openAiDiffTab,
    getAiCompletion, handleMissingServer, onDefinitionJump,
    terminalRef, terminalHeight, setTerminalHeight, setTerminalOpen,
  } = props;

  // Session bridging between TaskRail and AiPanel.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [newChatNonce, setNewChatNonce] = useState(0);

  // Open tool tabs (top bar). User can add/remove tabs via + and × buttons.
  const [openTabs, setOpenTabs] = useState<ToolTabId[]>(["editor", "browser", "terminal"]);
  const [activeToolTab, setActiveToolTab] = useState<ToolTabId | null>("editor");
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const openToolTab = useCallback((id: ToolTabId) => {
    setOpenTabs(prev => prev.includes(id) ? prev : [...prev, id]);
    setActiveToolTab(id);
    setAddMenuOpen(false);
  }, []);

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
      />

      {/* Tool panels (center) — always open */}
      <div className="flex flex-1 flex-col overflow-hidden gap-1">
        {/* Tool tab bar */}
        <div
          style={{
            display: "flex", alignItems: "center",
            height: 36, flexShrink: 0,
            backgroundColor: "var(--origin-bg-panel)",
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
                onClick={() => setActiveToolTab(tabId)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28, margin: "0 3px", padding: "0 10px 0 12px",
                  borderRadius: 6,
                  background: active ? "rgba(96, 165, 250, 0.12)" : "transparent",
                  border: active ? "1px solid rgba(96, 165, 250, 0.3)" : "1px solid transparent",
                  color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                  cursor: "pointer", fontSize: "12px", fontWeight: 500,
                  userSelect: "none",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <Icon icon={def.icon} width={14} style={{ color: def.color }} />
                <span>{def.label}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); closeToolTab(tabId); }}
                  title="Close"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 16, height: 16, borderRadius: 3,
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "var(--origin-fg-subtle)", marginLeft: 2, padding: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; e.currentTarget.style.color = "var(--origin-fg-default)"; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--origin-fg-subtle)"; }}
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
                    getAiCompletion={getAiCompletion}
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
            />
          )}

          {activeToolTab === "settings" && (
            <div className="flex-1 overflow-auto" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
              <SettingsPanel onClose={() => {}} />
            </div>
          )}

          {(activeToolTab === "docview" || activeToolTab === "diffview" || activeToolTab === "agents") && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: "var(--origin-fg-subtle)" }}>
              <Icon icon={TOOL_TABS.find(t => t.id === activeToolTab)?.icon ?? "lucide:file"} width={32} />
              <p className="text-sm font-medium">{TOOL_TABS.find(t => t.id === activeToolTab)?.label}</p>
              <p className="text-xs">Coming soon</p>
            </div>
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
