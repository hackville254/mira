import { useState } from "react";
import { Icon } from "@iconify/react";
import { useTodos } from "../../lib/agent/todoStore";

// ── TodoList épinglée au-dessus de l'input ───────────────────────────────────
//
// Affiche en direct la todo list que l'agent maintient via `todo_write`. Elle
// reste compacte (résumé + barre de progression) et se déplie au clic. Elle
// disparaît dès que tout est terminé/annulé — pas de bruit dans l'UI.

const STATUS_ICON: Record<string, string> = {
  pending:     "lucide:circle",
  in_progress: "lucide:loader-circle",
  done:        "lucide:check-circle-2",
  cancelled:   "lucide:x-circle",
};

const STATUS_COLOR: Record<string, string> = {
  pending:     "var(--origin-fg-subtle)",
  in_progress: "var(--origin-accent-blue)",
  done:        "var(--origin-semantic-success)",
  cancelled:   "var(--origin-fg-subtle)",
};

export default function PinnedTodoList({ sessionId }: { sessionId: string | null | undefined }) {
  const todos = useTodos(sessionId);
  const [expanded, setExpanded] = useState(false);

  if (todos.length === 0) return null;

  const done = todos.filter(t => t.status === "done").length;
  const cancelled = todos.filter(t => t.status === "cancelled").length;
  const active = todos.filter(t => t.status !== "done" && t.status !== "cancelled");

  // Tout est terminé : on masque la liste (l'utilisateur n'a plus rien à suivre).
  if (active.length === 0) return null;

  const current = todos.find(t => t.status === "in_progress") ?? active[0];
  const percent = Math.round((done / todos.length) * 100);
  const finished = done + cancelled;

  return (
    <div
      style={{
        margin: "0 10px 0",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "8px",
        backgroundColor: "var(--origin-bg-base)",
        overflow: "hidden",
      }}
    >
      {/* Ligne résumé (toujours visible) */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: "8px",
          padding: "6px 10px", background: "none", border: "none", cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Icon icon="lucide:list-checks" width={13} style={{ color: "var(--origin-fg-muted)", flexShrink: 0 }} />
        <span style={{ fontSize: "11px", color: "var(--origin-fg-muted)", flexShrink: 0 }}>
          {finished}/{todos.length}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: "12px", color: "var(--origin-fg-default)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {current.content}
        </span>
        <div style={{
          width: "60px", height: "4px", borderRadius: "9999px",
          backgroundColor: "var(--origin-bg-active)", flexShrink: 0, overflow: "hidden",
        }}>
          <div style={{
            width: `${percent}%`, height: "100%",
            backgroundColor: "var(--origin-semantic-success)",
            transition: "width 0.25s ease",
          }} />
        </div>
        <Icon
          icon="lucide:chevron-down"
          width={13}
          style={{ color: "var(--origin-fg-subtle)", flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}
        />
      </button>

      {/* Détail (déplié) */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--origin-border-default)", padding: "6px 10px", display: "flex", flexDirection: "column", gap: "4px" }}>
          {todos.map(t => (
            <div key={t.id} style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
              <Icon
                icon={STATUS_ICON[t.status] ?? "lucide:circle"}
                width={12}
                style={{
                  color: STATUS_COLOR[t.status] ?? "var(--origin-fg-subtle)",
                  flexShrink: 0, marginTop: "2px",
                  animation: t.status === "in_progress" ? "spin 1.2s linear infinite" : "none",
                }}
              />
              <span style={{
                fontSize: "12px", lineHeight: 1.5,
                color: t.status === "done" || t.status === "cancelled" ? "var(--origin-fg-subtle)" : "var(--origin-fg-default)",
                textDecoration: t.status === "cancelled" ? "line-through" : "none",
              }}>
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
