/**
 * Mira — page RÉGLAGES « MCP ».
 *
 * RÔLE
 * ----
 * Gérer les serveurs Model Context Protocol exposés à l'agent : ajouter, éditer,
 * activer/désactiver, supprimer, et vérifier la connexion.
 *
 * SOURCE DE VÉRITÉ
 * ----------------
 * Le backend Rust (`extensions_store`) lit/écrit LE MÊME fichier de réglages que
 * le moteur d'agent. Conséquence : ce que l'utilisateur modifie ici est
 * immédiatement ce que l'agent utilisera à la prochaine session — pas de doublon
 * qui divergerait.
 *
 * SÉCURITÉ
 * --------
 *   - Le formulaire ne fait que PROPOSER une entrée ; la validation (nom, chemins,
 *     confinement) est faite côté Rust, qui est seul autorisé à écrire.
 *   - Aucune commande n'est exécutée par cette page : un serveur `stdio` n'est
 *     lancé qu'au démarrage d'une session d'agent, sous la politique
 *     d'approbation d'outils.
 *   - Les variables d'environnement saisies ici sont stockées en clair dans le
 *     fichier de réglages MCP (comportement du format) : on avertit l'utilisateur
 *     de ne pas y mettre de secrets durables mais d'utiliser les mécanismes
 *     d'environnement du système.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Pencil, Trash2, Plug } from "lucide-react";
import {
  Badge, Button, ErrorLine, Field, IconButton, KeyValueEditor, ListRow,
  LoadingLine, PageHeader, Switch, monoFieldStyle, sectionCard,
} from "./ui";

// ── Types miroirs du backend ────────────────────────────────────────────────

type Transport = "stdio" | "sse" | "streamableHttp";

interface McpServerInfo {
  name: string;
  type: Transport;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  disabled: boolean;
}

const TRANSPORTS: Array<{ id: Transport; label: string; hint: string }> = [
  { id: "stdio", label: "stdio", hint: "Launch a local process (npx, uvx, a binary)." },
  { id: "sse", label: "SSE", hint: "Remote server over Server-Sent Events." },
  { id: "streamableHttp", label: "HTTP", hint: "Remote server over streamable HTTP." },
];

const emptyServer = (): McpServerInfo => ({
  name: "",
  type: "stdio",
  command: "",
  args: [],
  url: "",
  env: {},
  headers: {},
  disabled: false,
});

// ── Page ────────────────────────────────────────────────────────────────────

export default function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerInfo | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await invoke<McpServerInfo[]>("list_mcp_servers");
      setServers(list);
    } catch (e) {
      setError(normalize(e));
      setServers([]);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function persist(server: McpServerInfo) {
    setBusy(true);
    setError(null);
    try {
      await invoke("write_mcp_server", { server });
      setEditing(null);
      setIsNew(false);
      await reload();
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDisabled(server: McpServerInfo) {
    try {
      await invoke("set_mcp_server_disabled", { name: server.name, disabled: !server.disabled });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function remove(server: McpServerInfo) {
    try {
      await invoke("delete_mcp_server", { name: server.name });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="MCP"
        description="Model Context Protocol servers exposed to the agent. Each server adds tools (prefixed with its name) the agent can call, always under your approval."
        actions={
          <Button variant="primary" onClick={() => { setEditing(emptyServer()); setIsNew(true); }}>
            <Plus size={13} /> Add server
          </Button>
        }
      />

      {error && <ErrorLine message={error} />}

      {editing ? (
        <McpEditor
          server={editing}
          isNew={isNew}
          busy={busy}
          onChange={setEditing}
          onCancel={() => { setEditing(null); setIsNew(false); }}
          onSave={persist}
        />
      ) : servers === null ? (
        <LoadingLine />
      ) : servers.length === 0 ? (
        <div style={{ ...sectionCard, textAlign: "center", color: "var(--origin-fg-muted)" }}>
          <Plug size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>No MCP server configured</div>
          <div style={{ fontSize: 12, marginTop: 5, lineHeight: 1.6 }}>
            Add a server to give the agent extra tools
            (browser, database, internal APIs…).
          </div>
        </div>
      ) : (
        servers.map(server => (
          <ListRow
            key={server.name}
            title={server.name}
            badge={<Badge tone={server.disabled ? "neutral" : "success"}>{server.disabled ? "disabled" : "active"}</Badge>}
            subtitle={
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {server.type === "stdio"
                  ? [server.command, ...server.args].filter(Boolean).join(" ")
                  : server.url || "—"}
              </span>
            }
            right={
              <>
                <Switch
                  on={!server.disabled}
                  title={server.disabled ? "Enable" : "Disable"}
                  onToggle={() => void toggleDisabled(server)}
                />
                <IconButton title="Edit" onClick={() => { setEditing(clone(server)); setIsNew(false); }}>
                  <Pencil size={13} />
                </IconButton>
                <IconButton title="Delete" danger onClick={() => void remove(server)}>
                  <Trash2 size={13} />
                </IconButton>
              </>
            }
          />
        ))
      )}
    </div>
  );
}

// ── Formulaire d'édition ────────────────────────────────────────────────────

function McpEditor({ server, isNew, busy, onChange, onCancel, onSave }: {
  server: McpServerInfo;
  isNew: boolean;
  busy: boolean;
  onChange: (s: McpServerInfo) => void;
  onCancel: () => void;
  onSave: (s: McpServerInfo) => void;
}) {
  const [argsText, setArgsText] = useState(server.args.join("\n"));
  const isStdio = server.type === "stdio";
  const canSave =
    server.name.trim().length > 0 &&
    (isStdio ? (server.command ?? "").trim().length > 0 : (server.url ?? "").trim().length > 0);

  function save() {
    onChange({
      ...server,
      name: server.name.trim(),
      args: argsText.split("\n").map(a => a.trim()).filter(Boolean),
    });
    onSave({
      ...server,
      name: server.name.trim(),
      args: argsText.split("\n").map(a => a.trim()).filter(Boolean),
    });
  }

  return (
    <div style={sectionCard}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14, color: "var(--origin-fg-default)" }}>
        {isNew ? "New MCP server" : `Edit “${server.name}”`}
      </div>

      <Field label="Name" hint="Unique identifier for the server (letters, digits, '.', '_', '-').">
        <input
          value={server.name}
          disabled={!isNew}
          placeholder="chrome-devtools"
          onChange={e => onChange({ ...server, name: e.target.value })}
          style={monoFieldStyle}
        />
      </Field>

      <Field label="Transport">
        <div style={{ display: "flex", gap: 6 }}>
          {TRANSPORTS.map(t => (
            <button
              key={t.id}
              onClick={() => onChange({ ...server, type: t.id })}
              title={t.hint}
              style={{
                padding: "5px 12px", fontSize: 12, fontFamily: "inherit",
                borderRadius: 6, cursor: "pointer",
                border: `1px solid ${server.type === t.id ? "var(--origin-semantic-accent, #2f81f7)" : "var(--origin-border-default)"}`,
                backgroundColor: server.type === t.id ? "color-mix(in srgb, var(--origin-semantic-accent, #2f81f7) 14%, transparent)" : "transparent",
                color: "var(--origin-fg-default)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Field>

      {isStdio ? (
        <>
          <Field label="Command" hint="Binary to launch (resolved via your environment PATH).">
            <input
              value={server.command ?? ""}
              placeholder="npx"
              onChange={e => onChange({ ...server, command: e.target.value })}
              style={monoFieldStyle}
            />
          </Field>
          <Field label="Arguments" hint="One argument per line.">
            <textarea
              value={argsText}
              onChange={e => setArgsText(e.target.value)}
              rows={4}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder"}
              style={{ ...monoFieldStyle, resize: "vertical" }}
            />
          </Field>
          <Field label="Environment variables" hint="Stored in plain text in the settings file. Avoid durable secrets here.">
            <KeyValueEditor value={server.env} onChange={env => onChange({ ...server, env })} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" hint="Remote server endpoint (https preferred).">
            <input
              value={server.url ?? ""}
              placeholder="https://example.test/mcp"
              onChange={e => onChange({ ...server, url: e.target.value })}
              style={monoFieldStyle}
            />
          </Field>
          <Field label="HTTP headers" hint="Typically an authorization header.">
            <KeyValueEditor
              value={server.headers}
              onChange={headers => onChange({ ...server, headers })}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
            />
          </Field>
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
        <Button variant="primary" disabled={!canSave || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clone(server: McpServerInfo): McpServerInfo {
  return {
    ...server,
    args: [...server.args],
    env: { ...server.env },
    headers: { ...server.headers },
  };
}

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
