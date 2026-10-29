import { Bot, Check, AlertTriangle } from "lucide-react";
import { useSubAgents, type SubAgentSnapshot } from "../../lib/agent/swarmStore";
import type { SubAgentStatus } from "../../lib/agent/run";
import { renderRoleIcon } from "./roleIcon";

// ── Onglet « Agents » (mode IA) ────────────────────────────────────────────────
//
// Vue d'ensemble des sous-agents du tour courant : rôle, tâche, état, budget
// consommé. En mode IA, le root peut orchestrer plusieurs sous-agents read-only
// en parallèle ; cet onglet permet de les suivre sans polluer le fil de chat.
//
// Le registre ne contient QUE les sous-agents du tour en cours (il est purgé au
// début de chaque tour). L'historique complet reste dans les cartes du chat.

function statusLabel(status: SubAgentStatus | undefined): string {
  switch (status) {
    case undefined:        return "Working";
    case "completed":      return "Done";
    case "max_iterations": return "Stopped: step limit";
    case "max_tokens":     return "Stopped: token budget";
    case "timeout":        return "Stopped: timeout";
    case "cancelled":      return "Cancelled";
    case "error":          return "Failed";
  }
}

function statusColor(status: SubAgentStatus | undefined): string {
  if (status === undefined) return "var(--origin-accent-blue)";
  if (status === "completed") return "var(--origin-semantic-success)";
  return "var(--origin-semantic-warning, #d29922)";
}

/** Nombre de sous-agents affichés avant le « +N more ». */
const VISIBLE_LIMIT = 20;

export default function AgentPanel() {
  const agents = useSubAgents();
  const visible = agents.slice(0, VISIBLE_LIMIT);
  const hidden = agents.length - visible.length;
  const activeCount = agents.filter(a => a.status === undefined).length;

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: "var(--origin-fg-subtle)" }}>
        <Bot width={32} />
        <p className="text-sm font-medium" style={{ color: "var(--origin-fg-muted)" }}>No sub-agents</p>
        <p className="text-xs" style={{ maxWidth: 320, textAlign: "center", lineHeight: 1.5 }}>
          In AI mode, the main agent can delegate read-only explorations to sub-agents.
          They appear here while they work.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--origin-border-default)", display: "flex", alignItems: "center", gap: "8px" }}>
        <Bot size={14} style={{ color: "var(--origin-fg-muted)" }} />
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
          {agents.length} sub-agent{agents.length > 1 ? "s" : ""}
        </span>
        <span style={{ fontSize: "11px", color: "var(--origin-fg-subtle)" }}>
          {activeCount} active
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {visible.map(agent => <Row key={agent.spawnId} agent={agent} />)}
        {hidden > 0 && (
          <div style={{ padding: "8px 14px", fontSize: "11px", color: "var(--origin-fg-subtle)" }}>
            +{hidden} more
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ agent }: { agent: SubAgentSnapshot }) {
  const running = agent.status === undefined;
  const color = statusColor(agent.status);

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--origin-border-default)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {running ? (
          <div style={{
            width: 11, height: 11, flexShrink: 0,
            border: "1.5px solid var(--origin-fg-subtle)", borderTopColor: color,
            borderRadius: "50%", animation: "spin 0.8s linear infinite",
          }} />
        ) : agent.status === "completed" ? (
          <Check size={11} style={{ color, flexShrink: 0 }} />
        ) : (
          <AlertTriangle size={11} style={{ color, flexShrink: 0 }} />
        )}
        {renderRoleIcon(agent.role, { size: 12, style: { color: "var(--origin-fg-muted)", flexShrink: 0 } })}
        <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{agent.role}</span>
        <span style={{ marginLeft: "auto", fontSize: "10px", color }}>{statusLabel(agent.status)}</span>
      </div>
      <div style={{ marginTop: "3px", fontSize: "12px", color: "var(--origin-fg-muted)", lineHeight: 1.5 }}>
        {agent.task}
      </div>
      <div style={{ marginTop: "3px", fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--origin-fg-subtle)" }}>
        {agent.iterations} step{agent.iterations === 1 ? "" : "s"} · ≈{agent.inputTokens.toLocaleString()} in · {agent.outputTokens.toLocaleString()} out
      </div>
    </div>
  );
}
