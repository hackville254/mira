import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CUSTOM_AGENTS_EVENT,
  deleteAgent,
  listAgents,
  saveAgent,
  slugifyAgentId,
  type CustomAgent,
} from "../../lib/agent/customAgents";
import { AGENT_TOOLS } from "../../lib/agent/agentToolPrefs";

// ── Agents Section (Settings › Agents) ───────────────────────────────────────
//
// Création et gestion d'**agents personnalisés** : chacun a un nom, un prompt de
// rôle, une sélection d'outils et une sélection de serveurs MCP. Les agents sont
// persistés globalement (`~/.mira/agents`) et proposés ensuite dans le sélecteur
// de l'input du chat. Création MANUELLE uniquement (pas de génération par IA).
//
// Sécurité : le prompt est du texte inerte injecté dans le prompt système ; les
// identifiants d'outils/MCP sont des listes contrôlées (une valeur inconnue est
// ignorée). Aucune donnée fournie ici n'est exécutée.

interface McpName {
  name: string;
  disabled: boolean;
}

export function AgentsSection() {
  const [agents, setAgents] = useState<CustomAgent[] | null>(null);
  const [mcpNames, setMcpNames] = useState<McpName[]>([]);
  const [editing, setEditing] = useState<CustomAgent | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const [list, mcp] = await Promise.all([
      listAgents(),
      invoke<McpName[]>("list_mcp_servers").catch(() => [] as McpName[]),
    ]);
    setAgents(list);
    setMcpNames(Array.isArray(mcp) ? mcp : []);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const sync = () => { void reload(); };
    window.addEventListener(CUSTOM_AGENTS_EVENT, sync);
    return () => window.removeEventListener(CUSTOM_AGENTS_EVENT, sync);
  }, [reload]);

  const startCreate = () => {
    setEditing({ id: "", name: "", prompt: "", tools: AGENT_TOOLS.map(t => t.id), mcp: [], avatar: null, createdAt: 0 });
    setIsNew(true);
    setError(null);
  };

  const startEdit = (a: CustomAgent) => {
    setEditing({ ...a, tools: [...a.tools], mcp: [...a.mcp] });
    setIsNew(false);
    setError(null);
  };

  const remove = async (a: CustomAgent) => {
    const ok = window.confirm(`Delete agent "${a.name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await deleteAgent(a.id);
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  };

  if (editing) {
    return (
      <AgentEditor
        draft={editing}
        isNew={isNew}
        mcpNames={mcpNames}
        error={error}
        onCancel={() => { setEditing(null); setIsNew(false); setError(null); }}
        onSaved={async () => { setEditing(null); setIsNew(false); await reload(); }}
        onError={setError}
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
        <span style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)" }}>Agents</span>
        <button
          onClick={startCreate}
          style={{
            marginLeft: "auto", padding: "6px 12px", borderRadius: "6px", cursor: "pointer",
            border: "1px solid var(--origin-border-default)", fontSize: "12px", fontWeight: 500,
            backgroundColor: "var(--origin-accent-emphasis, #2f6feb)", color: "#fff",
          }}
        >
          + Create
        </button>
      </div>
      <div style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "18px" }}>
        Build custom agents with their own prompt, tools, and MCP servers. They appear in the chat input selector and stay available in every conversation and project.
      </div>

      {error && <ErrorBar text={error} />}

      <Heading>Custom Agents</Heading>
      <Card>
        {agents === null ? (
          <Row title="Loading…" last />
        ) : agents.length === 0 ? (
          <Row title="No custom agents available" last>
            <TextButton onClick={startCreate}>Create</TextButton>
          </Row>
        ) : (
          agents.map((a, i) => (
            <Row
              key={a.id}
              title={a.name}
              description={summarize(a)}
              last={i === agents.length - 1}
            >
              <SecondaryButton onClick={() => startEdit(a)}>Edit</SecondaryButton>
              <SecondaryButton danger onClick={() => void remove(a)}>Delete</SecondaryButton>
            </Row>
          ))
        )}
      </Card>

      <Heading>Built-In Agents</Heading>
      <Card>
        <Row title="Chat" description="Chat about your codebase" last={false}>
          <Muted>ask</Muted>
        </Row>
        <Row title="Agent" description="End-to-end execution of development tasks" last>
          <Muted>default</Muted>
        </Row>
      </Card>
    </div>
  );
}

// ── Éditeur ──────────────────────────────────────────────────────────────────

function AgentEditor({
  draft, isNew, mcpNames, error, onCancel, onSaved, onError,
}: {
  draft: CustomAgent;
  isNew: boolean;
  mcpNames: McpName[];
  error: string | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [tools, setTools] = useState<Set<string>>(new Set(draft.tools));
  const [mcp, setMcp] = useState<Set<string>>(new Set(draft.mcp));
  const [busy, setBusy] = useState(false);

  const toggleTool = (id: string) =>
    setTools(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleMcp = (id: string) =>
    setMcp(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    onError(null);
    setBusy(true);
    try {
      await saveAgent({
        id: isNew ? undefined : draft.id,
        name,
        prompt,
        tools: [...tools],
        mcp: [...mcp],
        avatar: draft.avatar ?? null,
      });
      await onSaved();
    } catch (e) {
      onError(normalize(e));
    } finally {
      setBusy(false);
    }
  };

  const previewId = isNew ? slugifyAgentId(name) : draft.id;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "18px" }}>
        <span style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
          {isNew ? "Create Agent" : "Edit Agent"}
        </span>
      </div>

      {error && <ErrorBar text={error} />}

      <Field label="Name" required>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Enter agent name"
          maxLength={60}
          style={inputStyle}
        />
        {isNew && name.trim() && (
          <div style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", marginTop: "4px" }}>
            Identifier: <code>{previewId || "—"}</code>
          </div>
        )}
      </Field>

      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Enter the agent's role, tone, workflow, tool preferences, and any rules or guidelines. (Optional)"
          rows={8}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }}
        />
        <div style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", marginTop: "4px", textAlign: "right" }}>
          {prompt.length}/10000
        </div>
      </Field>

      <Heading>Tools</Heading>

      <SubHeading>Tools – MCP</SubHeading>
      <Card>
        {mcpNames.length === 0 ? (
          <Row title="No MCP servers configured" description="Add servers in Settings › MCP, then select them here." last />
        ) : (
          mcpNames.map((s, i) => (
            <Row key={s.name} title={s.name} description={s.disabled ? "Disabled globally" : undefined} last={i === mcpNames.length - 1}>
              <Check on={mcp.has(s.name)} onToggle={() => toggleMcp(s.name)} />
            </Row>
          ))
        )}
      </Card>

      <SubHeading>Tools – Built-In</SubHeading>
      <Card>
        {AGENT_TOOLS.map((t, i) => (
          <Row key={t.id} title={t.label} description={t.description} last={i === AGENT_TOOLS.length - 1}>
            <Check on={tools.has(t.id)} onToggle={() => toggleTool(t.id)} />
          </Row>
        ))}
      </Card>

      <div style={{ display: "flex", gap: "8px", marginTop: "20px" }}>
        <PrimaryButton onClick={() => void save()} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : isNew ? "Create" : "Save"}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function summarize(a: CustomAgent): string {
  const toolCount = a.tools.length;
  const mcpCount = a.mcp.length;
  const parts = [`${toolCount} tool${toolCount === 1 ? "" : "s"}`];
  if (mcpCount > 0) parts.push(`${mcpCount} MCP`);
  const prompt = a.prompt.trim().replace(/\s+/g, " ");
  const snippet = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return [snippet, parts.join(" · ")].filter(Boolean).join(" — ");
}

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: "6px", fontSize: "12.5px",
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-base)", color: "var(--origin-fg-default)",
  outline: "none", boxSizing: "border-box",
};

// ── Primitives locales ───────────────────────────────────────────────────────

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)", margin: "20px 0 8px" }}>
      {children}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-muted)", margin: "14px 0 6px" }}>
      {children}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ fontSize: "12.5px", fontWeight: 500, color: "var(--origin-fg-default)", marginBottom: "6px" }}>
        {label}{required && <span style={{ color: "var(--origin-semantic-danger, #f85149)" }}> *</span>}
      </div>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: "1px solid var(--origin-border-default)", borderRadius: "8px",
      backgroundColor: "var(--origin-bg-subtle, var(--origin-bg-base))", overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function Row({ title, description, last, children }: {
  title: string; description?: string; last?: boolean; children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "16px", padding: "12px 16px",
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

function Check({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="checkbox"
      aria-checked={on}
      style={{
        width: 18, height: 18, borderRadius: 4, cursor: "pointer", padding: 0,
        border: on ? "none" : "1px solid var(--origin-border-default)",
        backgroundColor: on ? "var(--origin-accent-emphasis, #2f6feb)" : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}
    >
      {on && (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: "none", border: "none", cursor: "pointer", padding: 0,
      fontSize: "12.5px", color: "var(--origin-accent-fg, #2f6feb)", textDecoration: "underline",
    }}>
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, disabled, danger, children }: {
  onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "5px 10px", borderRadius: "6px", cursor: disabled ? "default" : "pointer",
      border: "1px solid var(--origin-border-default)", fontSize: "12px",
      backgroundColor: "transparent", opacity: disabled ? 0.5 : 1,
      color: danger ? "var(--origin-semantic-danger, #f85149)" : "var(--origin-fg-default)",
    }}>
      {children}
    </button>
  );
}

function PrimaryButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "6px 14px", borderRadius: "6px", cursor: disabled ? "default" : "pointer",
      border: "none", fontSize: "12.5px", fontWeight: 500,
      backgroundColor: "var(--origin-accent-emphasis, #2f6feb)", color: "#fff", opacity: disabled ? 0.5 : 1,
    }}>
      {children}
    </button>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: "11.5px", color: "var(--origin-fg-subtle)" }}>{children}</span>;
}

function ErrorBar({ text }: { text: string }) {
  return (
    <div style={{
      padding: "8px 12px", borderRadius: "6px", marginBottom: "14px", fontSize: "12px",
      border: "1px solid var(--origin-semantic-danger, #f85149)",
      color: "var(--origin-semantic-danger, #f85149)",
      backgroundColor: "color-mix(in srgb, var(--origin-semantic-danger, #f85149) 10%, transparent)",
    }}>
      {text}
    </div>
  );
}
