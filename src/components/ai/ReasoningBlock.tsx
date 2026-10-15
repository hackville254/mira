import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";

// ── Raisonnement de l'agent (chaîne de pensée) ─────────────────────────────────
//
// Certains modèles exposent leur raisonnement (« reasoning ») avant la réponse
// finale et les appels d'outils. On le rend dans une section repliable, discrète
// par défaut, pour ne pas polluer le fil — comme le « Thinking… » de Cursor/Trae.
// Tant que le texte arrive (streaming), la section reste ouverte pour montrer la
// progression ; ensuite l'utilisateur peut la replier librement.

export default function ReasoningBlock({ content, streaming }: {
  content: string;
  streaming?: boolean;
}) {
  // Par défaut ouvert pendant le streaming (l'utilisateur voit la réflexion en
  // direct), puis l'utilisateur peut le replier s'il le souhaite.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? !!streaming;

  return (
    <div style={{ margin: "6px 0" }}>
      <button
        onClick={() => setManualOpen(v => !(v ?? !!streaming))}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--origin-border-default)",
          background: "var(--origin-bg-active)", cursor: "pointer",
          fontSize: "11px", color: "var(--origin-fg-muted)",
        }}
      >
        <ChevronRight size={11} style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} />
        <Brain size={12} style={{ flexShrink: 0 }} />
        <span>{streaming ? "Raisonnement…" : "Raisonnement"}</span>
      </button>
      {open && (
        <div style={{
          marginTop: "4px", marginLeft: "6px", paddingLeft: "10px",
          borderLeft: "2px solid var(--origin-border-default)",
          color: "var(--origin-fg-subtle)", opacity: 0.92,
        }}>
          <MarkdownMessage content={content} isStreaming={streaming} />
        </div>
      )}
    </div>
  );
}
