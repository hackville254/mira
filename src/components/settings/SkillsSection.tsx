/**
 * Mira — page RÉGLAGES « Skills ».
 *
 * RÔLE
 * ----
 * Lister, créer, éditer et activer/désactiver les compétences (skills) que
 * l'agent peut charger À LA DEMANDE via son outil `skills`.
 *
 * QU'EST-CE QU'UN SKILL ?
 * -----------------------
 * Un dossier `<nom>/` contenant un `SKILL.md` : un frontmatter (`name`,
 * `description`) puis un corps en Markdown. La `description` est ce que le
 * modèle voit en permanence ; le corps n'est lu que lorsque le modèle décide
 * d'utiliser la compétence — d'où l'importance d'une bonne description.
 *
 * PORTÉE
 * ------
 *   - **Global** (`~/.mira/skills`) : disponible dans tous les projets.
 *   - **Projet** (`<workspace>/.mira/skills`) : suit le dépôt, peut être commité.
 *
 * SÉCURITÉ
 * --------
 * Le contenu écrit ici est du Markdown inerte : il n'est jamais exécuté par
 * l'éditeur. Il sera injecté au modèle au moment de l'usage — l'auteur d'un
 * skill doit donc le traiter comme du texte d'instructions, pas comme du code
 * de confiance. Le backend valide le nom et borne la taille.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Plus, Pencil, Trash2, Zap } from "lucide-react";
import { notifyExtensionsChanged } from "../../lib/agent/clineClient";
import {
  Badge, Button, ErrorLine, Field, IconButton, ListRow, LoadingLine,
  PageHeader, ScopeTabs, Switch, monoFieldStyle, sectionCard, type Scope,
} from "./ui";

interface ArtifactInfo {
  name: string;
  description?: string | null;
  disabled: boolean;
  path: string;
  scope: string;
  /** `"mira"` (éditable) ou `"external"` (dossier compatible, lecture seule). */
  source?: string | null;
}

const SKILL_TEMPLATE = `---
name: my-skill
description: Describe in one sentence when the model should use this skill.
---

# My skill

Explain here, step by step, the procedure the model must follow.
`;

export default function SkillsSection({ workspace }: { workspace?: string }) {
  const projectAvailable = Boolean(workspace);
  const [scope, setScope] = useState<Scope>("global");
  const [items, setItems] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; content: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const activeScope: Scope = scope === "project" && !projectAvailable ? "global" : scope;

  const reload = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      const list = await invoke<ArtifactInfo[]>("list_skills", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
      });
      setItems(list);
    } catch (e) {
      setError(normalize(e));
      setItems([]);
    }
  }, [activeScope, workspace]);

  // Chargement initial + rechargement au changement de portée/projet. Le
  // `setState` a lieu dans la continuation de la promesse (jamais synchronement
  // dans le corps de l'effet), donc aucun rendu en cascade.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- chargement async volontaire
  useEffect(() => { void reload(); }, [reload]);

  async function openEditor(name: string, isNew: boolean) {
    setError(null);
    if (isNew) {
      setEditing({ name: "", content: SKILL_TEMPLATE, isNew: true });
      return;
    }
    try {
      const content = await invoke<string>("read_skill", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        name,
      });
      setEditing({ name, content, isNew: false });
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function save() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setError("The skill name is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await invoke("write_skill", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        name,
        content: editing.content,
      });
      setEditing(null);
      await reload();
      notifyExtensionsChanged();
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    try {
      await invoke("delete_skill", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        name,
      });
      await reload();
      notifyExtensionsChanged();
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function toggle(item: ArtifactInfo) {
    try {
      // On réécrit le frontmatter `enabled` sans toucher au corps : on lit, on
      // bascule la clé, on réécrit.
      const content = await invoke<string>("read_skill", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        name: item.name,
      });
      await invoke("write_skill", {
        scope: activeScope,
        workspace: activeScope === "project" ? workspace : null,
        name: item.name,
        content: withEnabled(content, item.disabled),
      });
      await reload();
      notifyExtensionsChanged();
    } catch (e) {
      setError(normalize(e));
    }
  }

  async function runImport(owner: string, repo: string, skill: string) {
    // Renvoie le nombre de skills installés, ou lève pour que le dialogue
    // affiche l'erreur sans fermer.
    const res = await invoke<{ installed: string[] }>("import_skills_from_repo", {
      scope: activeScope,
      workspace: activeScope === "project" ? workspace : null,
      owner,
      repo,
      branch: null,
      skill: skill ? skill : null,
    });
    await reload();
    notifyExtensionsChanged();
    return res.installed.length;
  }

  return (
    <div>
      <PageHeader
        title="Skills"
        description="Capabilities the agent loads on demand. Describe in the description WHEN to use it: it's the only part always visible to the model. Skills found in compatible folders (.agents/skills, Claude) are listed read-only."
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>
              <Download size={13} /> Import
            </Button>
            <Button variant="primary" onClick={() => void openEditor("", true)}>
              <Plus size={13} /> New skill
            </Button>
          </>
        }
      />

      {importOpen && (
        <ImportDialog
          scopeLabel={activeScope === "global" ? "global" : "project"}
          onClose={() => setImportOpen(false)}
          onSubmit={runImport}
        />
      )}

      <div style={{ marginBottom: 16 }}>
        <ScopeTabs scope={activeScope} onChange={setScope} projectAvailable={projectAvailable} />
        <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: 6 }}>
          {activeScope === "global"
            ? "Available across all your projects."
            : "Stored in the project and versioned with it."}
        </div>
      </div>

      {error && <ErrorLine message={error} />}

      {editing ? (
        <SkillEditor
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
          <Zap size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)" }}>No {activeScope === "global" ? "global skills" : "skills in this project"}</div>
          <div style={{ fontSize: 12, marginTop: 5 }}>Create a skill to give the agent a reusable procedure.</div>
        </div>
      ) : (
        items.map(item => {
          const isExternal = item.source === "external";
          return (
            <ListRow
              key={item.name}
              title={item.name}
              badge={
                isExternal
                  ? <Badge>external</Badge>
                  : item.disabled ? <Badge>disabled</Badge> : undefined
              }
              subtitle={item.description || <span style={{ opacity: 0.6 }}>No description</span>}
              right={
                isExternal ? (
                  <span
                    title="Skill discovered in a compatible folder (.agents/skills, Claude). Managed by its original tool — read-only here."
                    style={{ fontSize: 11, color: "var(--origin-fg-subtle)" }}
                  >
                    read-only
                  </span>
                ) : (
                  <>
                    <Switch on={!item.disabled} title={item.disabled ? "Enable" : "Disable"} onToggle={() => void toggle(item)} />
                    <IconButton title="Edit" onClick={() => void openEditor(item.name, false)}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton title="Delete" danger onClick={() => void remove(item.name)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </>
                )
              }
            />
          );
        })
      )}
    </div>
  );
}

// ── Dialogue d'import ────────────────────────────────────────────────────────

/**
 * Importe un ou plusieurs skills depuis un dépôt GitHub public (`owner/repo`).
 * Le téléchargement et l'extraction sont entièrement faits côté Rust : aucune
 * URL n'est fournie par l'interface, seuls le propriétaire et le dépôt sont
 * transmis, ce qui empêche toute redirection SSRF depuis la webview.
 */
function ImportDialog({ scopeLabel, onClose, onSubmit }: {
  scopeLabel: string;
  onClose: () => void;
  onSubmit: (owner: string, repo: string, skill: string) => Promise<number>;
}) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [skill, setSkill] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const refError = validateRepoRef(owner, repo);
  const canSubmit = !busy && !refError && (done === null);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const count = await onSubmit(owner.trim(), repo.trim(), skill.trim());
      setDone(count);
    } catch (e) {
      setError(normalize(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={busy ? undefined : onClose}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--origin-fg-default)" }}>
          Import skills
        </div>
        <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: 4, marginBottom: 14 }}>
          From a public GitHub repository. Installed skills are added to the {scopeLabel} scope.
        </div>

        {done !== null ? (
          <div style={{ fontSize: 12.5, color: "var(--origin-fg-default)", marginBottom: 14 }}>
            {done === 0
              ? "No skills were found in this repository."
              : `${done} skill${done > 1 ? "s" : ""} imported.`}
          </div>
        ) : (
          <>
            <Field label="Repository" hint="Format owner/repo, e.g. anthropics/skills.">
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  value={owner}
                  placeholder="owner"
                  disabled={busy}
                  onChange={e => setOwner(e.target.value)}
                  style={{ ...monoFieldStyle, flex: 1 }}
                />
                <span style={{ color: "var(--origin-fg-subtle)" }}>/</span>
                <input
                  value={repo}
                  placeholder="repo"
                  disabled={busy}
                  onChange={e => setRepo(e.target.value)}
                  style={{ ...monoFieldStyle, flex: 1 }}
                />
              </div>
            </Field>
            <Field label="Specific skill (optional)" hint="Leave empty to import all skills found in the repository.">
              <input
                value={skill}
                placeholder="code-review"
                disabled={busy}
                onChange={e => setSkill(e.target.value)}
                style={monoFieldStyle}
              />
            </Field>
            {owner.trim() !== "" && repo.trim() !== "" && refError && (
              <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: -4, marginBottom: 10 }}>
                {refError}
              </div>
            )}
            {error && <ErrorLine message={error} />}
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {done !== null ? (
            <Button variant="primary" onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? "Importing…" : "Import"}
              </Button>
              <Button onClick={onClose} disabled={busy}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Éditeur ─────────────────────────────────────────────────────────────────

function SkillEditor({ editing, busy, onChange, onCancel, onSave }: {
  editing: { name: string; content: string; isNew: boolean };
  busy: boolean;
  onChange: (e: { name: string; content: string; isNew: boolean }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={sectionCard}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14, color: "var(--origin-fg-default)" }}>
        {editing.isNew ? "New skill" : `Edit “${editing.name}”`}
      </div>
      <Field label="Name" hint="A folder with this name will be created containing a SKILL.md.">
        <input
          value={editing.name}
          disabled={!editing.isNew}
          placeholder="code-review"
          onChange={e => onChange({ ...editing, name: e.target.value })}
          style={monoFieldStyle}
        />
      </Field>
      <Field label="Content (Markdown)" hint="Frontmatter `name` + `description`, then the procedure.">
        <textarea
          value={editing.content}
          onChange={e => onChange({ ...editing, content: e.target.value })}
          rows={18}
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Valide un couple `owner/repo` côté client. C'est un simple garde-fou UX :
 * le backend revalide tout (slug restrictif) et reste la seule source de
 * vérité — on n'essaie pas de construire une URL ici.
 */
function validateRepoRef(owner: string, repo: string): string | null {
  const o = owner.trim();
  const r = repo.trim();
  if (!o && !r) return null;
  if (!o || !r) return "Enter both the owner and the repository.";
  const slug = /^[A-Za-z0-9._-]+$/;
  if (!slug.test(o) || o === "." || o === "..") return "Invalid owner.";
  if (!slug.test(r) || r === "." || r === "..") return "Invalid repository name.";
  return null;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  width: 420,
  maxWidth: "calc(100vw - 32px)",
  background: "var(--origin-bg-elevated, var(--origin-bg-default))",
  border: "1px solid var(--origin-border)",
  borderRadius: 10,
  padding: 18,
  boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
};
