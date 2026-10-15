import { useState } from "react";
import { Icon } from "@iconify/react";
import type { TurnFileDelta } from "../../lib/turnCheckpoint";

// ── Bannière de checkpoint de tour ───────────────────────────────────────────
//
// Reproduction du bloc de revue Trae/Cursor : une liste pleine largeur des
// fichiers modifiés pendant le tour, chacun avec son delta `+N/-N` et un chevron
// qui ouvre le diff dans l'éditeur ; en pied, « N files to review » et les
// actions globales « Undo all » / « Keep all ».

export default function TurnCheckpointCard({
  files,
  undo,
  keep,
  onOpenDiff,
}: {
  files: TurnFileDelta[];
  undo: () => Promise<void>;
  keep: () => Promise<void>;
  /** Ouvre le diff d'un fichier (avant le tour → état courant). */
  onOpenDiff?: (file: TurnFileDelta) => void;
}) {
  const [busy, setBusy] = useState<"undo" | "keep" | null>(null);

  const onUndo = async () => { setBusy("undo"); try { await undo(); } finally { setBusy(null); } };
  const onKeep = async () => { setBusy("keep"); try { await keep(); } finally { setBusy(null); } };

  return (
    <div
      style={{
        margin: "6px 0",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "8px",
        backgroundColor: "var(--origin-bg-base)",
        overflow: "hidden",
        fontSize: "12px",
      }}
    >
      {/* Liste des fichiers : une ligne par fichier, cliquable. */}
      <div style={{ display: "flex", flexDirection: "column", padding: "4px" }}>
        {files.map(f => (
          <FileRow
            key={f.path}
            file={f}
            disabled={busy !== null}
            onClick={onOpenDiff ? () => onOpenDiff(f) : undefined}
          />
        ))}
      </div>

      {/* Pied : compteur à gauche, actions à droite. */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "6px 10px",
          borderTop: "1px solid var(--origin-border-default)",
          backgroundColor: "var(--origin-bg-editor)",
        }}
      >
        <Icon icon="lucide:file-diff" width={13} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: "11px", color: "var(--origin-fg-muted)", fontFamily: "var(--font-mono)" }}>
          {files.length} file{files.length === 1 ? "" : "s"} to review
        </span>
        <button
          onClick={onUndo}
          disabled={busy !== null}
          style={{
            padding: "3px 10px", borderRadius: "6px",
            cursor: busy ? "default" : "pointer",
            fontSize: "11px", border: "1px solid var(--origin-border-default)",
            background: "transparent", color: "var(--origin-fg-default)",
            opacity: busy === "keep" ? 0.5 : 1,
          }}
        >
          Undo all
        </button>
        <button
          onClick={onKeep}
          disabled={busy !== null}
          style={{
            padding: "3px 10px", borderRadius: "6px",
            cursor: busy ? "default" : "pointer",
            fontSize: "11px", border: "1px solid var(--origin-border-default)",
            background: "var(--origin-bg-active)", color: "var(--origin-fg-default)",
            fontWeight: 500,
            opacity: busy === "undo" ? 0.5 : 1,
          }}
        >
          Keep all
        </button>
      </div>
    </div>
  );
}

/** Une ligne `nom  chemin  +N -N ›` — cliquable pour ouvrir le diff. */
function FileRow({
  file,
  disabled,
  onClick,
}: {
  file: TurnFileDelta;
  disabled: boolean;
  onClick?: () => void;
}) {
  const name = file.path.split(/[/\\]/).pop() ?? file.path;
  const clickable = !!onClick && !disabled;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      title={file.path}
      style={{
        display: "flex", alignItems: "center", gap: "8px",
        padding: "4px 6px", borderRadius: "5px",
        cursor: clickable ? "pointer" : "default",
      }}
      onMouseEnter={e => { if (clickable) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {/* Icône type « fichier édité » (crayon) ou « fichier créé » (plus). */}
      <Icon
        icon={file.created ? "lucide:file-plus" : "lucide:pencil-line"}
        width={13}
        style={{ color: file.created ? "var(--origin-semantic-success)" : "var(--origin-accent-blue, #6366f1)", flexShrink: 0 }}
      />
      <span style={{
        fontSize: "12px", color: "var(--origin-fg-default)",
        whiteSpace: "nowrap", flexShrink: 0,
      }}>
        {name}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: "10px", fontFamily: "var(--font-mono)",
        color: "var(--origin-fg-subtle)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {file.path}
      </span>
      {file.added > 0 && (
        <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--origin-semantic-success)", flexShrink: 0 }}>
          +{file.added}
        </span>
      )}
      {file.removed > 0 && (
        <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--origin-semantic-error, #ef4444)", flexShrink: 0 }}>
          -{file.removed}
        </span>
      )}
      {onClick && (
        <Icon icon="lucide:chevron-right" width={12} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
      )}
    </div>
  );
}
