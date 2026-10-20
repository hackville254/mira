import { useState } from "react";
import { Icon } from "@iconify/react";
import { FileCode, ChevronDown } from "lucide-react";
import type { TurnFileDelta } from "../../lib/turnCheckpoint";

// ── Revue des fichiers modifiés d'un tour (style Trae) ────────────────────────
//
// Reproduit exactement les deux blocs de Trae :
//  1. La barre de statut « N file(s) changed » : repliée par défaut, elle
//     affiche le nombre de fichiers, le delta cumulé `+N -N` et une flèche
//     d'ouverture. Un clic la déplie sur la liste détaillée.
//  2. La liste détaillée : une ligne par fichier (icône créer/modifier, nom,
//     chemin, `+N -N`, chevron pour ouvrir le diff) et un pied « N files to
//     review » avec « Undo all » / « Keep all ».
//
// Le composant est purement présentationnel : undo/keep/ouverture de diff sont
// délégués au parent.

/**
 * Calcule le delta cumulé `+N/-N` d'un ensemble de fichiers modifiés.
 * Exporté pour être testable sans monter le composant.
 */
export function sumDelta(files: TurnFileDelta[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed };
}

export default function TurnReviewCard({
  files,
  undo,
  keep,
  onOpenDiff,
  /** `true` si la carte est rendue juste au-dessus de l'input (compacte). */
  docked = false,
  /** Ouvre la carte dépliée au premier rendu (utilisé au-dessus de l'input). */
  defaultExpanded = false,
}: {
  files: TurnFileDelta[];
  undo: () => Promise<void>;
  keep: () => Promise<void>;
  onOpenDiff?: (file: TurnFileDelta) => void;
  docked?: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [busy, setBusy] = useState<"undo" | "keep" | null>(null);

  const onUndo = async () => { setBusy("undo"); try { await undo(); } finally { setBusy(null); } };
  const onKeep = async () => { setBusy("keep"); try { await keep(); } finally { setBusy(null); } };

  const totals = sumDelta(files);
  const count = files.length;

  return (
    <div
      style={{
        margin: docked ? "0" : "6px 0",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "8px",
        backgroundColor: "var(--origin-bg-base)",
        overflow: "hidden",
        fontSize: "12px",
      }}
    >
      {/* Barre de statut : toujours visible, cliquable pour déplier/replier. */}
      <button
        onClick={() => setExpanded(v => !v)}
        title={expanded ? "Collapse review" : "Expand review"}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: "10px",
          padding: "9px 10px", border: "none", cursor: "pointer",
          background: "transparent", textAlign: "left",
        }}
        onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
        onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
      >
        {/* Pastille carrée avec icône « fichier + édition ». */}
        <span style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "26px", height: "26px", borderRadius: "6px", flexShrink: 0,
          background: "var(--origin-bg-active)", color: "var(--origin-fg-default)",
        }}>
          <FileCode size={14} />
        </span>

        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)", whiteSpace: "nowrap" }}>
            {count} file{count === 1 ? "" : "s"} changed
          </span>
          <Icon
            icon="lucide:chevrons-up-down"
            width={13}
            style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }}
          />
        </span>

        <span style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {totals.added > 0 && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--origin-semantic-success)" }}>
              +{totals.added}
            </span>
          )}
          {totals.removed > 0 && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--origin-semantic-error, #ef4444)" }}>
              -{totals.removed}
            </span>
          )}
          <ChevronDown
            size={15}
            style={{
              color: "var(--origin-fg-subtle)",
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }}
          />
        </span>
      </button>

      {/* Liste détaillée : masquée tant que la carte est repliée. */}
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", padding: "4px", borderTop: "1px solid var(--origin-border-default)" }}>
          {files.map(f => (
            <FileRow
              key={f.path}
              file={f}
              disabled={busy !== null}
              onClick={onOpenDiff ? () => onOpenDiff(f) : undefined}
            />
          ))}
        </div>
      )}

      {/* Pied d'actions : TOUJOURS visible (même replié) — « Keep all » / « Undo all »
          doivent être accessibles à tout moment pendant le run, pas seulement quand
          la carte est dépliée. C'est le comportement de la barre de revue de Trae. */}
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
          {count} file{count === 1 ? "" : "s"} to review
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
