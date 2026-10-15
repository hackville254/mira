import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ToolCallDisplay } from "../../lib/aiTypes";
import { toolTargetPath } from "../../lib/toolGroups";

// ── Ligne de groupe d'outils (accordéon léger, style Trae) ────────────────────
//
// Rendu volontairement nu : une simple ligne de texte gris repliable
//   « Read 2 files, Searched files 2 times ⌄ »
// sans bordure, sans encadré, sans icône superflue. Déplié, il liste les cibles
// sous forme de chemins CLIQUABLES qui ouvrent le fichier dans l'éditeur.

export default function ToolGroupCard({
  label,
  tools,
  onOpenFile,
}: {
  label: string;
  tools: ToolCallDisplay[];
  onOpenFile?: (path: string, line?: number, col?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Un groupe est « en cours » tant qu'au moins un membre n'est pas terminé :
  // on l'indique par un chevron qui tourne plutôt que par une icône de statut
  // (l'accordéon reste ainsi minimal).
  const running = tools.some(t => t.status === "running");

  return (
    <div style={{ margin: "2px 0" }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: "4px",
          background: "none", border: "none", cursor: "pointer",
          padding: "2px 0", textAlign: "left",
          fontSize: "12px", color: "var(--origin-fg-subtle)",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "var(--origin-fg-subtle)"; }}
      >
        <span>{label}</span>
        {expanded
          ? <ChevronDown size={12} style={{ flexShrink: 0, opacity: running ? 0.5 : 1 }} />
          : <ChevronRight size={12} style={{ flexShrink: 0, opacity: running ? 0.5 : 1 }} />}
      </button>

      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", padding: "2px 0 2px 4px" }}>
          {tools.map(tc => {
            const path = toolTargetPath(tc);
            const isError = !!(tc.result as Record<string, unknown> | undefined)?.error;
            const clickable = !!path && !!onOpenFile && !isError;
            return (
              <span
                key={tc.id}
                onClick={clickable ? () => onOpenFile?.(path) : undefined}
                title={path || undefined}
                style={{
                  display: "block",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: isError ? "var(--origin-semantic-error)" : "var(--origin-fg-muted)",
                  padding: "1px 4px",
                  borderRadius: "3px",
                  cursor: clickable ? "pointer" : "default",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                onMouseEnter={e => { if (clickable) { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; } }}
                onMouseLeave={e => { if (clickable) { e.currentTarget.style.color = "var(--origin-fg-muted)"; e.currentTarget.style.backgroundColor = "transparent"; } }}
              >
                {path || shortTarget(tc)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Repli de secours quand l'outil n'a pas de chemin exploitable (grep, glob…). */
function shortTarget(tc: ToolCallDisplay): string {
  const a = (tc.args ?? {}) as Record<string, unknown>;
  if (tc.toolName === "grep") return `"${a.query ?? ""}"`;
  if (tc.toolName === "glob") return String(a.folder ?? "workspace");
  return tc.toolName;
}
