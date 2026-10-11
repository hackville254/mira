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
import type { AiCompletionFn } from "../../lib/aiAutocomplete";

type ToolTab = "editor" | "browser" | "terminal";

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
    handleSave, setPinnedContext, setCursorPositions, openAiDiffTab,
    getAiCompletion, handleMissingServer, onDefinitionJump,
    terminalRef, terminalHeight, setTerminalHeight, setTerminalOpen,
  } = props;

  // Session bridging between TaskRail and AiPanel.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [newChatNonce, setNewChatNonce] = useState(0);

  // Tool panel tabs. The panels start collapsed so the Agent surface gets the
  // most room by default; the user expands them on demand.
  const [toolTab, setToolTab] = useState<ToolTab>("editor");
  const [toolsOpen, setToolsOpen] = useState(false);

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

      {/* Tool panels (center) — collapsed by default */}
      {toolsOpen ? (
        <div className="flex flex-1 flex-col overflow-hidden gap-1">
          {/* Tool tabs */}
          <div
            style={{
              display: "flex", alignItems: "center",
              height: 36, flexShrink: 0,
              backgroundColor: "var(--origin-bg-panel)",
              borderBottom: "1px solid var(--origin-border-default)",
            }}
          >
            {(["editor", "browser", "terminal"] as ToolTab[]).map(t => (
              <button
                key={t}
                onClick={() => setToolTab(t)}
                style={{
                  padding: "0 16px", height: "100%",
                  background: toolTab === t ? "var(--origin-bg-editor)" : "transparent",
                  border: "none", borderBottom: toolTab === t ? "2px solid var(--origin-accent-blue)" : "2px solid transparent",
                  color: toolTab === t ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                  cursor: "pointer", fontSize: "12px", fontWeight: 600,
                  textTransform: "capitalize",
                }}
              >
                {t}
              </button>
            ))}
            <button
              onClick={() => setToolsOpen(false)}
              title="Collapse tool panels"
              style={{
                marginLeft: "auto", marginRight: 8,
                background: "none", border: "none", cursor: "pointer",
                color: "var(--origin-fg-muted)", padding: 4, borderRadius: 4,
              }}
            >
              <Icon icon="lucide:panel-right-close" width={16} />
            </button>
          </div>

          {/* Tool content */}
          <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
            {toolTab === "editor" && (
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
                <div className="flex-1 flex overflow-hidden" style={{ position: "relative" }}>
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

            {toolTab === "browser" && <WebPreviewPane />}

            {toolTab === "terminal" && (
              <TerminalPanel
                ref={terminalRef}
                cwd={folderPath ?? "."}
                height={terminalHeight}
                onResize={setTerminalHeight}
                onClose={() => setTerminalOpen(false)}
                hidden={false}
              />
            )}
          </div>
        </div>
      ) : (
        /* Collapsed tool rail */
        <div
          style={{
            width: 40, flexShrink: 0,
            backgroundColor: "var(--origin-bg-sidebar)",
            borderRight: "1px solid var(--origin-border-default)",
            borderLeft: "1px solid var(--origin-border-default)",
            display: "flex", flexDirection: "column", alignItems: "center",
            paddingTop: 8, gap: 4,
          }}
        >
          {([
            { id: "editor" as ToolTab, icon: "lucide:code-2", label: "Editor" },
            { id: "browser" as ToolTab, icon: "lucide:globe", label: "Browser" },
            { id: "terminal" as ToolTab, icon: "lucide:terminal", label: "Terminal" },
          ]).map(({ id, icon, label }) => (
            <button
              key={id}
              onClick={() => { setToolTab(id); setToolsOpen(true); }}
              title={label}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: toolTab === id ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                padding: 8, borderRadius: 6,
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <Icon icon={icon} width={18} />
            </button>
          ))}
        </div>
      )}

      {/* Explorer (right) */}
      <Sidebar
        onFileOpen={openTab}
        onFileOpenAtLine={openTabAtLine}
        fileTreeKey={fileTreeVersion}
      />
    </div>
  );
}
