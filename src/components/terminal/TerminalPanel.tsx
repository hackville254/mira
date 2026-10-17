import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { getSetting, setSetting, type SavedTermTab } from "../../lib/settings";
import { terminalShellName } from "../../lib/terminal";
import { formatShortcut } from "../../lib/platform";
import TerminalInstance from "./Terminal";
import AgentTerminalView from "./AgentTerminalView";
import { useAgentTerminal } from "../../lib/agent/agentTerminalStore";
import ProblemsPanel from "../problems/ProblemsPanel";
import OutputPanel from "../output/OutputPanel";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const LS_TABS = "origin-terminal-tabs";
const LS_ACTIVE = "origin-terminal-active-index";
/** Onglet réservé au terminal de l'agent (clé négative : jamais un tab utilisateur). */
const AGENT_TAB_ID = -1;

interface TermTab {
  id: number;
  name: string;
  cwd: string;
}

interface TabShellInfo {
  state: 'idle' | 'running';
  exitCode?: number;
}

export interface TerminalPanelHandle {
  addTab: () => void;
  clearActive: () => void;
  killActive: () => void;
  runInNewTab: (command: string) => void;
  /** Lance une tâche « Run » dans un nouvel onglet (spawn argv, sans shell). */
  runTaskInNewTab: (name: string, program: string, args: string[]) => void;
  /** Ouvre l'onglet Problems dans le panneau bas. */
  showProblems: () => void;
  /** Ouvre l'onglet Output dans le panneau bas. */
  showOutput: () => void;
}

interface Props {
  cwd: string;
  height: number;
  onResize: (h: number) => void;
  onClose: () => void;
  hidden?: boolean;
  /** Racine du workspace, pour afficher des chemins relatifs dans Problems. */
  rootPath?: string | null;
  /** Ouverture d'un fichier à une ligne (clic sur un diagnostic). */
  onOpenFile?: (path: string, line: number, col: number) => void;
  /**
   * Session d'agent dont on veut suivre le terminal (mode IA/IDE). Quand elle est
   * fournie, un onglet « Agent » en LECTURE SEULE apparaît dans la liste : il
   * affiche, en direct, les commandes shell que l'agent exécute. Le client ne
   * peut rien y taper — c'est un miroir, pas un shell.
   */
  agentSessionId?: string | null;
}

type BottomView = 'terminal' | 'problems' | 'output';

// ── Helpers ──────────────────────────────────────────────────────────────────

function initCounter(tabs: TermTab[]): number {
  return tabs.length + 1;
}

function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function defaultTabName(shell: string, cwd: string): string {
  return `${shell} ${folderName(cwd)}`;
}

function nextTabName(currentTabs: TermTab[], shell: string, cwd: string): string {
  const base = defaultTabName(shell, cwd);
  if (!currentTabs.some((t) => t.name === base)) return base;
  let n = 2;
  while (currentTabs.some((t) => t.name === `${base} (${n})`)) n++;
  return `${base} (${n})`;
}

function loadSavedTabs(defaultCwd: string, shell: string): TermTab[] {
  try {
    const raw = localStorage.getItem(LS_TABS);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedTermTab[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((t, i) => ({ id: i + 1, name: t.name, cwd: defaultCwd }));
      }
    }
  } catch { /* stored tab state is missing or malformed — start fresh */ }
  return [{ id: 1, name: defaultTabName(shell, defaultCwd), cwd: defaultCwd }];
}

function loadSavedActiveIndex(tabCount: number): number {
  const n = parseInt(localStorage.getItem(LS_ACTIVE) ?? "0", 10);
  return isNaN(n) ? 0 : Math.min(n, tabCount - 1);
}

function saveTabs(tabs: TermTab[]) {
  const data = tabs.map((t) => ({ name: t.name, cwd: t.cwd }));
  localStorage.setItem(LS_TABS, JSON.stringify(data));
  setSetting("terminal.tabs", data);
}

function saveActiveIndex(tabs: TermTab[], activeId: number) {
  const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  localStorage.setItem(LS_ACTIVE, String(idx));
  setSetting("terminal.activeIndex", idx);
}

// ── Small reusable button ─────────────────────────────────────────────────────

function PanelBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 20,
        height: 20,
        flexShrink: 0,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "var(--origin-fg-muted)",
        borderRadius: 3,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "var(--origin-bg-hover)";
        (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-default)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-muted)";
      }}
    >
      {children}
    </button>
  );
}

/** Pastille « live » du terminal agent : bleue pulsée tant que la commande tourne. */
function AgentLiveBadge({ sessionId }: { sessionId: string }) {
  const { running } = useAgentTerminal(sessionId);
  if (!running) return null;
  return (
    <span
      title="Commande en cours"
      style={{
        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
        backgroundColor: "var(--origin-accent-blue)",
        animation: "pulse 1.2s ease-in-out infinite",
        display: "inline-block",
      }}
    />
  );
}

function ShellDot({ info }: { info: TabShellInfo | undefined }) {
  if (!info) return null;
  if (info.state === 'running') {
    return (
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        backgroundColor: 'var(--origin-accent-blue)',
        animation: 'pulse 1.2s ease-in-out infinite',
        display: 'inline-block',
      }} />
    );
  }
  if (info.exitCode !== undefined) {
    return (
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        backgroundColor: info.exitCode === 0 ? 'var(--origin-semantic-success)' : 'var(--origin-semantic-error)',
        display: 'inline-block',
      }} />
    );
  }
  return null;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel({ cwd, height, onResize, onClose, hidden, rootPath = null, onOpenFile, agentSessionId = null }, ref) {
  const [view, setView] = useState<BottomView>('terminal');
  const [tabs, setTabs] = useState<TermTab[]>(() => loadSavedTabs(cwd, "bash"));
  const [activeId, setActiveId] = useState<number>(() => {
    const idx = loadSavedActiveIndex(tabs.length);
    return tabs[idx]?.id ?? tabs[0].id;
  });
  const shellRef = useRef("bash");
  const nextId = useRef(initCounter(tabs));
  const prevCwdRef = useRef(cwd);
  const [clearKeys, setClearKeys] = useState<Record<number, number>>({});
  const [pendingInputs, setPendingInputs] = useState<Record<number, string>>({});
  const [taskSpawns, setTaskSpawns] = useState<Record<number, { program: string; args: string[] }>>({});
  const [shellInfos, setShellInfos] = useState<Record<number, TabShellInfo>>({});
  const [hoveredTab, setHoveredTab] = useState<number | null>(null);
  const exitClearTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useImperativeHandle(ref, () => ({
    addTab() { setView('terminal'); addTab(); },
    clearActive() {
      setClearKeys(prev => ({ ...prev, [activeId]: (prev[activeId] ?? 0) + 1 }));
    },
    killActive() {
      closeTab(activeId);
    },
    runInNewTab(command: string) {
      const id = nextId.current++;
      const name = nextTabName(tabs, shellRef.current, cwd);
      setTabs((prev) => [...prev, { id, name, cwd }]);
      setActiveId(id);
      setPendingInputs(prev => ({ ...prev, [id]: command }));
      setView('terminal');
    },
    runTaskInNewTab(name: string, program: string, args: string[]) {
      const id = nextId.current++;
      setTabs((prev) => [...prev, { id, name, cwd }]);
      setActiveId(id);
      setTaskSpawns(prev => ({ ...prev, [id]: { program, args } }));
      setView('terminal');
    },
    showProblems() { setView('problems'); },
    showOutput() { setView('output'); },
  }));

  // ── Resolve the real shell name, then restore/create the initial tab ─────
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      terminalShellName().catch(() => "bash"),
      getSetting("terminal.tabs"),
      getSetting("terminal.activeIndex"),
    ]).then(([shell, savedTabs, savedIdx]) => {
      if (cancelled) return;
      shellRef.current = shell;
      if (savedTabs.length > 0) {
        // Migrate legacy numeric tab names ("1", "2"…) to "<shell> <folder>".
        const restored = savedTabs.map((t, i) => ({
          id: i + 1,
          name: /^\d+$/.test(t.name) ? defaultTabName(shell, cwd) : t.name,
          cwd,
        }));
        setTabs(restored);
        nextId.current = initCounter(restored);
        setActiveId(restored[savedIdx]?.id ?? restored[0].id);
      } else {
        const fresh: TermTab[] = [{ id: 1, name: defaultTabName(shell, cwd), cwd }];
        setTabs(fresh);
        setActiveId(fresh[0].id);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once on mount; cwd is intentionally the initial value
  }, []);

  // ── Persist tab list whenever it changes ────────────────────────────────
  useEffect(() => {
    saveTabs(tabs);
  }, [tabs]);

  useEffect(() => {
    saveActiveIndex(tabs, activeId);
  }, [activeId, tabs]);

  // ── Resize drag ──────────────────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };

      function onMove(ev: MouseEvent) {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        onResize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + delta)));
      }

      function onUp() {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [height, onResize],
  );

  // ── Reset tabs when project folder changes ───────────────────────────────
  useEffect(() => {
    if (cwd === prevCwdRef.current) return;
    prevCwdRef.current = cwd;
    const newId = nextId.current++;
    const fresh: TermTab[] = [{ id: newId, name: defaultTabName(shellRef.current, cwd), cwd }];
    setTabs(fresh);
    setActiveId(newId);
  }, [cwd]);

  // ── Onglet effectivement affiché ─────────────────────────────────────────
  // Si l'onglet « Agent » était sélectionné mais que le terminal de l'agent
  // n'existe plus (fin de run), on retombe sur le premier onglet utilisateur —
  // sans setState dans un effet (simple dérivation au rendu).
  const effectiveActiveId = (!agentSessionId && activeId === AGENT_TAB_ID)
    ? (tabs[0]?.id ?? activeId)
    : activeId;

  // ── Tab management ───────────────────────────────────────────────────────
  function addTab() {
    const id = nextId.current++;
    const name = nextTabName(tabs, shellRef.current, cwd);
    setTabs((prev) => [...prev, { id, name, cwd }]);
    setActiveId(id);
  }

  function closeTab(id: number) {
    if (exitClearTimers.current[id]) {
      clearTimeout(exitClearTimers.current[id]);
      delete exitClearTimers.current[id];
    }
    setShellInfos(prev => { const c = { ...prev }; delete c[id]; return c; });
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        onClose();
        return prev;
      }
      if (activeId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        const fallback = next[idx] ?? next[idx - 1];
        setActiveId(fallback.id);
      }
      return next;
    });
  }

  function handleCwdChange(tabId: number, cwd: string) {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, cwd } : t));
  }

  function handleShellState(tabId: number, state: 'idle' | 'running', exitCode?: number) {
    if (exitClearTimers.current[tabId]) {
      clearTimeout(exitClearTimers.current[tabId]);
      delete exitClearTimers.current[tabId];
    }
    setShellInfos(prev => ({
      ...prev,
      [tabId]: { state, exitCode: state === 'idle' ? exitCode : undefined },
    }));
    if (state === 'idle' && exitCode === 0) {
      exitClearTimers.current[tabId] = setTimeout(() => {
        delete exitClearTimers.current[tabId];
        setShellInfos(prev => {
          const info = prev[tabId];
          if (!info || info.exitCode !== 0) return prev;
          return { ...prev, [tabId]: { ...info, exitCode: undefined } };
        });
      }, 2000);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        height,
        flexShrink: 0,
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        backgroundColor: "var(--origin-bg-panel)",
      }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        style={{ height: 4, flexShrink: 0, cursor: "row-resize" }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "var(--origin-border-default)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        }}
      />

      {/* Header */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 10,
          paddingRight: 6,
          borderBottom: "1px solid var(--origin-border-subtle)",
          userSelect: "none",
        }}
      >
        {/* Panel tabs */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2, overflow: "hidden" }}>
          {([['terminal', 'Terminal'], ['problems', 'Problems'], ['output', 'Output']] as const).map(([id, label]) => {
            const active = view === id;
            return (
              <button
                key={id}
                onClick={() => setView(id)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "0 8px", height: 22, borderRadius: 4, border: "none",
                  background: active ? "var(--origin-bg-active)" : "transparent",
                  color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                  fontSize: 12, fontWeight: active ? 600 : 400, cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* New terminal — only relevant in the Terminal view */}
        {view === "terminal" && (
          <PanelBtn onClick={addTab} title="New Terminal">
            <Plus size={13} />
          </PanelBtn>
        )}

        {/* Close panel */}
        <PanelBtn onClick={onClose} title={`Close Panel (${formatShortcut('ctrl+`')})`}>
          <X size={12} />
        </PanelBtn>
      </div>

      {view === "problems" ? (
        <ProblemsPanel
          rootPath={rootPath}
          onOpenFile={(path, line, col) => onOpenFile?.(path, line, col)}
        />
      ) : view === "output" ? (
        <OutputPanel />
      ) : (
      /* Body: terminal on the left, tab list on the right */
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Terminal instances — all mounted, only active is visible */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

          {/* Terminal de l'agent (lecture seule) — monté uniquement pendant un run */}
          {agentSessionId && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: effectiveActiveId === AGENT_TAB_ID ? 1 : 0,
                pointerEvents: effectiveActiveId === AGENT_TAB_ID ? "auto" : "none",
              }}
            >
              <AgentTerminalView sessionId={agentSessionId} active={effectiveActiveId === AGENT_TAB_ID} />
            </div>
          )}

          {tabs.map((tab) => (
            <div
              key={tab.id}
              style={{
                position: "absolute",
                inset: 0,
                opacity: tab.id === effectiveActiveId ? 1 : 0,
                pointerEvents: tab.id === effectiveActiveId ? "auto" : "none",
              }}
            >
              <TerminalInstance
                cwd={tab.cwd}
                active={tab.id === activeId}
                clearKey={clearKeys[tab.id] ?? 0}
                pendingInput={pendingInputs[tab.id]}
                task={taskSpawns[tab.id]}
                onCwdChange={(cwd) => handleCwdChange(tab.id, cwd)}
                onShellState={(state, exitCode) => handleShellState(tab.id, state, exitCode)}
              />
            </div>
          ))}
        </div>

        {/* Right-side tab list */}
        <div
          style={{
            width: 170,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
            paddingTop: 6,
            gap: 1,
          }}
        >
          {agentSessionId && (
            <div
              onClick={() => setActiveId(AGENT_TAB_ID)}
              title="Terminal de l'agent (lecture seule)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 28,
                paddingLeft: 12,
                paddingRight: 8,
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: effectiveActiveId === AGENT_TAB_ID ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                backgroundColor: effectiveActiveId === AGENT_TAB_ID
                  ? "var(--origin-bg-active)"
                  : hoveredTab === AGENT_TAB_ID
                    ? "var(--origin-bg-hover)"
                    : "transparent",
              }}
              onMouseEnter={() => setHoveredTab(AGENT_TAB_ID)}
              onMouseLeave={() => setHoveredTab((h) => (h === AGENT_TAB_ID ? null : h))}
            >
              <img src="/logo-code.svg" width={13} height={13} alt="" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Agent
              </span>
              <AgentLiveBadge sessionId={agentSessionId} />
            </div>
          )}

          {tabs.map((tab) => {
            const isActive = tab.id === effectiveActiveId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 28,
                  paddingLeft: 12,
                  paddingRight: 8,
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: isActive ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
                  backgroundColor: isActive
                    ? "var(--origin-bg-active)"
                    : hoveredTab === tab.id
                      ? "var(--origin-bg-hover)"
                      : "transparent",
                }}
                onMouseEnter={() => setHoveredTab(tab.id)}
                onMouseLeave={() => setHoveredTab((h) => (h === tab.id ? null : h))}
              >
                <SquareTerminal size={13} style={{ flexShrink: 0, opacity: 0.8 }} />
                <ShellDot info={shellInfos[tab.id]} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tab.name}
                </span>
                {(hoveredTab === tab.id || isActive) && (
                  <span
                    title="Kill Terminal"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 16,
                      height: 16,
                      borderRadius: 2,
                      color: "var(--origin-fg-muted)",
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-default)";
                      (e.currentTarget as HTMLElement).style.backgroundColor = "var(--origin-bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = "var(--origin-fg-muted)";
                      (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                    }}
                  >
                    <Trash2 size={13} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
});

export default TerminalPanel;
