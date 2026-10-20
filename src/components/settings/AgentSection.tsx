import { useState, useEffect } from "react";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_EVENT,
  getDisabledTools,
  setToolEnabled,
} from "../../lib/agent/agentToolPrefs";

// ── Agent Section ────────────────────────────────────────────────────────────
//
// Liste des outils d'agent activables/désactivables, façon Trae. Les outils
// désactivés sont réellement retirés du contrat système injecté au modèle
// (voir lib/agent/prompts.ts › buildSystemPrompt) : le modèle cesse de les
// appeler. Les toggles sont persistés et prennent effet au tour suivant.

export function AgentSection() {
  const [disabled, setDisabled] = useState<Set<string>>(getDisabledTools);

  useEffect(() => {
    const sync = () => setDisabled(getDisabledTools());
    window.addEventListener(AGENT_TOOLS_EVENT, sync);
    return () => window.removeEventListener(AGENT_TOOLS_EVENT, sync);
  }, []);

  const toggle = (id: string, enabled: boolean) => {
    setToolEnabled(id, enabled);
    setDisabled(getDisabledTools());
  };

  const enabledCount = AGENT_TOOLS.filter(t => !disabled.has(t.id)).length;

  return (
    <div>
      <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: "6px" }}>
        Agent
      </div>
      <div style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "18px" }}>
        Choose which tools the AI agent may use. Disabled tools are removed from the agent's instructions and are never called.
      </div>

      <Heading>Tools</Heading>
      <Card>
        {AGENT_TOOLS.map((tool, i) => (
          <Row
            key={tool.id}
            title={tool.label}
            description={tool.description}
            last={i === AGENT_TOOLS.length - 1}
          >
            <Toggle
              on={!disabled.has(tool.id)}
              onToggle={() => toggle(tool.id, disabled.has(tool.id))}
            />
          </Row>
        ))}
      </Card>

      <div style={{ fontSize: "11.5px", color: "var(--origin-fg-subtle)", marginTop: "10px" }}>
        {enabledCount} of {AGENT_TOOLS.length} tools enabled. Progress tracking, questions, and skills stay always on: they are part of the agent loop.
      </div>
    </div>
  );
}

// ── Primitives locales ───────────────────────────────────────────────────────

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)",
      margin: "20px 0 8px",
    }}>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: "1px solid var(--origin-border-default)",
      borderRadius: "8px",
      backgroundColor: "var(--origin-bg-subtle, var(--origin-bg-base))",
      overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function Row({ title, description, last, children }: {
  title: string;
  description?: string;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "24px",
      padding: "14px 16px",
      borderBottom: last ? "none" : "1px solid var(--origin-border-default)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{title}</div>
        {description && (
          <div style={{ fontSize: "11.5px", color: "var(--origin-fg-muted)", marginTop: "3px", lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
      {children && <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>{children}</div>}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      style={{
        width: 34, height: 18, borderRadius: 9, border: "none", cursor: "pointer",
        padding: 2, display: "flex", alignItems: "center",
        backgroundColor: on ? "var(--origin-semantic-success, #2ea043)" : "var(--origin-border-default)",
        transition: "background 0.15s", flexShrink: 0,
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: "50%", backgroundColor: "#fff",
        transform: on ? "translateX(16px)" : "translateX(0)",
        transition: "transform 0.15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}
