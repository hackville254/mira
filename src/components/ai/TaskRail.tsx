import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useWorkspace } from "../../context/WorkspaceContext";
import { lsForPath } from "../../lib/sessionStore";
import { formatShortcut } from "../../lib/platform";
import { groupTasks, isGroupFolded, type GroupableTask } from "../../lib/agent/taskGrouping";
import { useTaskSnapshots, type TaskRunStatus } from "../../lib/agent/taskRuntime";
import { AUTO_FOLD_KEY } from "../settings/SettingsPanel";
import type { DbSession } from "../../lib/db";

const MIN_WIDTH = 180;
const MAX_WIDTH = 320;
const DEFAULT_WIDTH = 240;
const WIDTH_KEY = "origin-ai-task-rail-width";
const COLLAPSED_KEY = "origin-ai-task-rail-collapsed";

/** Icône + couleur + libellé d'un statut de tâche (parité Trae). Sert à rendre
 *  le multitâche lisible : on voit d'un coup d'œil QUI travaille. */
function statusVisual(status: TaskRunStatus, waitingTool?: string): {
  icon: string; color: string; label: string; spin?: boolean;
} {
  switch (status) {
    case "running":
      return { icon: "lucide:loader-circle", color: "var(--origin-semantic-info, #60a5fa)", label: "Running", spin: true };
    case "waiting":
      return {
        icon: "lucide:loader-circle",
        color: "var(--origin-semantic-warning, #fbbf24)",
        label: waitingTool ? `Waiting · ${waitingTool}` : "Waiting",
        spin: true,
      };
    case "interrupted":
      return { icon: "lucide:circle-slash", color: "var(--origin-fg-subtle)", label: "Interrupted" };
    case "completed":
      return { icon: "lucide:check-circle", color: "var(--origin-semantic-success)", label: "Completed" };
    default:
      return { icon: "lucide:circle", color: "var(--origin-fg-subtle)", label: "Idle" };
  }
}

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
  // Auto-fold : replie les groupes de tâches entièrement terminés (réglage Settings > Conversation).
  const [autoFold, setAutoFold] = useState(() => localStorage.getItem(AUTO_FOLD_KEY) !== "false");
  // Groupes repliés manuellement (état d'UI uniquement, non persisté).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // Horodatage de référence pour le regroupement, rafraîchi à chaque reload de la liste.
  const [now, setNow] = useState(0);
  // MULTITASKING : statuts RÉELS par session (running / waiting / completed /
  // interrupted). Le rail reflète donc ce qui travaille VRAIMENT, y compris les
  // tâches en arrière-plan — plus de « Completed » codé en dur.
  const snapshots = useTaskSnapshots();
  const statusById = useMemo(() => {
    const map = new Map<string, { status: TaskRunStatus; waitingTool?: string }>();
    for (const s of snapshots) map.set(s.sessionId, { status: s.status, waitingTool: s.waitingTool });
    return map;
  }, [snapshots]);

  // Reload the task list whenever the workspace or active session changes.
  useEffect(() => {
    setSessions(lsForPath(folderPath ?? ""));
    setNow(Date.now());
  }, [folderPath, activeSessionId]);

  // Réagit au réglage modifié depuis SettingsPanel sans rechargement.
  useEffect(() => {
    function onPrefs(e: Event) {
      const detail = (e as CustomEvent<{ autoFold?: boolean }>).detail;
      if (typeof detail?.autoFold === "boolean") setAutoFold(detail.autoFold);
    }
    window.addEventListener("origin:conversation-prefs", onPrefs);
    return () => window.removeEventListener("origin:conversation-prefs", onPrefs);
  }, []);

  // Les tâches actives (non terminées) sont marquées explicitement pour que
  // l'auto-fold ne replie jamais un groupe contenant du travail en cours.
  // MULTITASKING : « terminée » se déduit du STATUT RÉEL — une tâche qui tourne
  // en arrière-plan (running/waiting) n'est jamais repliée, même si elle n'est
  // pas la session affichée.
  const groups = useMemo(() => {
    const tasks: GroupableTask[] = sessions.map(s => {
      const st = statusById.get(s.id)?.status ?? "idle";
      const active = st === "running" || st === "waiting";
      return {
        id: s.id,
        updated_at: s.updated_at,
        completed: !active,
      };
    });
    return groupTasks(tasks, now);
  }, [sessions, statusById, now]);

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
            <span style={{ fontSize: "10px", color: "var(--origin-fg-subtle)" }}>{formatShortcut("ctrl+shift+n")}</span>
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
            {groups.map(group => {
              // Un groupe entièrement terminé est replié par défaut quand l'auto-fold est actif.
              // L'utilisateur peut forcer l'ouverture/fermeture via l'en-tête.
              const defaultOpen = !isGroupFolded(group, autoFold);
              const open = openGroups[group.id] ?? defaultOpen;
              return (
                <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <button
                    onClick={() => setOpenGroups(prev => ({ ...prev, [group.id]: !open }))}
                    style={{
                      display: "flex", alignItems: "center", gap: "4px",
                      background: "none", border: "none", cursor: "pointer",
                      padding: "6px 6px 4px", color: "var(--origin-fg-subtle)",
                    }}
                  >
                    <Icon
                      icon={open ? "lucide:chevron-down" : "lucide:chevron-right"}
                      width={12}
                      style={{ flexShrink: 0 }}
                    />
                    <span style={{ fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      {group.label}
                    </span>
                    <span style={{ fontSize: "10px", opacity: 0.7 }}>{group.items.length}</span>
                  </button>
                  {open && group.items.map(t => {
                    const s = sessions.find(x => x.id === t.id)!;
                    const isActive = s.id === activeSessionId;
                    // Statut réel : une tâche sans entrée dans le registre est
                    // « idle » (déjà terminée, aucun run dans ce process).
                    const snap = statusById.get(s.id);
                    const status: TaskRunStatus = snap?.status ?? "idle";
                    const vis = statusVisual(status, snap?.waitingTool);
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
                          <Icon
                            icon={vis.icon}
                            width={12}
                            style={{
                              color: vis.color,
                              flexShrink: 0,
                              animation: vis.spin ? "origin-spin 1s linear infinite" : undefined,
                            }}
                          />
                          <span style={{ flex: 1, fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.title || "Untitled task"}
                          </span>
                        </div>
                        <span style={{ fontSize: "10px", color: vis.color, paddingLeft: "18px" }}>
                          {vis.label} · {new Date(s.updated_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </button>
                    );
                  })}
                </div>
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
