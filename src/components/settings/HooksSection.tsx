/**
 * Mira — page RÉGLAGES « Hooks ».
 *
 * RÔLE
 * ----
 * Gérer les scripts d'événements que l'agent exécute automatiquement à certains
 * moments (début de tâche, avant/après un outil, fin de tâche…). Un hook est un
 * script portant EXACTEMENT le nom d'un événement connu du moteur.
 *
 * ÉCRITURE RÉELLE
 * ---------------
 * La page ne se contente pas de montrer : elle écrit vraiment là où le moteur
 * regarde (via les commandes Rust `write_hook`/`read_hook`/`delete_hook`). Le
 * client ne voit aucune convention interne : seuls les noms d'événements et les
 * libellés lisibles sont exposés.
 *
 * SÉCURITÉ
 * --------
 * Un hook est du CODE exécuté automatiquement : c'est la surface la plus
 * sensible de tout l'IDE. On impose donc :
 *   - un avertissement clair et non masqué ;
 *   - un choix d'événement limité aux événements connus (pas de nom libre) ;
 *   - rien n'est exécuté depuis cette page : on ne fait qu'éditer le fichier.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Anchor, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  Badge, Button, ErrorLine, Field, IconButton, ListRow, LoadingLine, PageHeader,
  ScopeTabs, type Scope,
  fieldStyle, monoFieldStyle, sectionCard,
} from "./ui";

interface HookInfo {
  name: string;
  path: string;
  scope: string;
  executable: boolean;
}

/** Événements connus du moteur, avec un libellé lisible (ordre d'affichage). */
const HOOK_EVENTS: Array<{ id: string; label: string }> = [
  { id: "TaskStart", label: "Task start" },
  { id: "TaskResume", label: "Task resume" },
  { id: "TaskCancel", label: "Task cancel" },
  { id: "TaskComplete", label: "Task complete" },
  { id: "TaskError", label: "Task error" },
  { id: "UserPromptSubmit", label: "Message submitted" },
  { id: "PreToolUse", label: "Before a tool call" },
  { id: "PostToolUse", label: "After a tool call" },
  { id: "PreCompact", label: "Before context compaction" },
  { id: "SessionShutdown", label: "Session shutdown" },
];

const HOOK_LABELS: Record<string, string> = Object.fromEntries(
  HOOK_EVENTS.map(e => [e.id, e.label])
);

/** Modèle de script proposé à la création : un hook Node minimal, inoffensif. */
const HOOK_TEMPLATE = `// Mira hook — Node script run by the agent for this event.
// Receives the event details on stdin (JSON) and writes its result
// to stdout. Keep this script short: it runs on every trigger.
module.exports = async function () {
  // to be completed
};
`;

export default function HooksSection({ workspace }: { workspace?: string }) {
  const projectAvailable = Boolean(workspace);
  const [scope, setScope] = useState<Scope>("global");
  const [items, setItems] = useState<HookInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const activeScope: Scope = scope === "project" && !projectAvailable ? "global" : scope;

  const reload = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      const list = await invoke<HookInfo[]>("list_hooks", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
      });
      setItems(list);
    } catch (e) {
      setError(normalize(e));
      setItems([]);
    }
  }, [activeScope, workspace]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function remove(event: string) {
    setError(null);
    try {
      await invoke("delete_hook", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        event,
      });
      await reload();
    } catch (e) {
      setError(normalize(e));
    }
  }

  // Événements déjà définis (pour proposer la création des autres).
  const defined = new Set((items ?? []).filter(i => i.executable).map(i => i.name));
  const available = HOOK_EVENTS.filter(e => !defined.has(e.id));

  return (
    <div>
      <PageHeader
        title="Hooks"
        description="Scripts run automatically by the agent at specific moments (before a tool, at task end…). One hook per event."
        actions={
          <Button
            onClick={() => setEditorOpen(true)}
            disabled={available.length === 0}
            title={available.length === 0 ? "All events already have a hook" : undefined}
          >
            <Plus size={13} /> New hook
          </Button>
        }
      />

      <div style={{ ...sectionCard, display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 18 }}>
        <ShieldAlert size={16} style={{ color: "var(--origin-semantic-warning, #d29922)", flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, color: "var(--origin-fg-muted)", lineHeight: 1.6 }}>
          A hook is <strong style={{ color: "var(--origin-fg-default)" }}>automatically executed code</strong>.
          Only enable hooks whose content you understand: they run with the same rights as the IDE.
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <ScopeTabs scope={activeScope} onChange={setScope} projectAvailable={projectAvailable} />
      </div>

      {error && <ErrorLine message={error} />}

      {items === null ? (
        <LoadingLine />
      ) : items.length === 0 ? (
        <div style={{ ...sectionCard, textAlign: "center", color: "var(--origin-fg-muted)" }}>
          <Anchor size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>No hooks configured</div>
          <div style={{ fontSize: 12, marginTop: 5 }}>
            Nothing runs automatically outside the actions you trigger.
          </div>
        </div>
      ) : (
        items.map(item => (
          <ListRow
            key={item.path}
            title={HOOK_LABELS[item.name] ?? item.name}
            badge={
              item.executable
                ? <Badge tone="accent">active</Badge>
                : <Badge tone="warning">inactive</Badge>
            }
            subtitle={item.executable ? item.name : `${item.name} — non-executable extension`}
            right={
              <>
                <IconButton title="Edit" onClick={() => setEditorOpen(true)}>
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

      {editorOpen && (
        <HookEditor
          scope={activeScope}
          workspace={activeScope === "project" ? workspace ?? null : null}
          existing={items ?? []}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => { setEditorOpen(false); await reload(); }}
        />
      )}
    </div>
  );
}

/** Dialogue de création/édition d'un hook (un événement, un script JS). */
function HookEditor({ scope, workspace, existing, onClose, onSaved }: {
  scope: Scope;
  workspace: string | null;
  existing: HookInfo[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const defined = new Set(existing.filter(i => i.executable).map(i => i.name));
  const firstAvailable = HOOK_EVENTS.find(e => !defined.has(e.id))?.id ?? HOOK_EVENTS[0].id;
  const [event, setEvent] = useState(firstAvailable);
  const [content, setContent] = useState(HOOK_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charge le contenu existant quand on change d'événement (édition d'un hook
  // déjà défini), sinon on repart du modèle.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await invoke<string>("read_hook", { scope, workspace, event, ext: "js" });
        if (!cancelled) setContent(text.trim() ? text : HOOK_TEMPLATE);
      } catch {
        if (!cancelled) setContent(HOOK_TEMPLATE);
      }
    })();
    return () => { cancelled = true; };
  }, [event, scope, workspace]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await invoke("write_hook", { scope, workspace, event, ext: "js", content });
      await onSaved();
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>New hook</div>

        <Field label="Event" hint="The script triggers at this exact moment.">
          <select
            value={event}
            onChange={e => setEvent(e.target.value)}
            style={fieldStyle}
          >
            {HOOK_EVENTS.map(ev => (
              <option key={ev.id} value={ev.id}>
                {ev.label}{defined.has(ev.id) ? " (defined)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Script"
          hint="JavaScript run by the agent. Write to stdout to return a result. Leaving it empty deletes the hook."
        >
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
            rows={14}
            style={{ ...monoFieldStyle, resize: "vertical", lineHeight: 1.5 }}
          />
        </Field>

        {error && <ErrorLine message={error} />}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex", alignItems: "center", justifyContent: "center",
};

const dialogStyle: React.CSSProperties = {
  width: 560, maxWidth: "90vw", maxHeight: "85vh", overflowY: "auto",
  padding: 20, borderRadius: 10,
  backgroundColor: "var(--origin-bg-elevated, #161b22)",
  border: "1px solid var(--origin-border-default)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
};

function normalize(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
