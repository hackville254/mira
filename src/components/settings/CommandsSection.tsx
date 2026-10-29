/**
 * Mira — page RÉGLAGES « Commands ».
 *
 * RÔLE
 * ----
 * Gérer les slash-commands PERSONNALISÉES : des prompts réutilisables invoqués
 * en tapant `/nom` dans le chat (ex. `/revue`, `/test`, `/doc`).
 *
 * DIFFÉRENCE AVEC LES SKILLS (important)
 * --------------------------------------
 *   - Un **skill** est une compétence que le MODÈLE décide d'utiliser (il lit sa
 *     description et charge le corps à la demande).
 *   - Une **command** est un raccourci que TOI tu déclenches explicitement : le
 *     corps du fichier devient le prompt envoyé à l'agent.
 * Ce ne sont donc PAS les mêmes objets, et l'UI les sépare (comme le fait Trae).
 *
 * FORMAT
 * ------
 * Un fichier `<nom>.md` dans `<root>/commands/`. Frontmatter optionnel :
 *
 *     ---
 *     description: Relire la branche courante
 *     ---
 *     Passe en revue les changements non commités et propose un plan.
 *
 * Les arguments tapés après la commande (`/revue src/api`) sont ajoutés à la
 * suite du prompt côté moteur.
 *
 * SÉCURITÉ
 * --------
 * Le corps est un prompt, jamais du code exécuté. Le nom devient un nom de
 * fichier : validé côté Rust (slug, pas de traversal). Les commandes de premier
 * niveau sont exposées ; le backend tolère des sous-dossiers.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Pencil, Trash2, Command as CommandIcon } from "lucide-react";
import {
  Badge, Button, ErrorLine, Field, IconButton, ListRow, LoadingLine,
  PageHeader, ScopeTabs, monoFieldStyle, sectionCard, type Scope,
} from "./ui";

interface ArtifactInfo {
  name: string;
  description?: string | null;
  disabled: boolean;
  path: string;
  scope: string;
}

const COMMAND_TEMPLATE = `---
description: Describe in one sentence what this command does.
---
Write here the prompt sent to the agent when you type /my-command.
`;

export default function CommandsSection({ workspace }: { workspace?: string }) {
  const projectAvailable = Boolean(workspace);
  const [scope, setScope] = useState<Scope>("global");
  const [items, setItems] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; content: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const activeScope: Scope = scope === "project" && !projectAvailable ? "global" : scope;

  const reload = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      const list = await invoke<ArtifactInfo[]>("list_commands", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
      });
      setItems(list);
    } catch (e) {
      setError(normalize(e));
      setItems([]);
    }
  }, [activeScope, workspace]);

  // Chargement initial + rechargement au changement de portée/projet. `setState`
  // uniquement dans la continuation de la promesse (pas de rendu en cascade).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function openEditor(name: string, isNew: boolean) {
    setError(null);
    if (isNew) {
      setEditing({ name: "", content: COMMAND_TEMPLATE, isNew: true });
      return;
    }
    try {
      const content = await invoke<string>("read_command", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        relPath: name,
      });
      setEditing({ name, content, isNew: false });
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function save() {
    if (!editing) return;
    const name = editing.name.trim().replace(/^\/+/, "");
    if (!name) { setError("The command name is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await invoke("write_command", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
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
      await invoke("delete_command", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        relPath: name,
      });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="Commands"
        description="Shortcuts YOU trigger by typing /name in the chat. The file body is the prompt sent to the agent — arguments added after /name are concatenated."
        actions={
          <Button variant="primary" onClick={() => void openEditor("", true)}>
            <Plus size={13} /> New command
          </Button>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <ScopeTabs scope={activeScope} onChange={setScope} projectAvailable={projectAvailable} />
      </div>

      {error && <ErrorLine message={error} />}

      {editing ? (
        <CommandEditor
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
          <CommandIcon size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>No commands</div>
          <div style={{ fontSize: 12, marginTop: 5 }}>
            Create a command to turn a recurring prompt into a /name shortcut.
          </div>
        </div>
      ) : (
        items.map(item => (
          <ListRow
            key={item.name}
            title={<span style={{ fontFamily: "var(--font-mono)" }}>/{item.name}</span>}
            badge={item.scope === "project" ? <Badge tone="accent">project</Badge> : <Badge>global</Badge>}
            subtitle={item.description || <span style={{ opacity: 0.6 }}>No description</span>}
            right={
              <>
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

// ── Éditeur ─────────────────────────────────────────────────────────────────

function CommandEditor({ editing, busy, onChange, onCancel, onSave }: {
  editing: { name: string; content: string; isNew: boolean };
  busy: boolean;
  onChange: (e: { name: string; content: string; isNew: boolean }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={sectionCard}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14, color: "var(--origin-fg-default)" }}>
        {editing.isNew ? "New command" : `Edit /${editing.name}`}
      </div>
      <Field label="Name" hint="Without the leading /. The file will be <name>.md.">
        <input
          value={editing.name}
          disabled={!editing.isNew}
          placeholder="review"
          onChange={e => onChange({ ...editing, name: e.target.value })}
          style={monoFieldStyle}
        />
      </Field>
      <Field label="Content (Markdown)" hint="Frontmatter `description`, then the prompt.">
        <textarea
          value={editing.content}
          onChange={e => onChange({ ...editing, content: e.target.value })}
          rows={16}
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

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
