import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, ArrowUp, ChevronDown, ChevronRight, Bot, MessageCircle, MessageSquare, Map, FileCode, X, Sparkles, Hand, Mic, Hash, SquareSlash, Image as ImageIcon, Wand2, BookOpen, NotebookTabs, Waypoints, Target, Square, Clock, Pencil, Trash2 } from "lucide-react";
import PreferencesDropdown from "./PreferencesDropdown";
import MentionDropdown from "./MentionDropdown";
import { PROVIDERS, DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./providers";
import type { EditorContext } from "../editor/Editor";
import { useWorkspace } from "../../context/WorkspaceContext";
import { resolveDefaultModel, resolveDefaultProvider } from "../../lib/secrets";
import { loadPermissionMode, savePermissionMode, type PermissionMode } from "../../lib/agent/permissions";
import {
  AGENTS as AGENT_DESCRIPTORS,
  type Mode,
  type AgentIcon,
  readStoredMode,
  writeStoredMode,
  parseSlashCommand,
} from "../../lib/inputCommands";

// ── Agent selector ────────────────────────────────────────────────────────────

/** Mappe le libellé d'icône du module vers un composant lucide. */
const AGENT_ICONS: Record<AgentIcon, typeof Bot> = {
  chat: MessageSquare,
  agent: Bot,
  plan: Waypoints,
};

/** Agents affichés dans le menu : identifiants + libellés viennent du module. */
const AGENTS = AGENT_DESCRIPTORS.map(a => ({ ...a, Icon: AGENT_ICONS[a.icon] }));

function ModeDropdown({ anchorEl, selected, onSelect, onClose }: {
  anchorEl: HTMLElement | null; selected: Mode; onSelect: (m: Mode) => void; onClose: () => void;
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
      boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px", zIndex:9999 }}>
      <div style={{ padding:"6px 8px 6px", fontSize:"12px", color:"var(--origin-fg-muted)" }}>Built-In Agents</div>
      {AGENTS.map(({ id, label, Icon }) => {
        const isSelected = selected === id; const isHovered = hovered === id;
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
      <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
      <button onMouseEnter={() => setHovered("create")} onMouseLeave={() => setHovered(null)}
        onClick={onClose}
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

const COMMAND_ITEMS = [
  { id: "spec", label: "Spec", Icon: NotebookTabs },
  { id: "plan", label: "Plan", Icon: Waypoints },
  { id: "goal", label: "Goal", Icon: Target },
];

function AttachMenu({ anchorEl, onAddContext, onClose }: {
  anchorEl: HTMLElement | null; onAddContext: () => void; onClose: () => void;
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
      <button style={rowStyle("cmd")} onMouseEnter={() => setHovered("cmd")} onMouseLeave={() => setHovered(null)} onClick={onClose}>
        <span style={iconStyle}><SquareSlash size={15} /></span>/ for commands &amp; skills
      </button>
      <button style={rowStyle("img")} onMouseEnter={() => setHovered("img")} onMouseLeave={() => setHovered(null)} onClick={onClose}>
        <span style={iconStyle}><ImageIcon size={15} /></span>Upload image
      </button>
      <div style={{ margin:"6px 4px", height:1, background:"var(--origin-border-default)" }} />
      <div style={{ position:"relative" }}
        onMouseEnter={() => setHovered("cmds")} onMouseLeave={() => setHovered(null)}>
        <button style={rowStyle("cmds")} onClick={onClose}>
          <span style={iconStyle}><Wand2 size={15} /></span>
          <span style={{ flex:1 }}>Commands</span>
          <ChevronRight size={14} style={{ color:"var(--origin-fg-subtle)", flexShrink:0 }} />
        </button>
        {hovered === "cmds" && (
          <div style={{ position:"absolute", right:"100%", top:0, minWidth:"150px",
            background:"color-mix(in srgb, var(--origin-bg-base) 90%, transparent)", backdropFilter:"blur(16px)",
            WebkitBackdropFilter:"blur(16px)", border:"1px solid var(--origin-border-default)", borderRadius:"10px",
            boxShadow:"0 8px 32px rgba(0,0,0,0.35)", padding:"6px" }}>
            {COMMAND_ITEMS.map(({ id, label, Icon }) => (
              <button key={id} onClick={onClose}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                style={{ width:"100%", display:"flex", alignItems:"center", gap:"10px", padding:"8px 10px",
                  borderRadius:"7px", border:"none", cursor:"pointer", background:"transparent",
                  textAlign:"left", fontSize:"13px", color:"var(--origin-fg-default)" }}>
                <span style={iconStyle}><Icon size={15} /></span>{label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button style={rowStyle("skills")} onMouseEnter={() => setHovered("skills")} onMouseLeave={() => setHovered(null)} onClick={onClose}>
        <span style={iconStyle}><BookOpen size={15} /></span>
        <span style={{ flex:1 }}>Skills</span>
        <ChevronRight size={14} style={{ color:"var(--origin-fg-subtle)", flexShrink:0 }} />
      </button>
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
  onSend?: (text: string, modelId: string, providerId: string, fileMentions: string[], editorContext: EditorContext | null, mode: Mode) => void;
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
  queued?: { text: string; fileMentions?: string[] } | null;
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
  onQueue?: (text: string, modelId: string, providerId: string, fileMentions: string[], editorContext: EditorContext | null, mode: Mode) => boolean;
}

export default function ChatBox({ onSend, getEditorContext, forcedContext, onForcedContextConsumed, isStreaming, onStop, handleRef, queued, onRemoveQueued, onEditQueued, onQueue }: ChatBoxProps) {
  const { folderPath } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const modeAnchorRef = useRef<HTMLDivElement>(null);
  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const mentionRangeRef = useRef<Range | null>(null);

  const [isEmpty, setIsEmpty] = useState(true);
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<Mode>(() => readStoredMode());
  const [modeOpen, setModeOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => loadPermissionMode());
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
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

  /** Change le mode et le mémorise (survit à un reload). */
  const handleModeSelect = useCallback((m: Mode) => {
    setMode(m);
    writeStoredMode(m);
  }, []);

  const handleSend = () => {
    const el = editableRef.current;
    if (!el) return;
    const { displayText, fileMentions } = parseContent(el);
    if (!displayText && fileMentions.length === 0) return;

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
      if (!text && fileMentions.length === 0) {
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
    if (isStreaming && onQueue?.(text, selectedModelId, selectedProviderId, fileMentions, editorContext, sendMode)) {
      el.innerHTML = "";
      setIsEmpty(true);
      setMentionActive(false);
      setMentionQuery('');
      mentionRangeRef.current = null;
      setContextDismissed(false);
      setContextSnap(null);
      return;
    }

    onSend?.(text, selectedModelId, selectedProviderId, fileMentions, editorContext, sendMode);
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
            if (prevNode instanceof Element && prevNode.hasAttribute('data-filepath')) {
              e.preventDefault();
              prevNode.remove();
              handleInput();
              return;
            }
          }
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !mentionActive) {
      e.preventDefault();
      handleSend();
    }
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

  const agentLabel = AGENTS.find(a => a.id === mode)?.label ?? "Agent";
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

      {/* + attach menu */}
      {attachOpen && folderPath && (
        <AttachMenu
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the container
          anchorEl={containerRef.current}
          onAddContext={() => setFilePickerOpen(true)}
          onClose={() => setAttachOpen(false)}
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
          <span style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }}>@</span>
          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{agentLabel}</span>
          <ChevronDown size={10} style={{ flexShrink: 0 }} />
        </div>
        {modeOpen && (
          // eslint-disable-next-line react-hooks/refs -- anchorEl portal pattern: positions dropdown relative to the anchor button
          <ModeDropdown anchorEl={modeAnchorRef.current} selected={mode} onSelect={handleModeSelect} onClose={() => setModeOpen(false)} />
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
          title={isStreaming ? "Stop generating" : "Send"}
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
