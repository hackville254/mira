import { Icon } from "@iconify/react";
import type { TurnFileDelta } from "../../lib/turnCheckpoint";
import { sumDelta } from "./TurnReviewCard";

// ── DiffView (parité Trae) ────────────────────────────────────────────────────
//
// Panneau dédié qui reproduit la vue « Diff » de Trae : un bandeau de synthèse
// (N fichiers modifiés, delta cumulé +A −R) puis la liste cliquable des fichiers
// touchés par le tour d'agent courant. Un clic ouvre le diff lecture seule dans
// l'onglet éditeur (via `onOpenDiff`).
//
// Le composant est PUREMENT présentationnel : il ne connaît ni les checkpoints ni
// le disque — le parent (AgentModeView) lui passe l'état de revue de la
// conversation active, exactement comme Trae alimente sa vue depuis la tâche.

interface Props {
  files: TurnFileDelta[];
  /** Ouvre le diff « avant / après » d'un fichier (fourni par AiPanel). */
  onOpenDiff?: (file: TurnFileDelta) => void;
  /**
   * Action « Undo all » du tour courant. Absente tant qu'aucun tour n'est
   * annulable → le bouton est masqué (au lieu d'un bouton inerte).
   */
  onUndoAll?: () => void | Promise<void>;
  /** Action « Keep all » du tour courant. */
  onKeepAll?: () => void | Promise<void>;
  /** Message affiché quand aucun tour n'a modifié de fichier. */
  emptyHint?: string;
}

export default function DiffViewPanel({
  files, onOpenDiff, onUndoAll, onKeepAll, emptyHint = "No changes to review yet",
}: Props) {
  const totals = sumDelta(files);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
      {/* Bandeau de synthèse — toujours visible, comme la barre Trae. */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", flexShrink: 0,
          borderBottom: "1px solid var(--origin-border-default)",
          backgroundColor: "var(--origin-bg-panel)",
        }}
      >
        <Icon icon="lucide:git-compare" width={15} style={{ color: "#34d399", flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--origin-fg-default)" }}>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        {totals.added > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--origin-semantic-success)" }}>
            +{totals.added}
          </span>
        )}
        {totals.removed > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--origin-semantic-error, #ef4444)" }}>
            -{totals.removed}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onUndoAll && (
          <button
            onClick={() => void onUndoAll()}
            style={btnStyle}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            Undo all
          </button>
        )}
        {onKeepAll && (
          <button
            onClick={() => void onKeepAll()}
            style={{ ...btnStyle, backgroundColor: "var(--origin-bg-active)", fontWeight: 500 }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-active)"; }}
          >
            Keep all
          </button>
        )}
      </div>

      {/* Liste cliquable. */}
      {files.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: "var(--origin-fg-subtle)" }}>
          <Icon icon="lucide:file-diff" width={32} style={{ opacity: 0.4 }} />
          <p className="text-xs">{emptyHint}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto" style={{ padding: 6 }}>
          {files.map(f => (
            <DiffFileRow
              key={f.path}
              file={f}
              onClick={onOpenDiff ? () => onOpenDiff(f) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "3px 12px", borderRadius: 6, cursor: "pointer",
  fontSize: 11, border: "1px solid var(--origin-border-default)",
  background: "transparent", color: "var(--origin-fg-default)",
};

/** Ligne cliquable : icône créer/modifier, nom, chemin relatif, `+N -N`. */
function DiffFileRow({ file, onClick }: { file: TurnFileDelta; onClick?: () => void }) {
  const name = file.path.split(/[/\\]/).pop() ?? file.path;
  return (
    <div
      onClick={onClick}
      title={file.path}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 8px", borderRadius: 6,
        cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      <Icon
        icon={file.created ? "lucide:file-plus" : "lucide:pencil-line"}
        width={13}
        style={{ color: file.created ? "var(--origin-semantic-success)" : "var(--origin-accent-blue, #6366f1)", flexShrink: 0 }}
      />
      <span style={{ fontSize: 12, color: "var(--origin-fg-default)", whiteSpace: "nowrap", flexShrink: 0 }}>
        {name}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 10, fontFamily: "var(--font-mono)",
        color: "var(--origin-fg-subtle)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {file.path}
      </span>
      {file.added > 0 && (
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--origin-semantic-success)", flexShrink: 0 }}>
          +{file.added}
        </span>
      )}
      {file.removed > 0 && (
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--origin-semantic-error, #ef4444)", flexShrink: 0 }}>
          -{file.removed}
        </span>
      )}
      {onClick && <Icon icon="lucide:chevron-right" width={12} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />}
    </div>
  );
}
