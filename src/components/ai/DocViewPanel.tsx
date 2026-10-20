import { useMemo } from "react";
import { Icon } from "@iconify/react";
import MarkdownMessage from "./MarkdownMessage";
import type { ParsedPlan } from "../../lib/agent/planTypes";

// ── DocView (parité Trae) ─────────────────────────────────────────────────────
//
// Panneau de lecture dédié au « document » produit par la conversation : le
// dernier artefact textuel de l'agent (réponse, PRD, note de solution, plan…)
// rendu en Markdown, hors du fil de chat. C'est l'équivalent de la vue
// « DocView » de Trae : on y relit proprement ce que l'agent a écrit, sans le
// bruit des tool-calls.
//
// Purement présentationnel : le parent (AgentModeView) lui passe le Markdown
// courant et, le cas échéant, le plan structuré de la conversation active.

interface Props {
  /** Markdown de l'artefact courant (dernier message assistant substantiel). */
  markdown: string;
  /** Plan structuré encore en attente, s'il y en a un. */
  plan?: ParsedPlan | null;
  /** Titre affiché dans l'en-tête (typ. titre du document). */
  title?: string;
}

export default function DocViewPanel({ markdown, plan, title }: Props) {
  // Titre : première ligne `# …` du Markdown, sinon le titre du plan, sinon défaut.
  const heading = useMemo(() => {
    const m = /^\s*#\s+(.+)$/m.exec(markdown);
    return m?.[1]?.trim() ?? title ?? plan?.title ?? "Document";
  }, [markdown, title, plan]);

  const empty = markdown.trim() === "" && !plan;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: "var(--origin-bg-editor)" }}>
      {/* En-tête : identité du document, sans actions (lecture seule). */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", flexShrink: 0,
          borderBottom: "1px solid var(--origin-border-default)",
          backgroundColor: "var(--origin-bg-panel)",
        }}
      >
        <Icon icon="lucide:file-text" width={15} style={{ color: "#a78bfa", flexShrink: 0 }} />
        <span style={{
          fontSize: 13, fontWeight: 600, color: "var(--origin-fg-default)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {heading}
        </span>
      </div>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: "var(--origin-fg-subtle)" }}>
          <Icon icon="lucide:file-text" width={32} style={{ opacity: 0.4 }} />
          <p className="text-xs">No document yet</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto" style={{ padding: "18px 22px" }}>
          {plan && (
            <div
              style={{
                marginBottom: 16, padding: "10px 12px", borderRadius: 8,
                border: "1px solid var(--origin-border-default)",
                backgroundColor: "var(--origin-bg-base)",
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--origin-fg-muted)", marginBottom: 6 }}>
                Plan
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: 8 }}>
                {plan.title}
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                {plan.steps.map((s, i) => (
                  <li key={i} style={{ fontSize: 12, color: "var(--origin-fg-default)", fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--origin-fg-muted)" }}>[{s.action}]</span> {s.file}
                    {s.description && (
                      <span style={{ fontFamily: "var(--font-sans)", color: "var(--origin-fg-muted)" }}> — {s.description}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {markdown.trim() !== "" && (
            <MarkdownMessage content={markdown} />
          )}
        </div>
      )}
    </div>
  );
}
