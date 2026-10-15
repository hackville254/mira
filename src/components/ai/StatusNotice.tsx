import { useState } from "react";
import { ChevronRight, Layers, RefreshCw } from "lucide-react";

// ── Bannière système in-line ────────────────────────────────────────────────────
//
// Affiche dans le fil les événements internes du moteur qui ne sont pas du texte
// de l'assistant : « Compaction de l'historique » (réduction de contexte) et
// « Reprise automatique » (retry après erreur transitoire). Calqué sur Trae, où
// la compaction apparaît comme une ligne repliable dans la conversation.

export default function StatusNotice({ kind, detail, savedTokens }: {
  kind: "compaction" | "retry";
  detail: string;
  savedTokens?: number;
}) {
  const [open, setOpen] = useState(false);
  const isCompaction = kind === "compaction";
  const Icon = isCompaction ? Layers : RefreshCw;
  const hasDetail = !!savedTokens || !!detail;

  return (
    <div style={{ margin: "6px 0" }}>
      <button
        onClick={() => hasDetail && setOpen(v => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--origin-border-default)",
          background: "var(--origin-bg-active)", cursor: hasDetail ? "pointer" : "default",
          fontSize: "11px", color: "var(--origin-fg-muted)",
        }}
      >
        {hasDetail && (
          <ChevronRight size={11} style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} />
        )}
        <Icon size={12} style={{ flexShrink: 0 }} />
        <span>{isCompaction ? "Compaction de l'historique" : "Reprise automatique"}</span>
      </button>
      {open && hasDetail && (
        <div style={{ marginTop: "4px", marginLeft: "6px", paddingLeft: "10px",
          borderLeft: "2px solid var(--origin-border-default)",
          fontSize: "11px", color: "var(--origin-fg-subtle)", lineHeight: "1.6" }}>
          <div>{detail}</div>
          {savedTokens != null && savedTokens > 0 && (
            <div>≈ {savedTokens.toLocaleString()} tokens économisés</div>
          )}
        </div>
      )}
    </div>
  );
}
