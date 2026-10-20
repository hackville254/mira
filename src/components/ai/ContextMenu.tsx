/**
 * UI du caractère `#` du ChatBox : les « context mentions » de Trae.
 *
 * ── Deux écrans, une seule logique ───────────────────────────────────────────
 * Taper `#` ouvre d'abord le **menu des types** (`ContextTypeMenu`) : Code,
 * File, Folder, Workspace, Problems, Rule. C'est la différence de fond avec `@`
 * (qui ne cible qu'un fichier) : `#` sélectionne une *nature* de contexte.
 *
 *   - type « atomique » (Workspace, Problems) → il s'attache immédiatement ;
 *   - type « ciblé » (File, Folder, Rule)      → ouvre un second écran
 *     (`ContextPickerDropdown`) pour choisir la cible.
 *
 * ── Anti-duplication ─────────────────────────────────────────────────────────
 * Le picker de fichier/dossier réutilise `MentionDropdown` (déjà utilisé par
 * `@`) plutôt que de réimplémenter une liste de fichiers. Seul le picker de
 * **Rules** est propre à ce module : les règles ne sont pas des fichiers du
 * workspace mais des artefacts `.mira/rules`, résolus par le backend Rust
 * (`list_rules` / `read_rule`), jamais par un parcours disque côté front.
 *
 * ── Sécurité ─────────────────────────────────────────────────────────────────
 * Aucune lecture disque ici : on ne fait que *décrire* la cible choisie. La
 * résolution (confinement workspace, bornes de taille) est faite côté Rust au
 * moment de l'envoi (voir `context.rs` et `AiPanel`).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Code, FileText, Folder, Layers, AlertTriangle, ScrollText } from "lucide-react";
import { filterContextKinds, CONTEXT_KINDS, type ContextKind, type ContextRef } from "../../lib/contextMentions";

/** Le type le plus à droite de la hiérarchie `#` détermine la cible. */

// ── Menu des types ────────────────────────────────────────────────────────────

/** Icône lucide associée à chaque type de contexte. */
const KIND_ICONS: Record<ContextKind, typeof Code> = {
  code: Code,
  file: FileText,
  folder: Folder,
  workspace: Layers,
  problems: AlertTriangle,
  rule: ScrollText,
};

interface TypeMenuProps {
  anchorEl: HTMLElement | null;
  query: string;
  /** Types déjà attachés (déjà présents → affichés avec une coche, non re-sélectionnables). */
  attachedKinds: ContextKind[];
  onSelectKind: (kind: ContextKind) => void;
  onClose: () => void;
}

/**
 * Premier écran du `#` : la liste des types, filtrée par la requête tapée.
 * Se ferme au clic extérieur et à Échap (l'appelant gère les flèches/Entrée
 * via le clavier de l'éditeur).
 */
export function ContextTypeMenu({ anchorEl, query, attachedKinds, onSelectKind, onClose }: TypeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position du portail depuis le rect mesuré de l'ancre
    setPos({ top: r.top - 8, left: r.left, width: r.width });
  }, [anchorEl]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  if (!anchorEl) return null;

  const kinds = filterContextKinds(query);

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        bottom: window.innerHeight - pos.top,
        left: pos.left,
        width: Math.max(pos.width, 300),
        background: "color-mix(in srgb, var(--origin-bg-base) 88%, transparent)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "10px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        zIndex: 9999,
        overflow: "hidden",
        padding: "4px",
      }}
    >
      <div style={{ padding: "6px 8px 4px", fontSize: "11px", color: "var(--origin-fg-muted)" }}>
        Add context
      </div>
      {kinds.length === 0 ? (
        <div style={{ padding: "8px 10px", fontSize: "12px", color: "var(--origin-fg-subtle)" }}>
          No context type matches
        </div>
      ) : (
        kinds.map(k => {
          const Icon = KIND_ICONS[k.kind];
          const attached = !k.needsPicker && attachedKinds.includes(k.kind);
          return (
            <button
              key={k.kind}
              onMouseDown={e => { e.preventDefault(); if (!attached) onSelectKind(k.kind); }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: "10px",
                padding: "7px 9px", borderRadius: "7px", border: "none", cursor: attached ? "default" : "pointer",
                background: "transparent", textAlign: "left", opacity: attached ? 0.55 : 1,
              }}
            >
              <span style={{ color: "var(--origin-fg-muted)", flexShrink: 0, display: "flex" }}>
                <Icon size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "13px", color: "var(--origin-fg-default)" }}>{k.label}</span>
                <span style={{ display: "block", fontSize: "11px", color: "var(--origin-fg-muted)", lineHeight: 1.4 }}>
                  {k.description}
                </span>
              </span>
              {attached && <span style={{ color: "#3fb950", fontSize: "12px", flexShrink: 0 }}>✓</span>}
            </button>
          );
        })
      )}
    </div>,
    document.body,
  );
}

// ── Picker de rules ───────────────────────────────────────────────────────────

interface ArtifactInfo {
  name: string;
  description?: string | null;
  disabled: boolean;
  path: string;
  scope: string;
}

/** Une rule est proposée sous ses deux portées possibles : globale et projet. */
interface RuleOption {
  /** Chemin relatif à passer à `read_rule` (nom de fichier). */
  relPath: string;
  name: string;
  description?: string | null;
  scope: "global" | "project";
}

interface RulePickerProps {
  anchorEl: HTMLElement | null;
  workspace: string | null;
  onSelect: (rule: ContextRef) => void;
  onClose: () => void;
}

/**
 * Sélecteur de Rules : agrège les règles **globales** (`~/.mira/rules`) et
 * **projet** (`<ws>/.mira/rules`) via les commands du store d'extensions. La
 * cible attachée porte un `path` de la forme `global:<rel>` / `project:<rel>`,
 * que `AiPanel` résout ensuite avec `read_rule`.
 */
export function RulePicker({ anchorEl, workspace, onSelect, onClose }: RulePickerProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const [rules, setRules] = useState<RuleOption[]>([]);
  const [search, setSearch] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position du portail depuis le rect mesuré de l'ancre
    setPos({ top: r.top - 8, left: r.left, width: r.width });
  }, [anchorEl]);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Charge les deux portées en parallèle. Une portée projet absente (pas de
  // workspace) est simplement ignorée, pas une erreur.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: RuleOption[] = [];
      try {
        const globals = await invoke<ArtifactInfo[]>("list_rules", { scope: "global", workspace: null });
        for (const r of globals) out.push({ relPath: r.name, name: r.name, description: r.description, scope: "global" });
      } catch { /* portée globale indisponible : on continue */ }
      if (workspace) {
        try {
          const projects = await invoke<ArtifactInfo[]>("list_rules", { scope: "project", workspace });
          for (const r of projects) out.push({ relPath: r.name, name: r.name, description: r.description, scope: "project" });
        } catch { /* idem */ }
      }
      if (!cancelled) { setRules(out); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [workspace]);

  const filtered = search.trim()
    ? rules.filter(r => r.name.toLowerCase().includes(search.toLowerCase()))
    : rules;
  const visible = filtered.slice(0, 12);

  function choose(r: RuleOption) {
    const ref: ContextRef = {
      kind: "rule",
      path: `${r.scope}:${r.relPath}`,
      label: r.name,
    };
    onSelect(ref);
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, visible.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = visible[activeIdx]; if (r) choose(r); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        bottom: window.innerHeight - pos.top,
        left: pos.left,
        width: Math.max(pos.width, 300),
        background: "color-mix(in srgb, var(--origin-bg-base) 88%, transparent)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "10px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        zIndex: 9999,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "8px 8px 4px", borderBottom: "1px solid var(--origin-border-default)" }}>
        <input
          ref={searchRef}
          value={search}
          onChange={e => { setSearch(e.target.value); setActiveIdx(0); }}
          onKeyDown={handleKey}
          placeholder="Search rules…"
          style={{
            width: "100%", background: "none", border: "none", outline: "none",
            fontSize: "12px", color: "var(--origin-fg-default)", padding: "2px 4px",
          }}
        />
      </div>
      <div style={{ maxHeight: "220px", overflowY: "auto", padding: "4px" }}>
        {loading ? (
          <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", padding: "8px" }}>Loading rules…</div>
        ) : visible.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", padding: "8px" }}>
            No rules found. Add a <code>.md</code> under <code>.mira/rules/</code>.
          </div>
        ) : (
          visible.map((r, i) => (
            <button
              key={`${r.scope}:${r.relPath}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.preventDefault(); choose(r); }}
              style={{
                display: "flex", alignItems: "center", gap: "8px", width: "100%",
                padding: "6px 8px", borderRadius: "6px", border: "none", cursor: "pointer",
                background: i === activeIdx ? "var(--origin-bg-hover)" : "transparent",
                textAlign: "left",
              }}
            >
              <ScrollText size={12} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", fontSize: "12px", color: "var(--origin-fg-default)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {r.name}
                </span>
                {r.description && (
                  <span style={{
                    display: "block", fontSize: "11px", color: "var(--origin-fg-muted)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {r.description}
                  </span>
                )}
              </span>
              <span style={{
                fontSize: "10px", padding: "0 4px", borderRadius: "3px", flexShrink: 0,
                background: "var(--origin-bg-active)", color: "var(--origin-fg-subtle)",
              }}>
                {r.scope}
              </span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Catalogue complet exporté pour les tests d'intégration UI éventuels. */
export const CONTEXT_TYPE_COUNT = CONTEXT_KINDS.length;

// ── Picker de dossier ─────────────────────────────────────────────────────────

interface WsFile { name: string; path: string; ext: string }

interface FolderPickerProps {
  anchorEl: HTMLElement | null;
  query: string;
  workspace: string | null;
  onSelect: (folderPath: string, label: string) => void;
  onClose: () => void;
}

/**
 * Sélecteur de **dossier** pour `#Folder`.
 *
 * Le backend n'expose pas de liste de dossiers (seulement des fichiers, cf.
 * `list_workspace_files`) : on **dérive** l'arborescence des dossiers à partir
 * des chemins de fichiers, ce qui évite une nouvelle commande IPC et reste
 * exactement la même source de vérité que `@`/`#File`.
 *
 * La racine du workspace est elle-même proposée (label = nom du dossier racine)
 * pour permettre un `#Folder .`-like implicite.
 */
export function FolderPicker({ anchorEl, query, workspace, onSelect, onClose }: FolderPickerProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const [dirs, setDirs] = useState<{ path: string; label: string }[]>([]);
  const [search, setSearch] = useState(query);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position du portail depuis le rect mesuré de l'ancre
    setPos({ top: r.top - 8, left: r.left, width: r.width });
  }, [anchorEl]);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Dérive les dossiers uniques depuis la liste de fichiers du workspace.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void (async () => {
      try {
        const files = await invoke<WsFile[]>("list_workspace_files", { folder: workspace });
        const seen = new Map<string, string>();
        const sep = /[\\/]/;
        for (const f of files) {
          // On remonte chaque ancêtre de dossier du fichier.
          const parts = f.path.split(sep);
          parts.pop(); // retire le nom de fichier
          for (let i = 1; i <= parts.length; i++) {
            const dirPath = parts.slice(0, i).join("/");
            if (!dirPath) continue;
            const label = parts[i - 1];
            if (!seen.has(dirPath)) seen.set(dirPath, label);
          }
        }
        const out = [...seen.entries()]
          .map(([path, label]) => ({ path, label }))
          .sort((a, b) => a.path.localeCompare(b.path));
        if (!cancelled) setDirs(out);
      } catch { /* workspace illisible : liste vide */ }
    })();
    return () => { cancelled = true; };
  }, [workspace]);

  // Filtre sur le nom du dossier OU le chemin relatif (ex. « ai/cont »).
  const filtered = search.trim()
    ? dirs.filter(d => d.label.toLowerCase().includes(search.toLowerCase()) || d.path.toLowerCase().includes(search.toLowerCase()))
    : dirs;
  const visible = filtered.slice(0, 12);

  function choose(d: { path: string; label: string }) {
    onSelect(d.path, d.label);
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, visible.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const d = visible[activeIdx]; if (d) choose(d); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  if (!anchorEl) return null;

  const wsLabel = workspace?.split(/[\\/]/).filter(Boolean).pop() ?? "";

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        bottom: window.innerHeight - pos.top,
        left: pos.left,
        width: Math.max(pos.width, 300),
        background: "color-mix(in srgb, var(--origin-bg-base) 88%, transparent)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "10px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        zIndex: 9999,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "8px 8px 4px", borderBottom: "1px solid var(--origin-border-default)" }}>
        <input
          ref={searchRef}
          value={search}
          onChange={e => { setSearch(e.target.value); setActiveIdx(0); }}
          onKeyDown={handleKey}
          placeholder="Search folders…"
          style={{
            width: "100%", background: "none", border: "none", outline: "none",
            fontSize: "12px", color: "var(--origin-fg-default)", padding: "2px 4px",
          }}
        />
      </div>
      <div style={{ maxHeight: "220px", overflowY: "auto", padding: "4px" }}>
        {visible.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", padding: "8px" }}>
            No folders found
          </div>
        ) : (
          visible.map((d, i) => (
            <button
              key={d.path}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.preventDefault(); choose(d); }}
              style={{
                display: "flex", alignItems: "center", gap: "8px", width: "100%",
                padding: "6px 8px", borderRadius: "6px", border: "none", cursor: "pointer",
                background: i === activeIdx ? "var(--origin-bg-hover)" : "transparent",
                textAlign: "left",
              }}
            >
              <Folder size={12} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", fontSize: "12px", color: "var(--origin-fg-default)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {d.label}
                </span>
                {wsLabel && d.label !== wsLabel && (
                  <span style={{
                    display: "block", fontSize: "11px", color: "var(--origin-fg-muted)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {d.path.split(wsLabel).pop()?.replace(/^[/\\]/, "") ?? d.path}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
