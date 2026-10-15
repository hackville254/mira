import { useState } from "react";
import { Icon } from "@iconify/react";

// ── Bannière « Undo all / Keep all » ─────────────────────────────────────────
//
// Affichée en fin de tour d'agent quand des fichiers ont été modifiés. Calquée
// sur le pattern Trae/Cursor : le tour est réversible en un clic tant que la
// bannière est vivante.

export default function TurnCheckpointCard({
  fileCount,
  files,
  undo,
  keep,
}: {
  fileCount: number;
  files: string[];
  undo: () => Promise<void>;
  keep: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"undo" | "keep" | null>(null);
  const [expanded, setExpanded] = useState(false);

  const base = files.map(f => f.split(/[/\\]/).pop() ?? f);
  const preview = base.slice(0, 2).join(", ");
  const extra = fileCount - base.slice(0, 2).length;

  const onUndo = async () => { setBusy("undo"); try { await undo(); } finally { setBusy(null); } };
  const onKeep = async () => { setBusy("keep"); try { await keep(); } finally { setBusy(null); } };

  return (
    <div
      style={{
        margin: "6px 0",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "8px",
        backgroundColor: "var(--origin-bg-base)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Icon icon="lucide:git-compare" width={14} style={{ color: "var(--origin-fg-muted)", flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: "12px", color: "var(--origin-fg-default)", minWidth: 0 }}>
          {busy
            ? "Restoring…"
            : `Modified ${fileCount} file${fileCount === 1 ? "" : "s"} — ${preview}${extra > 0 ? ` and ${extra} more` : ""}`}
        </span>
        {fileCount > 2 && (
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--origin-fg-subtle)", fontSize: "11px", padding: 0, flexShrink: 0 }}
          >
            {expanded ? "Hide" : "Show all"}
          </button>
        )}
      </div>

      {expanded && (
        <ul style={{ margin: 0, padding: "0 0 0 22px", fontSize: "11px", color: "var(--origin-fg-muted)", fontFamily: "var(--font-mono)", lineHeight: 1.6 }}>
          {files.map((f, i) => (
            <li key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f}</li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button
          onClick={onUndo}
          disabled={busy !== null}
          style={{
            display: "flex", alignItems: "center", gap: "5px",
            padding: "4px 10px", borderRadius: "6px", cursor: busy ? "default" : "pointer",
            fontSize: "12px", border: "1px solid var(--origin-border-default)",
            background: "var(--origin-bg-active)", color: "var(--origin-fg-default)",
            opacity: busy === "keep" ? 0.5 : 1,
          }}
        >
          <Icon icon="lucide:undo-2" width={13} />
          Undo all
        </button>
        <button
          onClick={onKeep}
          disabled={busy !== null}
          style={{
            display: "flex", alignItems: "center", gap: "5px",
            padding: "4px 10px", borderRadius: "6px", cursor: busy ? "default" : "pointer",
            fontSize: "12px", border: "1px solid var(--origin-accent-default, #6366f1)",
            background: "var(--origin-accent-default, #6366f1)", color: "#fff",
            opacity: busy === "undo" ? 0.5 : 1,
          }}
        >
          <Icon icon="lucide:check" width={13} />
          Keep all
        </button>
      </div>
    </div>
  );
}
