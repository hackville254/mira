import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { RevertPlanEntry } from "../../lib/turnCheckpoint";

// ── Confirmation de revert (style Trae) ───────────────────────────────────────
//
// Le revert est destructif : il supprime les fichiers créés pendant le run et
// restaure ceux qui ont été modifiés. Avant d'agir, on montre à l'utilisateur
// la liste EXACTE de ce qui va se passer, groupée par action :
//  - « Will be deleted » : fichiers créés pendant le run (perte définitive).
//  - « Will be restored » : fichiers modifiés (retour à l'état d'origine).
//
// Le plan affiché vient d'un dry-run (`previewRevertTurns`) : ce que voit
// l'utilisateur est précisément ce qui sera appliqué. Composant purement
// présentationnel — la confirmation est déléguée au parent.

/** Nombre de lignes affichées avant de passer en « + N more ». */
const MAX_VISIBLE = 8;

export default function RevertConfirmDialog({
  plan,
  onConfirm,
  onCancel,
}: {
  /** Plan du revert (issu du dry-run). */
  plan: RevertPlanEntry[];
  /** Applique le revert (parent : `revertTurns` + troncature du fil). */
  onConfirm: () => void | Promise<void>;
  /** Abandonne : aucun fichier n'est touché. */
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // On sépare suppressions et restaurations : ce sont deux risques distincts
  // (l'une détruit du travail, l'autre le rétablit) et l'utilisateur doit les
  // voir séparément.
  const { deletes, restores } = useMemo(() => {
    const d: RevertPlanEntry[] = [];
    const r: RevertPlanEntry[] = [];
    for (const e of plan) (e.action === "delete" ? d : r).push(e);
    return { deletes: d, restores: r };
  }, [plan]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  const hasDeletes = deletes.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm revert"
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", padding: "20px",
      }}
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: "460px", maxHeight: "80vh",
          display: "flex", flexDirection: "column",
          background: "var(--origin-bg-base)",
          border: "1px solid var(--origin-border-default)",
          borderRadius: "10px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          overflow: "hidden",
          fontSize: "12px",
        }}
      >
        {/* En-tête : explication en une phrase du caractère destructif. */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 14px", borderBottom: "1px solid var(--origin-border-default)" }}>
          <Icon
            icon="lucide:undo-2"
            width={16}
            style={{ color: "var(--origin-semantic-error, #ef4444)", flexShrink: 0 }}
          />
          <span style={{ flex: 1, fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
            Revert changes
          </span>
        </div>

        {/* Corps : les deux groupes de fichiers, chacun repliable, limités en
            hauteur pour ne jamais déborder de l'écran. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {deletes.length > 0 && (
            <Section
              title="Will be deleted"
              hint="created during this run"
              entries={deletes}
              danger
            />
          )}
          {restores.length > 0 && (
            <Section
              title="Will be restored"
              hint="modified during this run"
              entries={restores}
            />
          )}
          {plan.length === 0 && (
            <div style={{ padding: "8px", color: "var(--origin-fg-subtle)" }}>
              Nothing to change on disk.
            </div>
          )}
        </div>

        {/* Pied : rappel du risque + actions. « Revert » est mis en avant en
            rouge quand des fichiers seront supprimés (perte définitive). */}
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--origin-border-default)", backgroundColor: "var(--origin-bg-editor)" }}>
          {hasDeletes && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", color: "var(--origin-fg-muted)", fontSize: "11px" }}>
              <Icon icon="lucide:alert-triangle" width={12} style={{ color: "var(--origin-semantic-error, #ef4444)", flexShrink: 0 }} />
              {deletes.length} file{deletes.length === 1 ? "" : "s"} will be permanently deleted.
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              onClick={onCancel}
              disabled={busy}
              style={{
                padding: "5px 12px", borderRadius: "6px", fontSize: "12px",
                cursor: busy ? "default" : "pointer",
                border: "1px solid var(--origin-border-default)",
                background: "transparent", color: "var(--origin-fg-default)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              style={{
                padding: "5px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: 500,
                cursor: busy ? "default" : "pointer",
                border: hasDeletes ? "1px solid var(--origin-semantic-error, #ef4444)" : "1px solid var(--origin-border-default)",
                background: hasDeletes ? "var(--origin-semantic-error, #ef4444)" : "var(--origin-bg-active)",
                color: hasDeletes ? "#fff" : "var(--origin-fg-default)",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Reverting…" : "Revert"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Groupe de fichiers (titre + compteur + liste bornée). */
function Section({
  title,
  hint,
  entries,
  danger = false,
}: {
  title: string;
  hint: string;
  entries: RevertPlanEntry[];
  danger?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? entries : entries.slice(0, MAX_VISIBLE);
  const hidden = entries.length - visible.length;

  return (
    <div style={{ border: "1px solid var(--origin-border-default)", borderRadius: "8px", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 8px", backgroundColor: "var(--origin-bg-editor)" }}>
        <span style={{ fontSize: "11px", fontWeight: 600, color: danger ? "var(--origin-semantic-error, #ef4444)" : "var(--origin-fg-default)" }}>
          {title}
        </span>
        <span style={{ fontSize: "10px", color: "var(--origin-fg-subtle)" }}>· {hint}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--origin-fg-muted)" }}>
          {entries.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", padding: "3px" }}>
        {visible.map(e => (
          <Row key={e.path} entry={e} danger={danger} />
        ))}
        {hidden > 0 && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              padding: "4px 6px", borderRadius: "5px", border: "none",
              background: "transparent", cursor: "pointer", textAlign: "left",
              fontSize: "11px", color: "var(--origin-fg-muted)",
            }}
            onMouseEnter={ev => { ev.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={ev => { ev.currentTarget.style.backgroundColor = "transparent"; }}
          >
            + {hidden} more
          </button>
        )}
      </div>
    </div>
  );
}

/** Une ligne `icône  nom  chemin  ×turns`. */
function Row({ entry, danger }: { entry: RevertPlanEntry; danger: boolean }) {
  const name = entry.path.split(/[/\\]/).pop() ?? entry.path;
  return (
    <div
      title={entry.path}
      style={{ display: "flex", alignItems: "center", gap: "7px", padding: "4px 6px", borderRadius: "5px" }}
    >
      <Icon
        icon={danger ? "lucide:trash-2" : "lucide:file-clock"}
        width={13}
        style={{
          flexShrink: 0,
          color: danger ? "var(--origin-semantic-error, #ef4444)" : "var(--origin-accent-blue, #6366f1)",
        }}
      />
      <span style={{ fontSize: "12px", color: "var(--origin-fg-default)", whiteSpace: "nowrap", flexShrink: 0 }}>
        {name}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: "10px", fontFamily: "var(--font-mono)",
        color: "var(--origin-fg-subtle)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {entry.path}
      </span>
      {entry.turns > 1 && (
        <span style={{ fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>
          ×{entry.turns}
        </span>
      )}
    </div>
  );
}
