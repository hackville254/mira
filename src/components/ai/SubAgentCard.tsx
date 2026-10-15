import { useState } from "react";
import { ChevronDown, ChevronRight, Check, Bot, AlertTriangle } from "lucide-react";
import type { SubAgentChild } from "../../lib/aiTypes";
import { toolVerb } from "../../lib/toolGroups";

// ── Carte de sous-agent (style Trae) ───────────────────────────────────────────
//
// Une ligne repliable « Search Agent │ Étudier le code source Cline › » qui, une
// fois dépliée, montre le rapport borné + les outils read-only réellement utilisés.
// Repliée par défaut ; l'état est local à la carte.

/** Libellé court d'issue — jamais un faux « done » : les arrêts durs sont visibles. */
function statusLabel(child: SubAgentChild): string {
  switch (child.status) {
    case undefined:      return "Working";
    case "completed":    return "Done";
    case "max_iterations": return "Stopped: step limit";
    case "max_tokens":   return "Stopped: token budget";
    case "timeout":      return "Stopped: timeout";
    case "cancelled":    return "Cancelled";
    case "error":        return "Failed";
  }
}

function isHardStop(child: SubAgentChild): boolean {
  return child.status !== undefined && child.status !== "completed";
}

export default function SubAgentCard({ child }: { child: SubAgentChild }) {
  const [expanded, setExpanded] = useState(false);
  const running = child.status === undefined;
  const hardStop = isHardStop(child);
  const tools = child.tools ?? [];

  return (
    <div style={{ margin: "4px 0", borderLeft: "2px solid var(--origin-border-default)", paddingLeft: "8px" }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: "6px", width: "100%",
          background: "none", border: "none", cursor: "pointer", padding: "3px 2px", textAlign: "left",
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = "0.85"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
      >
        {running ? (
          <div style={{
            width: 11, height: 11, flexShrink: 0,
            border: "1.5px solid var(--origin-fg-subtle)", borderTopColor: "var(--origin-accent-blue)",
            borderRadius: "50%", animation: "spin 0.8s linear infinite",
          }} />
        ) : hardStop ? (
          <AlertTriangle size={11} style={{ color: "var(--origin-semantic-warning, #d29922)", flexShrink: 0 }} />
        ) : (
          <Check size={11} style={{ color: "var(--origin-semantic-success)", flexShrink: 0 }} />
        )}

        <Bot size={12} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
        <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)", flexShrink: 0 }}>
          {child.role}
        </span>
        <span style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }}>│</span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: "12px", color: "var(--origin-fg-muted)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {child.task}
        </span>
        <span style={{ fontSize: "10px", color: running ? "var(--origin-fg-subtle)" : "var(--origin-fg-muted)", flexShrink: 0 }}>
          {statusLabel(child)}
        </span>
        {expanded
          ? <ChevronDown size={11} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />}
      </button>

      {expanded && (
        <div style={{ padding: "4px 0 6px 6px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {tools.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--origin-fg-subtle)" }}>
              {groupSummary(tools).map((s, i) => <span key={i}>{s}</span>)}
            </div>
          )}
          {child.report ? (
            <pre style={{
              margin: 0, padding: "8px 10px", borderRadius: "6px", fontSize: "11px", lineHeight: 1.55,
              fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word",
              background: "var(--origin-bg-active)", border: "1px solid var(--origin-border-default)",
              color: "var(--origin-fg-default)", maxHeight: 320, overflowY: "auto",
            }}>
              {child.report}
            </pre>
          ) : (
            <span style={{ fontSize: "11px", color: "var(--origin-fg-subtle)" }}>
              {running ? "Exploring…" : "No report."}
            </span>
          )}
          <div style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", fontFamily: "var(--font-mono)" }}>
            {child.iterations} step{child.iterations === 1 ? "" : "s"} · ≈{child.inputTokens.toLocaleString()} in · {child.outputTokens.toLocaleString()} out
          </div>
        </div>
      )}
    </div>
  );
}

/** Résumé « Read 3 files · Searched 2 times » des outils du sous-agent. */
function groupSummary(tools: SubAgentChild["tools"]): string[] {
  if (!tools) return [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const v = toolVerb(t.toolName);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out: string[] = [];
  const read = counts.get("read");
  if (read) out.push(`Read ${read} file${read > 1 ? "s" : ""}`);
  const search = counts.get("search");
  if (search) out.push(`Searched ${search} time${search > 1 ? "s" : ""}`);
  const list = counts.get("list");
  if (list) out.push(`Listed ${list} folder${list > 1 ? "s" : ""}`);
  return out;
}
