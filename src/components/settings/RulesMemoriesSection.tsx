/**
 * Mira — page RÉGLAGES « Rules & Memories ».
 *
 * DEUX NOTIONS DISTINCTES (comme chez Trae)
 * -----------------------------------------
 *   - **Rules** : plusieurs fichiers Markdown, chacun une consigne ciblée.
 *     Un fichier = une règle. On peut en créer autant qu'on veut, les
 *     activer/désactiver séparément (`enabled: false` dans le frontmatter).
 *   - **Memories** : UN SEUL document durable (`memories.md`) que l'agent
 *     relit à chaque session. C'est la mémoire longue du projet — des faits
 *     appris, pas des consignes ponctuelles.
 *
 * PORTÉE
 * ------
 *   - **Global** : `~/.mira/rules/*.md` et `~/.mira/memories.md`.
 *   - **Projet** : `<workspace>/.mira/...`, versionnable avec le dépôt.
 *
 * SÉCURITÉ
 * --------
 * Le contenu est du Markdown inerte, jamais exécuté par l'éditeur. Il sera
 * injecté au modèle : à traiter comme des instructions, pas du code de
 * confiance. Le backend confine les chemins sous `.mira`, valide les noms et
 * borne la taille.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Pencil, Trash2, ScrollText } from "lucide-react";
import {
  Badge, Button, ErrorLine, Field, IconButton, ListRow, LoadingLine,
  PageHeader, ScopeTabs, SubHeading, Switch, monoFieldStyle, sectionCard, type Scope,
} from "./ui";

interface ArtifactInfo {
  name: string;
  description?: string | null;
  disabled: boolean;
  path: string;
  scope: string;
}

const RULE_TEMPLATE = `---
description: Describe in one sentence when this rule applies.
---
Write here the instruction the agent must always follow.
`;

const MEMORY_TEMPLATE = `# Project memory

- Architecture decisions made and their justification.
- Naming and structure conventions to follow.
- Known pitfalls and validated workarounds.
`;

export default function RulesMemoriesSection({ workspace }: { workspace?: string }) {
  const projectAvailable = Boolean(workspace);
  const [scope, setScope] = useState<Scope>("global");
  const activeScope: Scope = scope === "project" && !projectAvailable ? "global" : scope;

  return (
    <div>
      <PageHeader
        title="Rules & Memories"
        description="Rules are targeted instructions (one file per rule). Memories are a single document the agent re-reads every session: it's your project's long-term memory."
      />

      <div style={{ marginBottom: 18 }}>
        <ScopeTabs scope={activeScope} onChange={setScope} projectAvailable={projectAvailable} />
        <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: 6 }}>
          {activeScope === "global"
            ? "Applied across all your projects."
            : "Stored in the project and versioned with it."}
        </div>
      </div>

      <RulesBlock scope={activeScope} workspace={workspace} />
      <div style={{ height: 28 }} />
      <MemoriesBlock scope={activeScope} workspace={workspace} />
    </div>
  );
}

// ── Rules ────────────────────────────────────────────────────────────────────

function RulesBlock({ scope, workspace }: { scope: Scope; workspace?: string }) {
  const [items, setItems] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; content: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      const list = await invoke<ArtifactInfo[]>("list_rules", {
        scope,
        workspace: scope === "project" ? workspace : null,
      });
      setItems(list);
    } catch (e) {
      setError(normalize(e));
      setItems([]);
    }
  }, [scope, workspace]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function openEditor(name: string, isNew: boolean) {
    setError(null);
    if (isNew) {
      setEditing({ name: "", content: RULE_TEMPLATE, isNew: true });
      return;
    }
    try {
      const content = await invoke<string>("read_rule", {
        scope,
        workspace: scope === "project" ? workspace : null,
        relPath: name,
      });
      setEditing({ name, content, isNew: false });
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function save() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setError("The rule name is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await invoke("write_rule", {
        scope,
        workspace: scope === "project" ? workspace : null,
        relPath: name,
        content: editing.content,
      });
      setEditing(null);
      await reload();
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    try {
      await invoke("delete_rule", {
        scope,
        workspace: scope === "project" ? workspace : null,
        relPath: name,
      });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function toggle(item: ArtifactInfo) {
    try {
      const content = await invoke<string>("read_rule", {
        scope,
        workspace: scope === "project" ? workspace : null,
        relPath: item.name,
      });
      await invoke("write_rule", {
        scope,
        workspace: scope === "project" ? workspace : null,
        relPath: item.name,
        content: withEnabled(content, item.disabled),
      });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  return (
    <div>
      <SubHeading>Rules</SubHeading>
      <div style={{ display: "flex", marginBottom: 12 }}>
        <div style={{ flex: 1 }} />
        <Button onClick={() => void openEditor("", true)}>
          <Plus size={13} /> New rule
        </Button>
      </div>

      {error && <ErrorLine message={error} />}

      {editing ? (
        <RuleEditor
          editing={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : items === null ? (
        <LoadingLine />
      ) : items.length === 0 ? (
        <div style={{ ...sectionCard, textAlign: "center", color: "var(--origin-fg-muted)" }}>
          <ScrollText size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>
            No {scope === "global" ? "global rules" : "rules in this project"}
          </div>
          <div style={{ fontSize: 12, marginTop: 5 }}>
            A rule = one targeted instruction the agent follows every time.
          </div>
        </div>
      ) : (
        items.map(item => (
          <ListRow
            key={item.name}
            title={item.name}
            badge={item.disabled ? <Badge>disabled</Badge> : undefined}
            subtitle={item.description || <span style={{ opacity: 0.6 }}>No description</span>}
            right={
              <>
                <Switch on={!item.disabled} title={item.disabled ? "Enable" : "Disable"} onToggle={() => void toggle(item)} />
                <IconButton title="Edit" onClick={() => void openEditor(item.name, false)}>
                  <Pencil size={13} />
                </IconButton>
                <IconButton title="Delete" danger onClick={() => void remove(item.name)}>
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

function RuleEditor({ editing, busy, onChange, onCancel, onSave }: {
  editing: { name: string; content: string; isNew: boolean };
  busy: boolean;
  onChange: (e: { name: string; content: string; isNew: boolean }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={sectionCard}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14, color: "var(--origin-fg-default)" }}>
        {editing.isNew ? "New rule" : `Edit “${editing.name}”`}
      </div>
      <Field label="Name" hint="The file will be <name>.md in the rules/ folder.">
        <input
          value={editing.name}
          disabled={!editing.isNew}
          placeholder="code-style"
          onChange={e => onChange({ ...editing, name: e.target.value })}
          style={monoFieldStyle}
        />
      </Field>
      <Field label="Content (Markdown)" hint="Frontmatter `description`, then the instruction.">
        <textarea
          value={editing.content}
          onChange={e => onChange({ ...editing, content: e.target.value })}
          rows={14}
          spellCheck={false}
          style={{ ...monoFieldStyle, resize: "vertical", lineHeight: 1.55 }}
        />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="primary" disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

// ── Memories ─────────────────────────────────────────────────────────────────

function MemoriesBlock({ scope, workspace }: { scope: Scope; workspace?: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    setContent(null);
    try {
      const text = await invoke<string>("read_memories", {
        scope,
        workspace: scope === "project" ? workspace : null,
      });
      setContent(text);
    } catch (e) {
      setError(normalize(e));
      setContent("");
    }
  }, [scope, workspace]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (content === null) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("write_memories", {
        scope,
        workspace: scope === "project" ? workspace : null,
        content,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SubHeading>Memories</SubHeading>
      <div style={{ fontSize: 12, color: "var(--origin-fg-muted)", marginBottom: 12, lineHeight: 1.55 }}>
        A single document re-read every session. Emptying the field deletes the memory.
      </div>

      {error && <ErrorLine message={error} />}

      {content === null ? (
        <LoadingLine />
      ) : (
        <div style={sectionCard}>
          <Field label="Memory" hint="Durable facts: decisions, conventions, known pitfalls.">
            <textarea
              value={content}
              placeholder={MEMORY_TEMPLATE}
              onChange={e => setContent(e.target.value)}
              rows={14}
              spellCheck={false}
              style={{ ...monoFieldStyle, resize: "vertical", lineHeight: 1.55 }}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
            {saved && (
              <span style={{ fontSize: 12, color: "var(--origin-semantic-success, #2ea043)" }}>
                Saved
              </span>
            )}
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Insère ou remplace `enabled:` dans le frontmatter. Si aucun frontmatter
 * n'existe, on en crée un minimal pour que la clé soit au bon endroit.
 */
function withEnabled(content: string, enable: boolean): string {
  const value = enable ? "true" : "false";
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const fm = content.slice(4, end);
      const body = content.slice(end);
      const nextFm = /^enabled:/m.test(fm)
        ? fm.replace(/^enabled:.*$/m, `enabled: ${value}`)
        : `${fm.replace(/\n*$/, "")}\nenabled: ${value}\n`;
      return `---\n${nextFm}${body}`;
    }
  }
  return `---\nenabled: ${value}\n---\n${content}`;
}

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
