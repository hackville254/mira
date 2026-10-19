import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Plus, ArrowUp, ChevronDown, ChevronRight, Bot, MessageCircle, MessageSquare, Map, FileCode, X, Sparkles, Hand, Mic, Hash, SquareSlash, Image as ImageIcon, Wand2, BookOpen, Waypoints, Square, Clock, Pencil, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import PreferencesDropdown from "./PreferencesDropdown";
import logoCode from "../../assets/logo-code.svg";
import MentionDropdown from "./MentionDropdown";
import { PROVIDERS, DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./providers";
import type { EditorContext } from "../editor/Editor";
import { useWorkspace } from "../../context/WorkspaceContext";
import { resolveDefaultModel, resolveDefaultProvider } from "../../lib/secrets";
import { copyPath, createDirCmd, pathExists } from "../../lib/fs";
import { loadPermissionMode, savePermissionMode, type PermissionMode } from "../../lib/agent/permissions";
import {
  AGENTS as AGENT_DESCRIPTORS,
  type Mode,
  type AgentIcon,
  type SlashCommand,
  readStoredMode,
  writeStoredMode,
  parseSlashCommand,
  filterSlashCommands,
  getSlashQuery,
  mergeSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/inputCommands";
import type { ClineSkillInfo, ClineRuntimeCommand } from "../../lib/agent/clineClient";
import {
  CUSTOM_AGENTS_EVENT,
  listAgents,
  readSelectedAgentId,
  setSelectedAgentId,
  resolveSelectedAgent,
  type CustomAgent,
} from "../../lib/agent/customAgents";
import {
  getHashQuery,
  contextKindDescriptor,
  type ContextRef,
  type ContextKind,
} from "../../lib/contextMentions";
import { ContextTypeMenu, RulePicker, FolderPicker } from "./ContextMenu";

// ── Agent selector ────────────────────────────────────────────────────────────

/** Mappe le libellé d'icône du module vers un composant lucide. */
const AGENT_ICONS: Record<AgentIcon, typeof Bot> = {
  chat: MessageSquare,
  agent: Bot,
  plan: Waypoints,
};

/** Agents affichés dans le menu : identifiants + libellés viennent du module. */
const AGENTS = AGENT_DESCRIPTORS.map(a => ({ ...a, Icon: AGENT_ICONS[a.icon] }));

function ModeDropdown({ anchorEl, selected, customAgents, selectedAgentId, onSelect, onSelectAgent, onCreate, onClose }: {
  anchorEl: HTMLElement | null;
  selected: Mode;
  /** Agents personnalisés de l'utilisateur (persistés globalement). */
  customAgents: CustomAgent[];
  /** Id de l'agent personnalisé actif, ou `null` si un mode intégré est actif. */
  selectedAgentId: string | null;
  onSelect: (m: Mode) => void;
  onSelectAgent: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position portal from measured anchor rect
    setPos({ left: r.left, top: r.top - 6 });
  }, [anchorEl]);
  useEffect(() => {
    function onDown(e: MouseEvent) { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  if (!anchorEl) return null;
  return createPortal(
    <div ref={menuRef} style={{ position:"fixed", top:pos.top, left:pos.left, minWidth:"248px", maxWidth:"280px",
      transform:"translateY(-100%)",
      background:"color-mix(in srgb, var(--origin-bg-base) 90%, transparent)", backdropFilter:"blur(16px)",
      WebkitBackdropFilter:"blur(16px)", border:"1px solid var(--origin-border-default)", borderRadius:"10px",
      boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px", zIndex:9999,
      maxHeight:"60vh", overflowY:"auto" }}>
      <div style={{ padding:"6px 8px 6px", fontSize:"12px", color:"var(--origin-fg-muted)" }}>Built-In Agents</div>
      {AGENTS.map(({ id, label, Icon }) => {
        const isSelected = !selectedAgentId && selected === id; const isHovered = hovered === id;
        return (
          <button key={id} onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)}
            onClick={() => { onSelect(id); onClose(); }}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:"10px", padding:"8px 10px",
              borderRadius:"7px", border:"none", cursor:"pointer",
              background: isHovered ? "var(--origin-bg-hover)" : "transparent", textAlign:"left", transition:"background 0.1s" }}>
            <span style={{ display:"flex", alignItems:"center", justifyContent:"center", width:"22px", height:"22px",
              borderRadius:"5px", background:"#0d2216", color:"#3fb950", flexShrink:0 }}>
              <Icon size={13} />
            </span>
            <span style={{ flex:1, fontSize:"13px", fontWeight: isSelected ? 600 : 400, color:"var(--origin-fg-default)" }}>{label}</span>
            {isSelected && <span style={{ color:"#3fb950", flexShrink:0, fontSize:"13px" }}>✓</span>}
          </button>
        );
      })}
      {customAgents.length > 0 && (
        <>
          <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
          <div style={{ padding:"6px 8px 6px", fontSize:"12px", color:"var(--origin-fg-muted)" }}>Custom Agents</div>
          {customAgents.map(agent => {
            const key = `agent:${agent.id}`;
            const isSelected = selectedAgentId === agent.id; const isHovered = hovered === key;
            return (
              <button key={key} onMouseEnter={() => setHovered(key)} onMouseLeave={() => setHovered(null)}
                onClick={() => { onSelectAgent(agent.id); onClose(); }}
                title={agent.name}
                style={{ width:"100%", display:"flex", alignItems:"center", gap:"10px", padding:"8px 10px",
                  borderRadius:"7px", border:"none", cursor:"pointer",
                  background: isHovered ? "var(--origin-bg-hover)" : "transparent", textAlign:"left", transition:"background 0.1s" }}>
                <span style={{ display:"flex", alignItems:"center", justifyContent:"center", width:"22px", height:"22px",
                  borderRadius:"5px", background:"#1a2540", color:"#7aa2f7", flexShrink:0 }}>
                  <Bot size={13} />
                </span>
                <span style={{ flex:1, fontSize:"13px", fontWeight: isSelected ? 600 : 400, color:"var(--origin-fg-default)",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{agent.name}</span>
                {isSelected && <span style={{ color:"#3fb950", flexShrink:0, fontSize:"13px" }}>✓</span>}
              </button>
            );
          })}
        </>
      )}
      <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
      <button onMouseEnter={() => setHovered("create")} onMouseLeave={() => setHovered(null)}
        onClick={() => { onClose(); onCreate(); }}
        style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"center", padding:"8px 10px",
          borderRadius:"7px", border:"none", cursor:"pointer",
          background: hovered === "create" ? "var(--origin-bg-hover)" : "transparent",
          fontSize:"13px", fontWeight:600, color:"var(--origin-fg-muted)", transition:"background 0.1s" }}>
        Create Agent
      </button>
    </div>, document.body
  );
}

// ── Approval menu (UI only) ─────────────────────────────────────────────────────

const APPROVAL_OPTIONS: { id: PermissionMode; Icon: typeof Hand; label: string; desc: string; color?: string }[] = [
  { id: "manual", Icon: Hand,           label: "Manual Approval", desc: "You confirm important actions",                  color: undefined },
  { id: "auto",   Icon: MessageCircle,  label: "Auto Approval",   desc: "Auto-approves edits in the project, asks otherwise", color: undefined },
  { id: "full",   Icon: Map,            label: "Full Access",     desc: "Run directly on your computer without approval", color: "#d9822b" },
];

function ApprovalMenu({ anchorEl, onClose, mode, onSelect }: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  mode: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position portal from measured anchor rect
    setPos({ left: r.left, top: r.top - 6 });
  }, [anchorEl]);
  useEffect(() => {
    function onDown(e: MouseEvent) { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  if (!anchorEl) return null;
  return createPortal(
    <div ref={menuRef} style={{ position:"fixed", top:pos.top, left:pos.left, minWidth:"320px", maxWidth:"360px",
      transform:"translateY(-100%)",
      background:"color-mix(in srgb, var(--origin-bg-base) 90%, transparent)", backdropFilter:"blur(16px)",
      WebkitBackdropFilter:"blur(16px)", border:"1px solid var(--origin-border-default)", borderRadius:"10px",
      boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px", zIndex:9999 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 8px 8px" }}>
        <span style={{ fontSize:"12px", color:"var(--origin-fg-muted)" }}>How should Agent actions be approved?</span>
      </div>
      {APPROVAL_OPTIONS.map(({ id, Icon, label, desc, color }) => {
        const isSelected = mode === id;
        return (
          <button key={id} onClick={() => { onSelect(id); onClose(); }}
            style={{ width:"100%", display:"flex", alignItems:"flex-start", gap:"10px", padding:"8px 10px",
              borderRadius:"7px", border:"none", cursor:"pointer", background:"transparent", textAlign:"left", transition:"background 0.1s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
            <div style={{ marginTop:"1px", color: color ?? "var(--origin-fg-muted)", flexShrink:0 }}><Icon size={15} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize:"13px", fontWeight:500, color: color ?? "var(--origin-fg-default)", marginBottom:"2px" }}>{label}</div>
              <div style={{ fontSize:"11px", color:"var(--origin-fg-muted)", lineHeight:"1.4" }}>{desc}</div>
            </div>
            {isSelected && <span style={{ color:"#3fb950", flexShrink:0, fontSize:"13px" }}>✓</span>}
          </button>
        );
      })}
    </div>, document.body
  );
}

// ── Attach menu (+ button) ──────────────────────────────────────────────────────

/**
 * Actions réelles du menu `+` (aligné sur Trae). Chaque entrée fait quelque
 * chose d'utile : « Add Context » ouvre le sélecteur de fichiers, « / for
 * commands & skills » insère un `/` pour déclencher l'autocomplétion, « Upload
 * image » copie une image dans le workspace et l'attache comme contexte, et
 * « Commands » propose les modes d'agent (`/agent`, `/plan`, `/ask`).
 */
function AttachMenu({ anchorEl, onAddContext, onCommand, onInsertSlash, onUploadImage, onClose, skills, onSkill }: {
  anchorEl: HTMLElement | null; onAddContext: () => void; onClose: () => void;
  /** Ouvre l'autocomplétion des commandes/skills (insère `/` dans l'input). */
  onInsertSlash: () => void;
  /** Applique une slash-command par son nom (ex. `agent`, `plan`, `ask`). */
  onCommand: (name: string) => void;
  /** Ouvre le sélecteur d'image et l'attache au message. */
  onUploadImage: () => void;
  /** Skills réellement découvertes (dossier `.cline/skills`, etc.). */
  skills: ClineSkillInfo[];
  /** Insère `/skillName ` dans l'input quand une skill est choisie. */
  onSkill?: (name: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position portal from measured anchor rect
    setPos({ left: r.left, top: r.top - 6 });
  }, [anchorEl]);
  useEffect(() => {
    function onDown(e: MouseEvent) { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  if (!anchorEl) return null;

  const rowStyle = (id: string): React.CSSProperties => ({
    width:"100%", display:"flex", alignItems:"center", gap:"10px", padding:"8px 10px",
    borderRadius:"7px", border:"none", cursor:"pointer", transition:"background 0.1s",
    background: hovered === id ? "var(--origin-bg-hover)" : "transparent", textAlign:"left",
    fontSize:"13px", color:"var(--origin-fg-default)",
  });
  const iconStyle: React.CSSProperties = { color:"var(--origin-fg-muted)", flexShrink:0 };

  return createPortal(
    <div ref={menuRef} style={{ position:"fixed", top:pos.top, left:pos.left, minWidth:"248px",
      transform:"translateY(-100%)",
      background:"color-mix(in srgb, var(--origin-bg-base) 90%, transparent)", backdropFilter:"blur(16px)",
      WebkitBackdropFilter:"blur(16px)", border:"1px solid var(--origin-border-default)", borderRadius:"10px",
      boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px", zIndex:9999 }}>
      <button style={rowStyle("ctx")} onMouseEnter={() => setHovered("ctx")} onMouseLeave={() => setHovered(null)}
        onClick={() => { onClose(); onAddContext(); }}>
        <span style={iconStyle}><Hash size={15} /></span>Add Context
      </button>
      <button style={rowStyle("cmd")} onMouseEnter={() => setHovered("cmd")} onMouseLeave={() => setHovered(null)}
        onClick={() => { onClose(); onInsertSlash(); }}>
        <span style={iconStyle}><SquareSlash size={15} /></span>/ for commands &amp; skills
      </button>
      <button style={rowStyle("img")} onMouseEnter={() => setHovered("img")} onMouseLeave={() => setHovered(null)}
        onClick={() => { onClose(); onUploadImage(); }}>
        <span style={iconStyle}><ImageIcon size={15} /></span>Upload image
      </button>
      <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
      {/* Commands : applique un mode d'agent (mêmes commandes que `/agent`,
          `/plan`, `/ask`) au lieu d'entrées décoratives sans effet. */}
      {SLASH_COMMANDS.filter(c => c.source === "builtin" && c.action.kind === "set-mode").map((cmd) => (
        <button key={cmd.name} style={rowStyle(`mode-${cmd.name}`)}
          onMouseEnter={() => setHovered(`mode-${cmd.name}`)} onMouseLeave={() => setHovered(null)}
          onClick={() => { onClose(); onCommand(cmd.name); }}>
          <span style={iconStyle}><Wand2 size={15} /></span>
          <span style={{ flex:1 }}>/{cmd.name}</span>
          <span style={{ fontSize:"11px", color:"var(--origin-fg-subtle)" }}>{cmd.description}</span>
        </button>
      ))}
      <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
      <div style={{ position:"relative" }}
        onMouseEnter={() => setHovered("skills")} onMouseLeave={() => setHovered(null)}>
        <button style={rowStyle("skills")} onClick={() => { onClose(); }}>
          <span style={iconStyle}><BookOpen size={15} /></span>
          <span style={{ flex:1 }}>Skills</span>
          <ChevronRight size={14} style={{ color:"var(--origin-fg-subtle)", flexShrink:0 }} />
        </button>
        {hovered === "skills" && (
          <div style={{ position:"absolute", right:"100%", top:0, minWidth:"260px", maxWidth:"320px",
            maxHeight:"320px", overflowY:"auto",
            background:"color-mix(in srgb, var(--origin-bg-base) 90%, transparent)", backdropFilter:"blur(16px)",
            WebkitBackdropFilter:"blur(16px)", border:"1px solid var(--origin-border-default)", borderRadius:"10px",
            boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px" }}>
            {skills.length === 0 ? (
              // Surface VIDE et honnête : on explique où déposer une skill plutôt
              // que d'afficher des entrées décoratives qui ne feraient rien.
              <div style={{ padding:"8px 10px", fontSize:"12px", color:"var(--origin-fg-muted)", lineHeight:"1.5" }}>
                No skills found. Add a <code>SKILL.md</code> under <code>.mira/skills/&lt;name&gt;/</code>.
              </div>
            ) : (
              skills.map((s) => (
                <button key={s.name} onClick={() => { onSkill?.(s.name); onClose(); }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                  style={{ width:"100%", display:"flex", flexDirection:"column", gap:"2px", padding:"8px 10px",
                    borderRadius:"7px", border:"none", cursor:"pointer", background:"transparent",
                    textAlign:"left" }}>
                  <span style={{ fontSize:"13px", color:"var(--origin-fg-default)" }}>{s.name}</span>
                  {s.description && (
                    <span style={{ fontSize:"11px", color:"var(--origin-fg-muted)", lineHeight:"1.4" }}>
                      {s.description}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>, document.body
  );
}

// ── Badge helpers ─────────────────────────────────────────────────────────────
function createBadgeElement(filepath: string, filename: string): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.contentEditable = 'false';
  badge.setAttribute('data-filepath', filepath);
  badge.textContent = filename;
  badge.style.cssText = [
    'display:inline-flex', 'align-items:center', 'padding:1px 6px',
    'border-radius:4px', 'font-size:11px', 'font-family:var(--font-mono)',
    'background:var(--origin-bg-active)',
    'border:1px solid var(--origin-border-default)',
    'color:var(--origin-fg-default)', 'cursor:default', 'user-select:none',
    'vertical-align:middle', 'margin:0 1px',
  ].join(';');
  return badge;
}

function appendFileBadge(el: HTMLDivElement, filepath: string, filename: string) {
  // Don't duplicate
  if (el.querySelector(`[data-filepath="${CSS.escape(filepath)}"]`)) return;

  const badge = createBadgeElement(filepath, filename);
  // Ensure a space before the badge if content exists
  const last = el.lastChild;
  if (last && !(last.nodeType === Node.TEXT_NODE && (last.textContent ?? '').endsWith(' '))) {
    el.appendChild(document.createTextNode(' '));
  }
  el.appendChild(badge);
  el.appendChild(document.createTextNode(' '));

  // Move cursor to end
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = document.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}

// ── Mention helpers ───────────────────────────────────────────────────────────

function getMentionQuery(el: HTMLDivElement): string | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const textBefore = (node.textContent ?? '').slice(0, range.startOffset);
  const match = textBefore.match(/@(\S*)$/);
  return match ? match[1] : null;
}

function insertMentionBadge(el: HTMLDivElement, savedRange: Range, filepath: string, filename: string) {
  // Restore focus and cursor position (lost when user clicked the dropdown)
  el.focus();
  const sel = document.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(savedRange.cloneRange());

  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;

  const textContent = node.textContent ?? '';
  const beforeCursor = textContent.slice(0, range.startOffset);
  const afterCursor = textContent.slice(range.startOffset);

  const match = beforeCursor.match(/@(\S*)$/);
  if (!match) return;
  const atIndex = beforeCursor.length - match[0].length;

  const badge = createBadgeElement(filepath, filename);

  const parent = node.parentNode!;
  const beforeNode = document.createTextNode(beforeCursor.slice(0, atIndex));
  const afterNode = document.createTextNode(' ' + afterCursor);

  parent.insertBefore(beforeNode, node);
  parent.insertBefore(badge, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);

  // Move cursor after the inserted space
  const newRange = document.createRange();
  newRange.setStart(afterNode, 1);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

function parseContent(el: HTMLDivElement): { displayText: string; fileMentions: string[] } {
  const fileMentions: string[] = [];
  let displayText = '';

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      displayText += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      const fp = elem.getAttribute('data-filepath');
      if (fp) {
        fileMentions.push(fp);
        displayText += `@${elem.textContent}`;
      } else if (elem.tagName === 'BR') {
        displayText += '\n';
      } else {
        elem.childNodes.forEach(walk);
      }
    }
  }

  el.childNodes.forEach(walk);
  return { displayText: displayText.trim(), fileMentions };
}

// ── Contexte `#` (context mentions) ──────────────────────────────────────────

/**
 * Badge DOM représentant un contexte `#` (`#Folder`, `#Rule`, `#Workspace`…).
 *
 * On réutilise le mécanisme des badges de fichiers (`data-*` + `contentEditable
 * = false`) pour rester compatible avec le parsing de contenu et la suppression
 * au clavier — mais avec un attribut distinct (`data-context`) afin de ne pas
 * confondre un contexte `#` avec une mention de fichier `@`.
 */
function createContextBadgeElement(ref: ContextRef): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.contentEditable = 'false';
  badge.setAttribute('data-context', `${ref.kind}:${ref.path ?? ""}`);
  badge.setAttribute('data-context-label', ref.label);
  badge.textContent = `#${ref.label}`;
  badge.style.cssText = [
    'display:inline-flex', 'align-items:center', 'padding:1px 6px',
    'border-radius:4px', 'font-size:11px', 'font-family:var(--font-mono)',
    'background:var(--origin-bg-active)',
    'border:1px solid var(--origin-border-default)',
    'color:var(--origin-fg-default)', 'cursor:default', 'user-select:none',
    'vertical-align:middle', 'margin:0 1px',
  ].join(';');
  return badge;
}

/**
 * Remplace la requête `#…` en cours par un badge de contexte.
 *
 * IMPORTANT — on ne se fie PAS à une `Range` mémorisée au moment de la frappe.
 * Entre l'ouverture du menu `#` et la sélection, le DOM de l'éditeur peut avoir
 * été re-rendu et la sélection déplacée : une `Range` clonée devient alors
 * détachée, `startContainer` n'est plus un nœud texte, et l'insertion échouait
 * SILENCIEUSEMENT (menu ouvert, mais « rien ne s'insère »). On localise donc la
 * requête `#…` **dans l'éditeur lui-même**, au moment de l'insertion, ce qui est
 * indépendant de toute sélection périmée.
 *
 * Stratégie : on parcourt les nœuds texte de l'éditeur et on cherche le DERNIER
 * `#` en fin de texte. S'il existe, on le remplace par le badge ; sinon on
 * ajoute le badge à la fin.
 */
function insertContextBadge(el: HTMLDivElement, _savedRange: Range | null, ref: ContextRef): void {
  el.focus();

  // Localise le dernier nœud texte se terminant par une requête `#…`.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  let node: Node | null = walker.nextNode();
  while (node) {
    const t = (node.textContent ?? '');
    if (/#[^\s#]*$/.test(t)) target = node as Text;
    node = walker.nextNode();
  }

  if (!target) {
    // Aucune requête `#` résiduelle (déjà remplacée, focus perdu…) : on ajoute.
    appendContextBadge(el, ref);
    return;
  }

  const textContent = target.textContent ?? '';
  const match = textContent.match(/#[^\s#]*$/);
  if (!match) { appendContextBadge(el, ref); return; }
  const hashIndex = textContent.length - match[0].length;

  const badge = createContextBadgeElement(ref);
  const parent = target.parentNode;
  if (!parent) { appendContextBadge(el, ref); return; }
  const beforeNode = document.createTextNode(textContent.slice(0, hashIndex));
  const afterNode = document.createTextNode(textContent.slice(textContent.length) + ' ');
  parent.insertBefore(beforeNode, target);
  parent.insertBefore(badge, target);
  parent.insertBefore(afterNode, target);
  parent.removeChild(target);

  const newRange = document.createRange();
  newRange.setStart(afterNode, afterNode.textContent?.length ?? 0);
  newRange.collapse(true);
  const sel = document.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(newRange); }
}

/** Ajoute un badge de contexte à la fin (choix via le menu `+`, pas de requête `#`). */
function appendContextBadge(el: HTMLDivElement, ref: ContextRef) {
  const key = `${ref.kind}:${ref.path ?? ""}`;
  if (el.querySelector(`[data-context="${CSS.escape(key)}"]`)) return;
  const badge = createContextBadgeElement(ref);
  const last = el.lastChild;
  if (last && !(last.nodeType === Node.TEXT_NODE && (last.textContent ?? '').endsWith(' '))) {
    el.appendChild(document.createTextNode(' '));
  }
  el.appendChild(badge);
  el.appendChild(document.createTextNode(' '));
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = document.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}

/** Lit les badges de contexte actuellement présents dans l'éditeur, dans l'ordre. */
function readContextBadges(el: HTMLDivElement): ContextRef[] {
  const refs: ContextRef[] = [];
  el.querySelectorAll('[data-context]').forEach(node => {
    const raw = node.getAttribute('data-context') ?? "";
    const sep = raw.indexOf(':');
    const kind = (sep === -1 ? raw : raw.slice(0, sep)) as ContextKind;
    const path = sep === -1 ? undefined : raw.slice(sep + 1) || undefined;
    const label = node.getAttribute('data-context-label') ?? contextKindDescriptor(kind)?.label ?? raw;
    refs.push({ kind, path, label });
  });
  return refs;
}

function contextLabel(ctx: EditorContext): string {
  if (ctx.startLine === ctx.endLine) return `L${ctx.startLine}`;
  return `L${ctx.startLine}–${ctx.endLine}`;
}

/** Style des petits boutons du bandeau « Waiting to send » (éditer, retirer). */
const queuedMiniBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "none", border: "none", cursor: "pointer",
  padding: "1px", color: "var(--origin-fg-subtle)", flexShrink: 0,
};

// ── Component ─────────────────────────────────────────────────────────────────

/** API impérative exposée au parent (ex. « éditer et renvoyer » un message). */
export interface ChatBoxHandle {
  /** Remplace le contenu de l'éditeur par `text` et place le focus à la fin. */
  setText: (text: string) => void;
}

interface ChatBoxProps {
  onSend?: (text: string, modelId: string, providerId: string, fileMentions: string[], editorContext: EditorContext | null, mode: Mode, contextRefs: ContextRef[]) => void;
  getEditorContext?: () => EditorContext | null;
  forcedContext?: EditorContext | null;
  onForcedContextConsumed?: () => void;
  /** Un tour est-il en cours ? Transforme le bouton d'envoi en bouton Stop. */
  isStreaming?: boolean;
  /** Interrompt le tour courant (abort du stream + tools). */
  onStop?: () => void;
  /** Ref transmise par le parent pour piloter l'éditeur (edit & resend). */
  handleRef?: React.RefObject<ChatBoxHandle | null>;
  /**
   * Message actuellement en file d'attente (envoyé automatiquement à la fin du
   * tour courant). Rendu sous forme de bandeau « Waiting to send ».
   */
  queued?: { text: string; fileMentions?: string[]; contextRefs?: string[] } | null;
  /** Retire de la file le message en attente. */
  onRemoveQueued?: () => void;
  /**
   * Réinjecte le message en attente dans l'éditeur pour le modifier. Le message
   * est retiré de la file (le parent gère le retrait).
   */
  onEditQueued?: () => void;
  /**
   * Appelé lorsqu'un envoi survient ALORS qu'un tour est déjà en cours : le
   * message doit être mis en file d'attente au lieu de lancer un nouveau run.
   * Renvoie `true` si le message a bien été pris en charge par la file.
   */
  onQueue?: (text: string, modelId: string, providerId: string, fileMentions: string[], editorContext: EditorContext | null, mode: Mode, contextRefs: ContextRef[]) => boolean;
  /**
   * Skills RÉELLEMENT découvertes par le sidecar Cline (dossier `.cline/skills`,
   * etc.). Alimente le sous-menu « Skills » du bouton `+` et l'autocomplétion
   * des slash-commands `/skill`. Vide tant qu'aucune session n'a démarré.
   */
  skills?: ClineSkillInfo[];
  /** Slash-commands runtime (`/skill`, `/workflow`) proposées par le SDK. */
  commands?: ClineRuntimeCommand[];
  /**
   * Ouvre le sélecteur de répertoire natif. Appelé quand l'utilisateur tente
   * d'envoyer un message ALORS qu'aucun dossier de travail n'est ouvert :
   * l'agent ne doit jamais démarrer sans workspace.
   */
  onSelectFolder?: () => void;
}

export default function ChatBox({ onSend, getEditorContext, forcedContext, onForcedContextConsumed, isStreaming, onStop, handleRef, queued, onRemoveQueued, onEditQueued, onQueue, skills = [], commands = [], onSelectFolder }: ChatBoxProps) {
  const { folderPath } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const modeAnchorRef = useRef<HTMLDivElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  /** Position du curseur au moment où la requête `#` a été détectée. */
  const hashRangeRef = useRef<Range | null>(null);

  const [isEmpty, setIsEmpty] = useState(true);
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<Mode>(() => readStoredMode());
  const [modeOpen, setModeOpen] = useState(false);
  // Agents personnalisés (persistés globalement) + agent actif dans l'input.
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string | null>(() => readSelectedAgentId());
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => loadPermissionMode());
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  // Menu `#` (context mentions) : menu des types, puis picker ciblé.
  const [hashActive, setHashActive] = useState(false);
  const [hashQuery, setHashQuery] = useState('');
  const [hashMenuOpen, setHashMenuOpen] = useState(false);
  const [contextPicker, setContextPicker] = useState<{ kind: "file" | "folder" | "rule"; query: string } | null>(null);
  const [contextSnap, setContextSnap] = useState<EditorContext | null>(null);
  const [contextDismissed, setContextDismissed] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(
    () => localStorage.getItem("origin-ai-model") ?? DEFAULT_MODEL_ID
  );
  const [selectedProviderId, setSelectedProviderId] = useState(
    () => localStorage.getItem("origin-ai-provider") ?? DEFAULT_PROVIDER_ID
  );

  // Fallback dev : si rien n'est mémorisé, on adopte le provider/modèle du `.env`
  // (lecture asynchrone). Les valeurs du localStorage restent prioritaires.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!localStorage.getItem("origin-ai-provider")) {
        const provider = await resolveDefaultProvider(DEFAULT_PROVIDER_ID);
        if (!cancelled) setSelectedProviderId(provider);
      }
      if (!localStorage.getItem("origin-ai-model")) {
        const model = await resolveDefaultModel(DEFAULT_MODEL_ID);
        if (!cancelled) setSelectedModelId(model);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshContext = useCallback(() => {
    if (!getEditorContext || contextDismissed) return;
    const ctx = getEditorContext();
    setContextSnap(ctx);
  }, [getEditorContext, contextDismissed]);

  // API impérative : « éditer et renvoyer » un message utilisateur place son
  // texte dans l'éditeur. On remplace tout l'HTML (les badges de fichiers, que
  // le texte brut ne peut pas restituer, sont volontairement perdus) et on
  // repositionne le curseur à la fin.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      setText: (text: string) => {
        const el = editableRef.current;
        if (!el) return;
        el.innerHTML = "";
        el.appendChild(document.createTextNode(text));
        setIsEmpty(text.trim() === "");
        setMentionActive(false);
        setMentionQuery("");
        mentionRangeRef.current = null;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = document.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      },
    };
    return () => { handleRef.current = null; };
  }, [handleRef]);

  useEffect(() => {
    if (!forcedContext) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot externally-forced context into local state
    setContextSnap(forcedContext);
    setContextDismissed(false);
    onForcedContextConsumed?.();
  }, [forcedContext]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInput = () => {
    const el = editableRef.current;
    if (!el) return;
    setIsEmpty(el.textContent?.trim() === "" && !el.querySelector('[data-filepath]'));

    // Autocomplétion des slash-commands : on détecte `/foo` en fin de texte
    // (modèle texte simple pour rester compatible avec contentEditable).
    const text = el.textContent ?? "";
    const slashQ = getSlashQuery(text);
    if (slashQ !== null) {
      setSlashActive(true);
      setSlashQuery(slashQ);
      setSlashIndex(0);
      setMentionActive(false);
      setMentionQuery('');
      mentionRangeRef.current = null;
      return;
    }
    if (slashActive) {
      setSlashActive(false);
      setSlashQuery('');
    }

    // Contexte `#` : taper `#` (seul, ou suivi d'une requête) ouvre le menu des
    // types. Priorité après le slash, avant `@` (les deux ne cohabitent pas).
    const hashQ = getHashQuery(text);
    if (hashQ !== null) {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) hashRangeRef.current = sel.getRangeAt(0).cloneRange();
      setHashQuery(hashQ);
      setHashActive(true);
      setHashMenuOpen(true);
      setMentionActive(false);
      setMentionQuery('');
      mentionRangeRef.current = null;
      return;
    }
    if (hashActive) {
      setHashActive(false);
      setHashQuery('');
      setHashMenuOpen(false);
      hashRangeRef.current = null;
    }

    if (folderPath) {
      const query = getMentionQuery(el);
      if (query !== null) {
        // Save range on every keystroke while mention is active
        const sel = document.getSelection();
        if (sel && sel.rangeCount > 0) {
          mentionRangeRef.current = sel.getRangeAt(0).cloneRange();
        }
        setMentionQuery(query);
        setMentionActive(true);
      } else {
        setMentionActive(false);
        setMentionQuery('');
        mentionRangeRef.current = null;
      }
    }
  };

  // Charge les agents personnalisés et suit leurs changements (création dans les
  // Réglages, sélection modifiée ailleurs…). La liste vit dans `~/.mira/agents`.
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void listAgents().then(list => { if (!cancelled) setCustomAgents(list); });
    };
    reload();
    window.addEventListener(CUSTOM_AGENTS_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(CUSTOM_AGENTS_EVENT, reload);
    };
  }, []);

  /** Change le mode et le mémorise (survit à un reload). Efface l'agent actif. */
  const handleModeSelect = useCallback((m: Mode) => {
    setMode(m);
    writeStoredMode(m);
    setSelectedAgentId(null);
    setSelectedAgentIdState(null);
  }, []);

  /** Sélectionne un agent personnalisé (persisté, comme le mode). */
  const handleAgentSelect = useCallback((id: string) => {
    setSelectedAgentId(id);
    setSelectedAgentIdState(id);
    setMode("agent");
    writeStoredMode("agent");
  }, []);

  /** Ouvre les Réglages › Agents pour créer un agent (réutilise l'éditeur existant). */
  const handleCreateAgent = useCallback(() => {
    window.dispatchEvent(new CustomEvent("origin-open-settings", { detail: { section: "agents" } }));
  }, []);

  const handleSend = () => {
    const el = editableRef.current;
    if (!el) return;
    const { displayText, fileMentions } = parseContent(el);
    const contextRefs = readContextBadges(el);
    if (!displayText && fileMentions.length === 0 && contextRefs.length === 0) return;

    // GARDE-FOU WORKSPACE : l'agent a besoin d'un dossier de travail pour lire et
    // écrire. Sans dossier, on n'envoie RIEN et on ouvre le sélecteur natif : le
    // message reste dans l'input, l'utilisateur choisit son répertoire puis
    // renvoie. On couvre ainsi tout l'outil (modes IDE et IA) sans toucher au
    // reste de l'UI.
    if (!folderPath) {
      onSelectFolder?.();
      return;
    }

    // Slash-command pilotée depuis l'input : `/plan …`, `/agent …`, `/ask …`.
    // On change le mode puis on envoie le reste comme texte (le défaut garde
    // le texte complet quand aucune commande n'est reconnue).
    let text = displayText;
    let sendMode = mode;
    const slash = parseSlashCommand(displayText);
    if (slash.command && slash.command.action.kind === "set-mode") {
      sendMode = slash.command.action.mode;
      setMode(sendMode);
      writeStoredMode(sendMode);
      text = slash.rest;
      // Commande seule (ex. `/plan`) : on bascule le mode sans envoyer de message.
      if (!text && fileMentions.length === 0 && contextRefs.length === 0) {
        el.innerHTML = "";
        setIsEmpty(true);
        setMentionActive(false);
        setMentionQuery('');
        mentionRangeRef.current = null;
        return;
      }
    }

    const editorContext = contextDismissed ? null : contextSnap;

    // Un tour est déjà en cours : on met le message en file d'attente au lieu de
    // lancer un nouveau run (le parent l'enverra automatiquement à la fin).
    if (isStreaming && onQueue?.(text, selectedModelId, selectedProviderId, fileMentions, editorContext, sendMode, contextRefs)) {
      el.innerHTML = "";
      setIsEmpty(true);
      setMentionActive(false);
      setMentionQuery('');
      mentionRangeRef.current = null;
      setContextDismissed(false);
      setContextSnap(null);
      return;
    }

    onSend?.(text, selectedModelId, selectedProviderId, fileMentions, editorContext, sendMode, contextRefs);
    el.innerHTML = "";
    setIsEmpty(true);
    setMentionActive(false);
    setMentionQuery('');
    mentionRangeRef.current = null;
    // Reset context for next message
    setContextDismissed(false);
    setContextSnap(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Autocomplétion slash-commands active : on intercepte les flèches, Tab,
    // Enter (sélection) et Échap (dismiss) avant le reste.
    if (slashActive && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applySlashCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashActive(false);
        setSlashQuery("");
        return;
      }
    }

    if (e.key === "Escape" && hashActive) {
      e.stopPropagation();
      setHashActive(false);
      setHashQuery('');
      setHashMenuOpen(false);
      setContextPicker(null);
      hashRangeRef.current = null;
      return;
    }

    if (e.key === "Escape" && mentionActive) {
      e.stopPropagation();
      setMentionActive(false);
      setMentionQuery('');
      mentionRangeRef.current = null;
      return;
    }

    if (e.key === "Backspace") {
      const el = editableRef.current;
      if (el) {
        const sel = document.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (range.collapsed) {
            // Find the node immediately before the cursor
            let prevNode: Node | null = null;
            if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
              prevNode = range.startContainer.previousSibling;
            } else if (range.startContainer === el) {
              prevNode = el.childNodes[range.startOffset - 1] ?? null;
            }
            // Badge de fichier (`@`) ou de contexte (`#`) : les deux se retirent
            // d'un seul coup, comme un jeton indivisible.
            if (prevNode instanceof Element && (prevNode.hasAttribute('data-filepath') || prevNode.hasAttribute('data-context'))) {
              e.preventDefault();
              prevNode.remove();
              handleInput();
              return;
            }
          }
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !mentionActive && !hashActive) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Sélection d'un type dans le menu `#`.
   *
   *   - type ciblé (File, Folder, Rule) → bascule vers le picker correspondant ;
   *   - type atomique (Workspace, Problems) → attache immédiatement, sans second écran ;
   *   - `code` → lit la sélection courante de l'éditeur (aucune cible à choisir).
   */
  const handleContextKindSelect = (kind: ContextKind) => {
    setHashMenuOpen(false);
    if (kind === "file" || kind === "folder" || kind === "rule") {
      setContextPicker({ kind, query: hashQuery });
      return;
    }
    // Types atomiques : réf construit sans cible externe.
    const desc = contextKindDescriptor(kind);
    const label = kind === "workspace"
      ? (folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace")
      : (desc?.label ?? kind);
    const ref: ContextRef = { kind, label };
    attachContextRef(ref);
  };

  /** Insère le badge de contexte dans l'éditeur et réinitialise l'état du `#`. */
  const attachContextRef = (ref: ContextRef) => {
    const el = editableRef.current;
    if (!el) return;
    const saved = hashRangeRef.current;
    if (saved && hashActive) {
      insertContextBadge(el, saved, ref);
    } else {
      appendContextBadge(el, ref);
    }
    handleInput();
    setHashActive(false);
    setHashQuery('');
    setHashMenuOpen(false);
    setContextPicker(null);
    hashRangeRef.current = null;
  };

  const handleMentionSelect = (filepath: string, filename: string) => {
    const el = editableRef.current;
    const savedRange = mentionRangeRef.current;
    if (el && savedRange) {
      insertMentionBadge(el, savedRange, filepath, filename);
      handleInput();
    }
    setMentionActive(false);
    setMentionQuery('');
    mentionRangeRef.current = null;
  };

  /**
   * Insère `/skillName ` en fin d'input quand une skill est choisie depuis le
   * menu `+`. On NE lance PAS l'envoi : l'utilisateur complète son intention
   * (args) avant d'envoyer, conformément au flux `/skill args` du SDK.
   */
  const handleSkillSelect = (name: string) => {
    const el = editableRef.current;
    if (!el) return;
    const prefix = el.textContent && !el.textContent.endsWith(" ") ? " " : "";
    el.textContent = `${el.textContent ?? ""}${prefix}/${name} `;
    // Curseur en fin de contenu.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
    handleInput();
  };

  /**
   * Insère un `/` en fin d'input et ouvre l'autocomplétion des commandes/skills.
   * Déclenché par l'entrée « / for commands & skills » du menu `+` : équivalent
   * à taper `/` au clavier, mais découvrable.
   */
  const handleInsertSlash = () => {
    const el = editableRef.current;
    if (!el) return;
    const prefix = el.textContent && !el.textContent.endsWith(" ") ? " " : "";
    el.textContent = `${el.textContent ?? ""}${prefix}/`;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
    handleInput();
  };

  /**
   * Sélectionne une image via le dialogue natif, la copie dans
   * `<workspace>/.mira/attachments/` (zone dédiée, jamais dans le code de
   * l'utilisateur) puis l'attache au message comme un fichier `@` : le contenu
   * est donc injecté dans le prompt exactement comme une mention de fichier.
   *
   * Sécurité : la copie est confinée au workspace par `copy_path` (garde Rust) ;
   * un nom existant n'est jamais écrasé (suffixe incrémental). En cas d'échec,
   * on n'attache rien — jamais de badge pointant vers un fichier inexistant.
   */
  const handleUploadImage = async () => {
    if (!folderPath) return;
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
      });
      const src = typeof picked === "string" ? picked : null;
      if (!src) return;

      const dir = `${folderPath.replace(/[\\/]+$/, "")}/.mira/attachments`;
      await createDirCmd(dir, { workspaceRoot: folderPath });

      // Nom unique : jamais d'écrasement d'une pièce jointe existante.
      const base = src.split(/[\\/]/).filter(Boolean).pop() ?? "image";
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let filename = base;
      let dest = `${dir}/${filename}`;
      let n = 1;
      while (await pathExists(dest, { workspaceRoot: folderPath })) {
        filename = `${stem}-${n}${ext}`;
        dest = `${dir}/${filename}`;
        n += 1;
      }

      await copyPath(src, dest, { workspaceRoot: folderPath });

      const el = editableRef.current;
      if (el) { appendFileBadge(el, dest, filename); handleInput(); }
    } catch {
      // Échec (dialogue annulé, copie refusée…) : on n'attache rien.
    }
  };

  const activeAgent = AGENTS.find(a => a.id === mode);
  // Un agent personnalisé sélectionné prend le pas sur le libellé du mode.
  const activeCustomAgent = resolveSelectedAgent(customAgents, selectedAgentId);
  const agentLabel = activeCustomAgent?.name ?? activeAgent?.label ?? "Agent";

  // Catalogue fusionné : commandes intégrées (/agent, /plan, /ask, /skill) +
  // commandes RÉELLES du runtime Cline (/skill, /workflow découvertes par le SDK).
  const slashCatalog = useMemo<SlashCommand[]>(
    () => mergeSlashCommands(commands),
    [commands],
  );
  const slashMatches = slashActive ? filterSlashCommands(slashQuery, slashCatalog) : [];

  /** Applique une commande choisie dans l'autocomplétion. */
  const applySlashCommand = useCallback((cmd: SlashCommand) => {
    const el = editableRef.current;
    if (!el) return;
    if (cmd.action.kind === "set-mode") {
      setMode(cmd.action.mode);
      writeStoredMode(cmd.action.mode);
      el.textContent = "";
      setIsEmpty(true);
    } else if (cmd.action.kind === "insert") {
      el.textContent = cmd.action.text;
      setIsEmpty(false);
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.focus();
    }
    setSlashActive(false);
    setSlashQuery("");
    setSlashIndex(0);
  }, []);

  /**
   * Applique une slash-command du catalogue par son nom (entrées « Commands »
   * du menu `+`). Réutilise exactement la même logique que l'autocomplétion
   * (`applySlashCommand`) pour ne pas dupliquer le comportement.
   */
  const handleCommand = (name: string) => {
    const cmd = slashCatalog.find(c => c.name === name);
    if (cmd) applySlashCommand(cmd);
  };

  const showContextBadge = contextSnap && !contextDismissed;
  const activeProvider = PROVIDERS.find(p => p.models.some(m => m.id === selectedModelId));
  const activeModel = activeProvider?.models.find(m => m.id === selectedModelId);
  const modelLabel = activeProvider
    ? `${activeProvider.name}/${activeModel?.name ?? selectedModelId}`
    : (activeModel?.name ?? selectedModelId);

  return (
    <div
      ref={containerRef}
      onFocus={refreshContext}
      style={{
        margin: "10px",
        borderRadius: "8px",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)",
        outline: focused
          ? "1px solid color-mix(in srgb, var(--origin-fg-muted) 50%, transparent)"
          : "1px solid transparent",
        outlineOffset: "2px",
        transition: "outline-color 0.15s ease",
        position: "relative",
      }}
    >
      {/* @ mention dropdown */}
      {mentionActive && folderPath && (
        <MentionDropdown
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={() => { setMentionActive(false); setMentionQuery(''); mentionRangeRef.current = null; }}
        />
      )}

      {/* # context type menu */}
      {hashMenuOpen && (
        <ContextTypeMenu
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          query={hashQuery}
          attachedKinds={
            // eslint-disable-next-line react-hooks/refs -- read currently-attached context badges from the editable DOM
            readContextBadges(editableRef.current as HTMLDivElement).filter(r => !r.path).map(r => r.kind)
          }
          onSelectKind={handleContextKindSelect}
          onClose={() => { setHashMenuOpen(false); setHashActive(false); setHashQuery(''); hashRangeRef.current = null; }}
        />
      )}

      {/* # folder picker */}
      {contextPicker?.kind === "folder" && folderPath && (
        <FolderPicker
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          query={contextPicker.query}
          workspace={folderPath}
          onSelect={(path, label) => attachContextRef({ kind: "folder", path, label })}
          onClose={() => { setContextPicker(null); setHashActive(false); setHashQuery(''); hashRangeRef.current = null; }}
        />
      )}

      {/* # file picker */}
      {contextPicker?.kind === "file" && folderPath && (
        <MentionDropdown
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          query={contextPicker.query}
          onSelect={(filepath, filename) => attachContextRef({ kind: "file", path: filepath, label: filename })}
          onClose={() => { setContextPicker(null); setHashActive(false); setHashQuery(''); hashRangeRef.current = null; }}
        />
      )}

      {/* # rule picker */}
      {contextPicker?.kind === "rule" && (
        <RulePicker
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          workspace={folderPath ?? null}
          onSelect={(ref) => attachContextRef(ref)}
          onClose={() => { setContextPicker(null); setHashActive(false); setHashQuery(''); hashRangeRef.current = null; }}
        />
      )}

      {/* + attach menu */}
      {attachOpen && folderPath && (
        <AttachMenu
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          onAddContext={() => setFilePickerOpen(true)}
          onInsertSlash={handleInsertSlash}
          onCommand={handleCommand}
          onUploadImage={() => void handleUploadImage()}
          onClose={() => setAttachOpen(false)}
          skills={skills}
          onSkill={handleSkillSelect}
        />
      )}

      {/* File picker (Add Context) */}
      {filePickerOpen && folderPath && (
        <MentionDropdown
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          query=""
          keepOpen
          attachedPaths={
            // eslint-disable-next-line react-hooks/refs -- read currently-attached file badges from the editable DOM
            Array.from(editableRef.current?.querySelectorAll('[data-filepath]') ?? [])
              .map(el => (el as HTMLElement).getAttribute('data-filepath')!)
          }
          onSelect={(filepath, filename) => {
            const el = editableRef.current;
            if (el) { appendFileBadge(el, filepath, filename); handleInput(); }
          }}
          onClose={() => setFilePickerOpen(false)}
        />
      )}

      {/* Waiting-to-send banner : message mis en file pendant un tour en cours.
          Il sera envoyé automatiquement dès la fin du tour. Le bandeau est
          explicite (icône horloge) et propose éditer / retirer. */}
      {queued && (
        <div style={{
          margin: "6px 8px 0",
          border: "1px solid var(--origin-border-default)",
          borderRadius: "7px",
          backgroundColor: "var(--origin-bg-panel)",
          overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "5px 8px",
            fontSize: "12px",
            color: "var(--origin-fg-muted)",
            fontFamily: "var(--font-sans)",
          }}>
            <Clock size={11} style={{ flexShrink: 0, color: "var(--origin-fg-subtle)" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {queued.text || (queued.fileMentions?.join(", ") ?? "")}
              {/* Aperçu des contextes `#` en attente : types + labels, discrets. */}
              {(queued.contextRefs?.length ?? 0) > 0 && (
                <span style={{ color: "var(--origin-fg-subtle)" }}>
                  {"  "}
                  {queued.contextRefs!.map(s => `#${s.split(":").slice(1).join(":") || s.split(":")[0]}`).join(" ")}
                </span>
              )}
            </span>
            <button
              onMouseDown={e => { e.preventDefault(); onEditQueued?.(); }}
              title="Edit queued message"
              style={queuedMiniBtn}
            >
              <Pencil size={12} />
            </button>
            <button
              onMouseDown={e => { e.preventDefault(); onRemoveQueued?.(); }}
              title="Remove queued message"
              style={queuedMiniBtn}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "5px 8px",
            borderTop: "1px solid var(--origin-border-default)",
            fontSize: "12px",
            color: "var(--origin-fg-subtle)",
            fontFamily: "var(--font-sans)",
          }}>
            <SquareSlash size={12} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
            Waiting to send...
            <ChevronDown size={12} style={{ marginLeft: "auto", color: "var(--origin-fg-subtle)" }} />
          </div>
        </div>
      )}

      {/* Auto context badge */}
      {showContextBadge && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 10px 4px",
          flexWrap: "wrap",
        }}>
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 6px 2px 5px",
            borderRadius: "5px",
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            background: "var(--origin-bg-active)",
            border: "1px solid var(--origin-border-default)",
            color: "var(--origin-fg-default)",
            maxWidth: "100%",
          }}>
            <FileCode size={11} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {contextSnap!.filename}
            </span>
            <span style={{
              padding: "0 4px",
              borderRadius: "3px",
              fontSize: "10px",
              background: "var(--origin-bg-hover)",
              color: "var(--origin-fg-muted)",
            }}>
              {contextLabel(contextSnap!)}
            </span>
            <button
              onMouseDown={e => {
                e.preventDefault(); // don't steal focus from editable
                setContextDismissed(true);
                setContextSnap(null);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0",
                color: "var(--origin-fg-subtle)",
                lineHeight: 1,
              }}
            >
              <X size={10} />
            </button>
          </div>
        </div>
      )}

      {/* Editable area */}
      <div style={{ position: "relative" }}>
        {/* Slash-command autocomplete — catalogue intégré + commandes runtime */}
        {slashActive && slashMatches.length > 0 && (
          <div style={{
            position: "absolute", left: "8px", right: "8px", bottom: "100%", marginBottom: "4px",
            maxHeight: "260px", overflowY: "auto", zIndex: 40,
            background: "color-mix(in srgb, var(--origin-bg-base) 92%, transparent)", backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)", border: "1px solid var(--origin-border-default)", borderRadius: "8px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.35)", padding: "4px",
          }}>
            {slashMatches.map((cmd, i) => (
              <button key={cmd.name}
                onMouseDown={e => { e.preventDefault(); applySlashCommand(cmd); }}
                onMouseEnter={() => setSlashIndex(i)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px",
                  borderRadius: "6px", border: "none", cursor: "pointer", textAlign: "left",
                  background: i === slashIndex ? "var(--origin-bg-hover)" : "transparent",
                }}>
                <SquareSlash size={13} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
                <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--origin-fg-default)", flexShrink: 0 }}>
                  /{cmd.name}
                </span>
                <span style={{ fontSize: "11px", color: "var(--origin-fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cmd.description}
                </span>
                {cmd.source === "runtime" && (
                  <span style={{ marginLeft: "auto", fontSize: "10px", padding: "0 4px", borderRadius: "3px",
                    background: "var(--origin-bg-active)", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>
                    runtime
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div
          ref={editableRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            minHeight: "70px",
            maxHeight: "200px",
            padding: "8px 10px",
            outline: "none",
            fontSize: "13px",
            color: "var(--origin-fg-default)",
            lineHeight: "1.5",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowY: "auto",
            cursor: "text",
          }}
        />
        {isEmpty && (
          <div
            style={{
              position: "absolute",
              top: "8px",
              left: "10px",
              right: "28px",
              pointerEvents: "none",
              fontSize: "13px",
              color: "var(--origin-fg-subtle)",
              lineHeight: "1.5",
              userSelect: "none",
            }}
          >
            Help you write code, debugs, optimize performance and other development work, deliver production-ready code.
          </div>
        )}
        {/* Sparkles — UI only */}
        <Sparkles
          size={15}
          style={{
            position: "absolute",
            top: "8px",
            right: "10px",
            color: "var(--origin-fg-subtle)",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Bottom toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 8px",
          gap: "8px",
        }}
      >
        {/* Attach / Add context */}
        <button
          ref={plusBtnRef}
          onClick={() => { if (folderPath) setAttachOpen(v => !v); }}
          title="Add context"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: attachOpen ? "var(--origin-bg-active)" : "none",
            border: attachOpen ? "1px solid var(--origin-accent-blue)" : "1px solid transparent",
            cursor: folderPath ? "pointer" : "default",
            padding: "2px 4px",
            borderRadius: "5px",
            color: attachOpen ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
          }}
        >
          <Plus size={15} />
        </button>

        {/* Approval — UI only */}
        <button
          title="Approval mode"
          onClick={() => setApprovalOpen(v => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "3px",
            border: approvalOpen ? "1px solid var(--origin-accent-blue)" : "1px solid transparent",
            background: approvalOpen ? "var(--origin-bg-active)" : "none",
            padding: "2px 4px",
            borderRadius: "5px",
            cursor: "pointer",
            color: approvalOpen ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
          }}
        >
          <Hand size={14} />
          <ChevronDown size={10} style={{ transform: approvalOpen ? "rotate(180deg)" : "none", transition: "transform 0.1s" }} />
        </button>
        {approvalOpen && (
          <ApprovalMenu
            // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
            anchorEl={containerRef.current}
            onClose={() => setApprovalOpen(false)}
            mode={permissionMode}
            onSelect={(m) => { savePermissionMode(m); setPermissionMode(m); }}
          />
        )}

        {/* Agent / mode selector */}
        <div
          ref={modeAnchorRef}
          onClick={() => setModeOpen(v => !v)}
          style={{ display:"flex", alignItems:"center", gap:"4px", fontSize:"12px", fontWeight:500,
            padding:"2px 6px 2px 7px", borderRadius:"9999px", border:"1px solid var(--origin-border-default)",
            backgroundColor: mode !== "agent" ? "var(--origin-bg-active)" : "transparent",
            color: mode !== "agent" ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
            userSelect:"none", cursor:"pointer", transition:"background 0.1s, color 0.1s", maxWidth:"96px" }}>
          <img src={logoCode} alt="" width={13} height={13} style={{ flexShrink: 0, display: "block" }} />
          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{agentLabel}</span>
          <ChevronDown size={10} style={{ flexShrink: 0 }} />
        </div>
        {modeOpen && (
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the anchor button
          <ModeDropdown
            anchorEl={modeAnchorRef.current}
            selected={mode}
            customAgents={customAgents}
            selectedAgentId={selectedAgentId}
            onSelect={handleModeSelect}
            onSelectAgent={handleAgentSelect}
            onCreate={handleCreateAgent}
            onClose={() => setModeOpen(false)}
          />
        )}

        {/* Model selector */}
        <div
          ref={modelAnchorRef}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPrefsOpen(v => !v)}
          style={{ display:"flex", alignItems:"center", gap:"4px", fontSize:"12px", fontWeight:500,
            padding:"2px 6px", borderRadius:"9999px", border:"1px solid var(--origin-border-default)",
            color:"var(--origin-fg-muted)", userSelect:"none", cursor:"pointer",
            transition:"background 0.1s, color 0.1s", maxWidth:"96px", minWidth:0 }}>
          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{modelLabel}</span>
          <ChevronDown size={10} style={{ flexShrink: 0 }} />
        </div>

        <div style={{ flex: 1 }} />

        {/* Mic — UI only */}
        <button
          title="Voice input"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            color: "var(--origin-fg-muted)",
          }}
        >
          <Mic size={15} />
        </button>

        <button
          onClick={isStreaming ? onStop : handleSend}
          title={isStreaming ? "Stop generating" : !folderPath ? "Select a working directory to start" : "Send"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "26px",
            height: "26px",
            borderRadius: "7px",
            border: "none",
            cursor: "pointer",
            backgroundColor: isStreaming ? "var(--origin-bg-active)" : "var(--origin-accent-blue)",
            // Sans dossier : le bouton reste cliquable (le clic ouvre le sélecteur
            // de répertoire) mais s'estompe pour signaler que l'agent ne partira
            // pas tant qu'aucun workspace n'est choisi.
            opacity: !folderPath && !isStreaming ? 0.5 : 1,
            color: isStreaming ? "var(--origin-fg-default)" : "#fff",
          }}
        >
          {isStreaming
            ? <Square size={12} fill="currentColor" />
            : <ArrowUp size={15} />}
        </button>
      </div>

      {prefsOpen && (
        <PreferencesDropdown
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the anchor button
          anchorEl={modelAnchorRef.current}
          selectedModelId={selectedModelId}
          onSelect={(providerId, modelId) => {
            setSelectedModelId(modelId);
            setSelectedProviderId(providerId);
            localStorage.setItem("origin-ai-model", modelId);
            localStorage.setItem("origin-ai-provider", providerId);
          }}
          onClose={() => setPrefsOpen(false)}
        />
      )}
    </div>
  );
}
