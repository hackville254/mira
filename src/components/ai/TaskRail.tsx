import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useWorkspace } from "../../context/WorkspaceContext";
import { lsForPath } from "../../lib/sessionStore";
import type { DbSession } from "../../lib/db";

const MIN_WIDTH = 180;
const MAX_WIDTH = 320;
const DEFAULT_WIDTH = 240;
const WIDTH_KEY = "origin-ai-task-rail-width";
const COLLAPSED_KEY = "origin-ai-task-rail-collapsed";

/**
 * Left rail of the Agent mode: task list + "New Task" entry point.
 * Sessions are read straight from the persisted store so the rail stays decoupled
 * from AiPanel's internal state.
 */
export default function TaskRail({
  activeSessionId,
  onSelect,
  onNewTask,
}: {
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewTask: () => void;
}) {
  const { folderPath } = useWorkspace();
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const [width, setWidth] = useState(() => {
    const n = parseInt(localStorage.getItem(WIDTH_KEY) ?? "", 10);
    return isNaN(n) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Reload the task list whenever the workspace or active session changes.
  useEffect(() => {
    setSessions(lsForPath(folderPath ?? ""));
  }, [folderPath, activeSessionId]);

  const startResize = (e: React.MouseEvent) => {
    if (collapsed) return;
    e.preventDefault();
    function onMove(ev: MouseEvent) {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      setWidth(next);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setWidth(w => { localStorage.setItem(WIDTH_KEY, String(w)); return w; });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, String(next));
  };

  if (collapsed) {
    return (
      <div
        style={{
          width: 40, flexShrink: 0,
          backgroundColor: "var(--origin-bg-sidebar)",
          borderRight: "1px solid var(--origin-border-default)",
          display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: 8,
        }}
      >
        <button
          onClick={toggleCollapse}
        title="Expand task rail"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--origin-fg-muted)",
            padding: 6, borderRadius: 6,
          }}
        >
          <Icon icon="lucide:panel-left" width={18} />
        </button>
        <button
          onClick={onNewTask}
          title="New Task"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--origin-fg-default)",
            padding: 6, borderRadius: 6, marginTop: 8,
          }}
        >
          <Icon icon="lucide:plus" width={18} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col shrink-0 overflow-hidden"
      style={{ width, backgroundColor: "var(--origin-bg-sidebar)" }}
    >
      {/* New Task */}
      <div style={{ padding: "10px 10px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <button
            onClick={toggleCollapse}
            title="Collapse task rail"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--origin-fg-muted)", padding: 4, borderRadius: 4,
            }}
          >
            <Icon icon="lucide:panel-left-close" width={16} />
          </button>
          <button
            onClick={onNewTask}
            className="flex items-center gap-2 flex-1 rounded-md"
            style={{
              padding: "8px 10px",
              background: "var(--origin-bg-base)",
              border: "1px solid var(--origin-border-default)",
              color: "var(--origin-fg-default)",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-base)"; }}
          >
            <Icon icon="lucide:plus" width={14} />
            <span style={{ flex: 1, textAlign: "left" }}>New Task</span>
            <span style={{ fontSize: "10px", color: "var(--origin-fg-subtle)" }}>⌘⇧N</span>
          </button>
        </div>
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 10px" }}>
        {sessions.length === 0 ? (
          <div style={{ padding: "12px 8px", fontSize: "12px", color: "var(--origin-fg-subtle)", lineHeight: 1.55 }}>
            No tasks yet. Start one to keep your work here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {sessions.map(s => {
              const isActive = s.id === activeSessionId;
              return (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  onMouseEnter={() => setHoveredId(s.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    display: "flex", flexDirection: "column", gap: "4px",
                    width: "100%", textAlign: "left", cursor: "pointer",
                    padding: "8px 9px", borderRadius: "7px",
                    background: isActive
                      ? "var(--origin-bg-active)"
                      : hoveredId === s.id
                        ? "var(--origin-bg-hover)"
                        : "transparent",
                    border: "1px solid " + (isActive ? "var(--origin-border-default)" : "transparent"),
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                    <Icon icon="lucide:check-circle" width={12} style={{ color: "var(--origin-semantic-success)", flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title || "Untitled task"}
                    </span>
                  </div>
                  <span style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", paddingLeft: "18px" }}>
                    Completed · {new Date(s.updated_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize z-10"
        style={{ backgroundColor: "transparent" }}
        onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-border-default)"; }}
        onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
      />
    </div>
  );
}
