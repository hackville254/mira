import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { Tooltip } from "../ui/Tooltip";
import { useToast } from "../ui/Toast";
import ChatBox, { type ChatBoxHandle } from "./ChatBox";
import MessageBubble from "./MessageBubble";
import TurnCheckpointCard from "./TurnCheckpointCard";
import PinnedTodoList from "./PinnedTodoList";
import {
  beginTurnCheckpoint, touchTurnFile, undoTurnCheckpoint, discardTurnCheckpoint,
  summaryTurnCheckpoint, fileBeforeTurnCheckpoint, type TurnFileDelta,
} from "../../lib/turnCheckpoint";
import MarkdownMessage from "./MarkdownMessage";
import { PROVIDERS } from "./providers";
import logoCode from "../../assets/logo-code.svg";
import {
  DEFAULT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT_LITE,
  DEFAULT_ASK_PROMPT,    DEFAULT_ASK_PROMPT_LITE,
  DEFAULT_PLAN_PROMPT,   DEFAULT_PLAN_PROMPT_LITE,
  STYLE_GUARDRAIL,
  type UsageData,
} from "../../lib/ai";
import { ensurePricing, computeCost } from "../../lib/pricing";
import { recordUsage } from "../../lib/usage";
import { loadApiKey } from "../../lib/secrets";
import { readFile } from "../../lib/fs";
import { buildLanguageModel } from "../../lib/agent/providers";
import { createTools, createReadOnlyTools, createAskTools } from "../../lib/agent/tools";
import { runAgent, type AgentEvent } from "../../lib/agent/run";
import { spawnAgentTool, wrapSpawnAgent } from "../../lib/agent/spawnRuntime";
import { resetProjectContext } from "../../lib/agent/projectContext";
import { startSubAgent, stepSubAgent, endSubAgent, clearSubAgents } from "../../lib/agent/swarmStore";
import { getTodos } from "../../lib/agent/todoStore";
import { decideApproval, loadPermissionMode, type PermissionMode } from "../../lib/agent/permissions";
import { shouldPreCompact, estimateTokensWithOverhead, DEFAULT_TOKEN_BUDGET } from "../../lib/agent/tokenBudget";
import { compactHistory } from "../../lib/agent/compactHistory";
import { parsePlan } from "../../lib/agent/planTypes";
import type { ModelMessage } from "ai";
import {
  createSession,
  touchSession,
  insertMessage,
  updateMessageContent,
  deleteMessagesByIds,
  deleteSession,
  type DbSession,
} from "../../lib/db";
import type { EditorContext } from "../editor/Editor";
import { useWorkspace } from "../../context/WorkspaceContext";
import {
  type DisplayMessage, type MessagePart, type PinnedMessage, type ToolCallDisplay, type SubAgentChild,
  appendText, appendReasoning, updateTcInParts,
} from "../../lib/aiTypes";
import {
  activeSessionKey, lsForPath, lsPush, lsTouch, lsDelete,
  restoreSession,
} from "../../lib/sessionStore";
import { pbRead, pbWrite, pinPreview, NOTES_KEY } from "../../lib/pinboardStore";

// ── Sub-components ─────────────────────────────────────────────────────────────

function HeaderBtn({ label, active, onClick, onMouseEnter, onMouseLeave, children }: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center rounded"
      style={{
        width: 26, height: 26, background: "none", border: "none", cursor: "pointer",
        color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = "var(--origin-fg-default)";
        e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
        onMouseEnter?.(e);
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)";
        e.currentTarget.style.backgroundColor = "transparent";
        onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
}

function ConfirmDialog({
  title, message, confirmLabel = "Delete", onConfirm, onCancel,
}: {
  title: string; message: string; confirmLabel?: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 340, borderRadius: "10px",
          border: "1px solid var(--origin-border-default)",
          backgroundColor: "var(--origin-bg-sidebar)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)", overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 0" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: "6px" }}>
            {title}
          </div>
          <div style={{ fontSize: "13px", color: "var(--origin-fg-muted)", lineHeight: 1.55 }}>
            {message}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", padding: "18px 20px" }}>
          <button
            onClick={onCancel} autoFocus
            style={{
              padding: "6px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: 500, cursor: "pointer",
              background: "var(--origin-bg-active)", border: "1px solid var(--origin-border-default)",
              color: "var(--origin-fg-default)",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--origin-bg-active)"; }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            style={{
              padding: "6px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: 500, cursor: "pointer",
              background: "var(--origin-semantic-error)", border: "1px solid transparent", color: "#fff",
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = "0.85"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PinLabelPopover({ onConfirm, onCancel }: {
  onConfirm: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 320, borderRadius: "10px", border: "1px solid var(--origin-border-default)", backgroundColor: "var(--origin-bg-sidebar)", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", padding: "20px" }}
      >
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: "4px" }}>Pin message</div>
        <div style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "14px" }}>
          Add a label to find it quickly. Leave blank to use a content preview.
        </div>
        <input
          ref={inputRef}
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onConfirm(label.trim()); } }}
          placeholder="e.g. auth fix, regex approach…"
          style={{
            width: "100%", boxSizing: "border-box",
            background: "var(--origin-bg-base)", border: "1px solid var(--origin-border-default)",
            borderRadius: "6px", padding: "7px 10px", fontSize: "13px",
            color: "var(--origin-fg-default)", outline: "none", fontFamily: "var(--font-sans)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
          <button
            onClick={onCancel}
            style={{ padding: "6px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: 500, cursor: "pointer", background: "var(--origin-bg-active)", border: "1px solid var(--origin-border-default)", color: "var(--origin-fg-default)" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--origin-bg-active)"; }}
          >Cancel</button>
          <button
            onClick={() => onConfirm(label.trim())}
            style={{ padding: "6px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: 500, cursor: "pointer", background: "var(--origin-fg-default)", border: "1px solid transparent", color: "var(--origin-bg-base)" }}
          >Pin</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RecentSessions({ sessions, onSelect, onShowAll }: {
  sessions: DbSession[]; onSelect: (id: string) => void; onShowAll?: () => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--origin-border-default)" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "6px" }}>
        <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--origin-fg-subtle)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Recent
        </span>
        {sessions.length > 5 && (
          <button onClick={onShowAll} style={{ marginLeft: "auto", fontSize: "11px", color: "var(--origin-fg-muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            Show all
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        {sessions.slice(0, 5).map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: "flex", alignItems: "center", width: "100%",
              padding: "7px 8px", borderRadius: "6px",
              background: "none", border: "none", cursor: "pointer", gap: "8px",
            }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <span style={{ flex: 1, fontSize: "12px", color: "var(--origin-fg-default)", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.title}
            </span>
            <Icon icon="lucide:chevron-right" width={13} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours   = Math.floor(diff / 3600000);
  const days    = Math.floor(diff / 86400000);
  if (minutes < 1)  return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24)   return `${hours}h ago`;
  if (days < 7)     return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildContextPrefix(ctx: EditorContext, displayPath?: string): string {
  const ext = ctx.filename.split(".").pop()?.toLowerCase() ?? "";
  const fenceMap: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", rs: "rs",
    py: "python", css: "css", html: "html", json: "json", md: "markdown",
  };
  const fence = fenceMap[ext] ?? ext;
  const label = ctx.type === "selection" ? "Selected code" : "Visible code";
  return `[${label} in ${displayPath ?? ctx.filename}]\n\`\`\`${fence}\n${ctx.code}\n\`\`\`\n\n`;
}

function toWorkspaceRelPath(fullPath: string, folderPath: string): string {
  const fpNorm = folderPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const spNorm = fullPath.replace(/\\/g, "/");
  return spNorm.startsWith(fpNorm) ? spNorm.slice(fpNorm.length) : spNorm.split("/").pop() ?? fullPath;
}


// ── Panel constants ────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 520;
const MIN_WIDTH    = 520;
const MAX_WIDTH    = 900;
// Agent mode: the surface is slimmer because the task rail + tool panels live beside it.
const AGENT_DEFAULT_WIDTH = 380;
const AGENT_MIN_WIDTH     = 380;
const AGENT_MAX_WIDTH     = 520;
const CTX_MIN     = 160;
const CTX_MAX     = 480;
const CTX_DEFAULT = 200;
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "vllm"]);

// Marge de tokens réservée au tour suivant (réponse modèle + tool results) pour
// l'estimation d'usage projeté en fin de tour. ~16k tokens ≈ un tour d'agent
// moyen. Sert uniquement à décider d'une pré-compaction réactive (cf. Trae).
const NEXT_TURN_MARGIN_TOKENS = 16_000;

// ── AiPanel ────────────────────────────────────────────────────────────────────

export interface AiDiffTabInput {
  approvalId: string;
  filePath: string;
  proposedContent: string;
  originalContent: string;
  approve: () => void;
  reject: () => void;
}

interface AiPanelProps {
  getEditorContext?: () => EditorContext | null;
  getActiveFilePath?: () => string | null;
  forcedContext?: EditorContext | null;
  onForcedContextConsumed?: () => void;
  onApplyCode?: (code: string, filePath?: string, ctx?: EditorContext) => void;
  getOpenTabPaths?: () => string[];
  getFileContents?: () => Record<string, string>;
  onOpenDiffTab?: (data: AiDiffTabInput) => void;
  /** Ouvre un fichier du workspace dans l'éditeur (clic sur un chemin dans le chat). */
  onOpenFile?: (path: string, line?: number, col?: number) => void;
  /** When set (and changed), the panel loads the given session id. Driven by the Agent mode task rail. */
  openSessionId?: string | null;
  /** Incrementing counter that triggers a fresh chat (Agent mode "New Task"). */
  newChatNonce?: number;
  /** Notifies the host when the active session changes (created, selected, cleared). */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /** 'sidebar' (IDE right panel) or 'agent' (full Agent mode surface, no resize handle). */
  renderMode?: "sidebar" | "agent";
}

function buildModelHistory(messages: DisplayMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (m.content.trim()) result.push({ role: "user", content: m.content });
      continue;
    }
    // assistant
    if (!m.parts || m.parts.length === 0) {
      if (m.content.trim()) result.push({ role: "assistant", content: m.content });
      continue;
    }
    const assistantContent: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
    const toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }> = [];
    for (const part of m.parts) {
      if (part.type === "text") {
        if (part.content.trim()) assistantContent.push({ type: "text", text: part.content });
      } else if (part.type === "tool-call") {
        assistantContent.push({ type: "tool-call", toolCallId: part.tc.id, toolName: part.tc.toolName, input: part.tc.args ?? {} });
        if (part.tc.result !== undefined) {
          const value = typeof part.tc.result === "string" ? part.tc.result : JSON.stringify(part.tc.result);
          toolResults.push({ type: "tool-result", toolCallId: part.tc.id, toolName: part.tc.toolName, output: { type: "text", value } });
        }
      }
      // plan-card parts are UI-only — no model representation
    }
    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent } as ModelMessage);
    } else if (m.content.trim()) {
      result.push({ role: "assistant", content: m.content });
    }
    if (toolResults.length > 0) {
      result.push({ role: "tool", content: toolResults } as ModelMessage);
    }
  }
  return result;
}

export default function AiPanel({
  getEditorContext, getActiveFilePath, forcedContext, onForcedContextConsumed,
  onApplyCode, getOpenTabPaths, getFileContents, onOpenDiffTab, onOpenFile,
  openSessionId = null,
  newChatNonce = 0,
  onActiveSessionChange,
  renderMode = "sidebar",
}: AiPanelProps) {
  const { folderPath } = useWorkspace();
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  useEffect(() => { onActiveSessionChangeRef.current = onActiveSessionChange; }, [onActiveSessionChange]);

  const isAgent = renderMode === "agent";
  const effMin = isAgent ? AGENT_MIN_WIDTH : MIN_WIDTH;
  const effMax = isAgent ? AGENT_MAX_WIDTH : MAX_WIDTH;
  const effDefault = isAgent ? AGENT_DEFAULT_WIDTH : DEFAULT_WIDTH;
  const [width, setWidth] = useState(() => {
    const n = parseInt(localStorage.getItem("origin-ai-panel-width") ?? "", 10);
    return isNaN(n) ? effDefault : Math.min(effMax, Math.max(effMin, n));
  });
  const [contextOpen, setContextOpen] = useState(false);
  const [chatView, setChatView] = useState<"new" | "chat" | "history">(() => {
    const stored = localStorage.getItem("origin-ai-chat-view");
    return (stored === "new" || stored === "chat") ? stored : "new";
  });
  const [contextWidth, setContextWidth] = useState(() => {
    const n = parseInt(localStorage.getItem("origin-ai-ctx-width") ?? "", 10);
    return isNaN(n) ? CTX_DEFAULT : Math.min(CTX_MAX, Math.max(CTX_MIN, n));
  });

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  // Un tour est en cours dès qu'un message assistant est encore marqué streaming.
  const isStreaming = messages.length > 0 && !!messages[messages.length - 1].streaming;
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const { showToast } = useToast();
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);

  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>(() => pbRead(folderPath ?? ""));
  const [notesValue, setNotesValue] = useState(() => localStorage.getItem(NOTES_KEY(folderPath ?? "")) ?? "");
  const [pendingScrollIndex, setPendingScrollIndex] = useState<number | null>(null);
  const pendingScrollContentRef = useRef<string | null>(null);
  const [pendingPin, setPendingPin] = useState<{ content: string; sessionId?: string } | null>(null);
  const [expandedPins, setExpandedPins] = useState<Set<string>>(new Set());
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());

  const messagesRef        = useRef<DisplayMessage[]>([]);
  const streamCleanupRef   = useRef<(() => void) | null>(null);
  const messagesEndRef     = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Vrai tant que l'utilisateur est « collé » en bas du fil. Mis à false dès qu'il
  // remonte pour lire : on cesse alors de forcer le défilement (sinon le fil
  // « arrache » la lecture pendant le streaming). Un bouton « Descendre » apparaît.
  const stickToBottomRef   = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Références vers l'éditeur du ChatBox (clavier « éditer et renvoyer »).
  const chatBoxRef         = useRef<ChatBoxHandle | null>(null);
  // Ids DB des messages affichés, alignés par index avec `messages`. Alimentés au
  // chargement d'une session ET au fil de la conversation (cf. handleSend), ce
  // qui rend le glissement d'index fiable en usage courant.
  const dbIdsRef           = useRef<(string | null)[]>([]);

  const folderPathRef              = useRef<string | null | undefined>(folderPath);
  const originMdRef                = useRef<string>("");
  const isFirstFolderEffect        = useRef(true);
  const activeSessionIdRef         = useRef<string | null>(null);
  const pendingAssistantDbIdRef    = useRef<string | null>(null);
  const pendingContentRef          = useRef<string>("");
  const pendingPartsRef            = useRef<MessagePart[]>([]);
  const flushTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getActiveFilePathRef       = useRef(getActiveFilePath);
  const onApplyCodeRef             = useRef(onApplyCode);
  const onOpenDiffTabRef           = useRef(onOpenDiffTab);
  const currentModeRef             = useRef<"agent" | "plan">("agent");
  // Modèle/provider du dernier envoi : « régénérer » rejoue avec la même cible
  // sans dépendre d'un état local exposé par le ChatBox.
  const activeModelIdRef           = useRef<string>("");
  const activeProviderIdRef        = useRef<string>("");
  const phase1ContentRef           = useRef<string>("");
  const startPlanExecutionRef      = useRef<(() => Promise<void>) | null>(null);

  // Checkpoint du tour courant : id + fichiers capturés (pour la bannière Undo/Keep).
  const activeTurnIdRef            = useRef<string | null>(null);
  const streamDirtyRef             = useRef<boolean>(false);
  const [checkpointBanner, setCheckpointBanner] = useState<{ turnId: string; files: TurnFileDelta[] } | null>(null);

  // Miroir réactif de `activeSessionIdRef` : le rendu (todo list épinglée) a
  // besoin de la session courante comme état, pas comme ref.
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const setActiveSessionId = useCallback((id: string | null) => {
    activeSessionIdRef.current = id;
    setActiveSessionIdState(id);
  }, []);

  // Télémétrie du tour : nb de compactions / reprises automatiques, et dernier
  // gain de tokens obtenu par compaction. Affichée en pied de fil.
  const [telemetry, setTelemetry] = useState<{ compaction: number; retry: number; lastSavedTokens?: number }>(
    { compaction: 0, retry: 0 },
  );
  // Vote (pouce haut/bas) par index de message. Éphémère — il vit le temps de la
  // session et ne prétend pas persister un feedback durable (pas de télémétrie
  // sortante). Il sert d'indicateur visuel immédiat.
  const [feedbackByIndex, setFeedbackByIndex] = useState<Record<number, "up" | "down">>({});
  // `setTelemetry` (useState) est stable : on le garde en ref pour que les
  // closures de `handleSend` (mémorisées) y accèdent sans dépendre de lui.
  const setTelemetryRef = useRef(setTelemetry);

  // Usage du contexte courant : estimation (chars/4 + overhead) de l'historique
  // modèle. Recalculée à chaque changement de messages ; pilotée par la même
  // métrique que la compaction, elle sert d'indicateur visuel en pied de fil.
  const contextTokens = useMemo(
    () => estimateTokensWithOverhead(buildModelHistory(messages.filter(m => !m.streaming))),
    [messages],
  );

  // Ouvre un checkpoint pour un nouveau tour d'agent. Best-effort : l'échec
  // n'empêche jamais le tour de se dérouler (le mode Ask n'écrit rien sur disque).
  // Un nouveau tour implique « Keep all » implicite du tour précédent : on purge
  // l'ancien checkpoint pour ne pas accumuler de snapshots orphelins sur disque.
  const beginTurn = useCallback(() => {
    const prev = activeTurnIdRef.current;
    if (prev) discardTurnCheckpoint(prev).catch(() => {});
    setCheckpointBanner(null);
    const id = crypto.randomUUID();
    activeTurnIdRef.current = id;
    streamDirtyRef.current = false;
    void beginTurnCheckpoint(id).catch(() => {});
  }, []);

  // Snapshot d'un fichier avant sa première écriture du tour (idempotent).
  const touchTurn = useCallback((path: string, ws: string) => {
    const id = activeTurnIdRef.current;
    if (!id) return;
    void touchTurnFile(id, path, ws).catch(() => {});
  }, []);

  useEffect(() => { ensurePricing().catch(() => {}); }, []);
  useEffect(() => { folderPathRef.current = folderPath; }, [folderPath]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { getActiveFilePathRef.current = getActiveFilePath; }, [getActiveFilePath]);
  useEffect(() => { onApplyCodeRef.current = onApplyCode; }, [onApplyCode]);
  useEffect(() => { onOpenDiffTabRef.current = onOpenDiffTab; }, [onOpenDiffTab]);

  useEffect(() => {
    const fp = folderPath ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load persisted state for the current folder
    setPinnedMessages(pbRead(fp));
    setNotesValue(localStorage.getItem(NOTES_KEY(fp)) ?? "");
  }, [folderPath]);

  useEffect(() => {
    if (!folderPath) { originMdRef.current = ""; return; }
    const sep = folderPath.includes("\\") ? "\\" : "/";
    readFile(`${folderPath}${sep}ORIGIN.md`)
      .then(content => { originMdRef.current = content.trim(); })
      .catch(() => { originMdRef.current = ""; });
  }, [folderPath]);

  useEffect(() => {
    if (pendingScrollIndex === null || chatView !== "chat") return;
    const timer = setTimeout(() => {
      messageRefsMap.current.get(pendingScrollIndex)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setPendingScrollIndex(null);
    }, 80);
    return () => clearTimeout(timer);
  }, [pendingScrollIndex, chatView]);

  useEffect(() => {
    if (chatView === "chat" && stickToBottomRef.current) { messagesEndRef.current?.scrollIntoView(); }
  }, [messages, chatView]);

  // Détecte si l'utilisateur est proche du bas (tolérance ~80 px). Au-delà, on
  // cesse de coller au bas et on affiche le bouton « Descendre ».
  const handleThreadScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpToBottom(prev => (prev === !atBottom ? prev : !atBottom));
  }, []);

  const jumpToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    const fp = folderPath ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load persisted sessions for the current folder
    setSessions(lsForPath(fp));

    if (!isFirstFolderEffect.current) {
      // Project switched — cancel any in-flight stream and reset to new chat
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      const prevDbId = pendingAssistantDbIdRef.current;
      if (prevDbId) {
        pendingAssistantDbIdRef.current = null;
        updateMessageContent(prevDbId, pendingContentRef.current, "interrupted").catch(() => {});
      }
      setMessages([]);
      setActiveSessionId(null);
      onActiveSessionChangeRef.current?.(null);
      setChatView("new");
      localStorage.setItem("origin-ai-chat-view", "new");
    }
    isFirstFolderEffect.current = false;

    let cancelled = false;
    const storedId = localStorage.getItem(activeSessionKey(fp));
    if (storedId) {
      (async () => {
        try {
          if (cancelled) return;
          const displayMsgs = await restoreSession(storedId);
          if (cancelled) return;
          if (displayMsgs.length > 0) {
            dbIdsRef.current = displayMsgs.map(m => m.dbId ?? null);
            setMessages(displayMsgs);
            setActiveSessionId(storedId);
            setChatView("chat");
            localStorage.setItem("origin-ai-chat-view", "chat");
          }
        } catch (err) {
          console.error("[AiPanel] DB session restore failed:", err);
        }
      })();
    }
    return () => { cancelled = true; };
  }, [folderPath, setActiveSessionId]);

  const handleSessionSelect = useCallback(async (sessionId: string) => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;

    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const prevDbId = pendingAssistantDbIdRef.current;
    if (prevDbId) {
      pendingAssistantDbIdRef.current = null;
      updateMessageContent(prevDbId, pendingContentRef.current, "interrupted").catch(() => {});
    }

    setActiveSessionId(sessionId);
    const fp = folderPathRef.current ?? "";
    localStorage.setItem(activeSessionKey(fp), sessionId);
    onActiveSessionChangeRef.current?.(sessionId);
    setMessages([]);
    setChatView("chat");
    localStorage.setItem("origin-ai-chat-view", "chat");

    try {
      const displayMsgs = await restoreSession(sessionId);
      dbIdsRef.current = displayMsgs.map(m => m.dbId ?? null);
      setMessages(displayMsgs);
      const scrollContent = pendingScrollContentRef.current;
      if (scrollContent) {
        pendingScrollContentRef.current = null;
        const idx = displayMsgs.findIndex(m => m.content === scrollContent);
        if (idx !== -1) setPendingScrollIndex(idx);
      }
    } catch (err) {
      console.error("[AiPanel] Failed to load session messages:", err);
    }
  }, [setActiveSessionId]);

  const handleSend = useCallback(async (
    text: string,
    modelId: string,
    providerId: string,
    fileMentions: string[] = [],
    editorContext: EditorContext | null = null,
    mode: "agent" | "ask" | "plan" = "agent",
  ) => {
    streamCleanupRef.current?.();

    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const prevDbId = pendingAssistantDbIdRef.current;
    if (prevDbId) {
      pendingAssistantDbIdRef.current = null;
      updateMessageContent(prevDbId, pendingContentRef.current, "interrupted").catch(() => {});
    }
    pendingContentRef.current = "";
    pendingPartsRef.current = [];

    // Mémorise la cible du tour pour permettre une régénération ultérieure.
    activeModelIdRef.current = modelId;
    activeProviderIdRef.current = providerId;

    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    const fp = folderPathRef.current ?? "";
    const sourceFilePath = fileMentions.length === 1
      ? fileMentions[0]
      : (getActiveFilePathRef.current?.() ?? undefined);

    const apiKey = await loadApiKey(provider.id);
    if (!apiKey && !LOCAL_PROVIDERS.has(provider.id)) {
      setMessages(prev => [
        ...prev,
        { role: "user" as const, content: text, sourceFilePath, fileMentions: fileMentions.length > 0 ? fileMentions : undefined, editorContext: editorContext ?? undefined },
        { role: "assistant" as const, content: "No API key found for this provider. Please add your API key in Settings → Connect AI.", streaming: false },
      ]);
      setChatView("chat");
      localStorage.setItem("origin-ai-chat-view", "chat");
      return;
    }

    // ── Session bookkeeping ──────────────────────────────────────────────────
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      setActiveSessionId(sessionId);
      localStorage.setItem(activeSessionKey(fp), sessionId);
      onActiveSessionChangeRef.current?.(sessionId);
      lsPush({ id: sessionId, title: text, workspace_path: fp, updated_at: Date.now() });
      createSession(fp, text, modelId, providerId, sessionId)
        .catch(err => console.error("[AiPanel] DB createSession failed:", err));
    } else {
      lsTouch(sessionId);
      touchSession(sessionId, modelId, providerId)
        .catch(err => console.error("[AiPanel] DB touchSession failed:", err));
    }

    // ── DB: persist user message ─────────────────────────────────────────────
    // On mémorise les ids DB au fur et à mesure : `dbIdsRef` reste aligné sur
    // `messages` (user puis assistant), ce qui permet d'éditer/régénérer en
    // supprimant les messages postérieurs. Un id reste `null` si la persistance
    // a échoué pour cette ligne.
    if (sessionId) {
      try {
        const uid = await insertMessage({
          sessionId,
          messageType: "user",
          content: text,
          attachmentsJson: fileMentions.length > 0 ? JSON.stringify(fileMentions) : null,
          editorContextJson: editorContext
            ? JSON.stringify({ filename: editorContext.filename, startLine: editorContext.startLine, endLine: editorContext.endLine, type: editorContext.type })
            : null,
        });
        dbIdsRef.current.push(uid);
      } catch (err) {
        dbIdsRef.current.push(null);
        console.error("[AiPanel] Failed to persist user message:", err);
      }
      let assistantDbId: string | null = null;
      try {
        assistantDbId = await insertMessage({ sessionId, messageType: "assistant", content: "", status: "streaming", model: modelId });
        pendingAssistantDbIdRef.current = assistantDbId;
      } catch (err) {
        console.error("[AiPanel] Failed to persist assistant placeholder:", err);
      }
      dbIdsRef.current.push(assistantDbId);
    } else {
      dbIdsRef.current.push(null, null);
    }

    // ── Build enriched message for the API ──────────────────────────────────
    let apiText = text;
    if (editorContext && editorContext.code.trim()) {
      const relPath = sourceFilePath ? toWorkspaceRelPath(sourceFilePath, fp) : undefined;
      apiText = buildContextPrefix(editorContext, relPath) + apiText;
    }
    for (const filepath of fileMentions) {
      try {
        const content = await readFile(filepath);
        const fname = filepath.split(/[\\/]/).pop() ?? filepath;
        const ext = fname.split(".").pop()?.toLowerCase() ?? "";
        const fenceMap: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", rs: "rs", py: "python", css: "css", html: "html", json: "json", md: "markdown" };
        apiText += `\n\n[File: ${filepath}]\n\`\`\`${fenceMap[ext] ?? ext}\n${content}\n\`\`\``;
      } catch { /* skip unreadable files */ }
    }

    const userMsg: DisplayMessage = {
      role: "user", content: text, sourceFilePath,
      fileMentions: fileMentions.length > 0 ? fileMentions : undefined,
      editorContext: editorContext ?? undefined,
    };

    const modelMessages: ModelMessage[] = [
      ...buildModelHistory(messagesRef.current.filter(m => !m.streaming)),
      { role: "user" as const, content: apiText },
    ];

    setMessages(prev => [
      ...prev,
      userMsg,
      { role: "assistant", content: "", streaming: true, parts: [], sourceFilePath: userMsg.sourceFilePath },
    ]);
    setChatView("chat");
    localStorage.setItem("origin-ai-chat-view", "chat");

    const originMd = originMdRef.current;
    const withOriginMd = (base: string) => {
      // La consigne de style est toujours ajoutée en dernier : elle prime sur un
      // éventuel prompt personnalisé qui demanderait des emojis.
      const withStyle = `${base}\n\n---\n\n${STYLE_GUARDRAIL}`;
      return originMd ? `${withStyle}\n\n---\n\n${originMd}` : withStyle;
    };

    const isMax = (localStorage.getItem("origin-ai-effort") ?? "normal") === "max";
    const systemPrompt     = withOriginMd(localStorage.getItem("origin-ai-system-prompt") ?? (isMax ? DEFAULT_SYSTEM_PROMPT     : DEFAULT_SYSTEM_PROMPT_LITE));
    const askSystemPrompt  = withOriginMd(localStorage.getItem("origin-ai-ask-prompt")    ?? (isMax ? DEFAULT_ASK_PROMPT        : DEFAULT_ASK_PROMPT_LITE));
    const planSystemPrompt = withOriginMd(localStorage.getItem("origin-ai-plan-prompt")   ?? (isMax ? DEFAULT_PLAN_PROMPT       : DEFAULT_PLAN_PROMPT_LITE));

    // ── Checkpoint du tour ───────────────────────────────────────────────────
    // Ouvre un checkpoint dès qu'un tour peut écrire (Agent) ; en Ask, aucun
    // fichier n'est touché et `finish` ne montrera donc jamais de bannière.
    if (mode !== "ask") beginTurn();
    // Réinitialise la télémétrie du tour : on repart d'un compteur vierge.
    setTelemetry({ compaction: 0, retry: 0 });
    // L'onglet Agents ne montre que les sous-agents du tour courant (les cartes
    // du chat, elles, restent persistées dans les parts des messages).
    clearSubAgents();
    // Le contexte projet dérivé (stack/arbo/fichiers clés) est recalculé au début
    // de chaque tour : jamais figé d'un tour à l'autre.
    resetProjectContext();

    // ── Event handler ────────────────────────────────────────────────────────
    const handleEvent = (event: AgentEvent) => {
      switch (event.type) {

        case "token": {
          const delta = event.delta;
          pendingPartsRef.current = appendText(pendingPartsRef.current, delta);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                content: last.content + delta,
                parts: appendText(last.parts ?? [], delta),
              };
            }
            return next;
          });
          pendingContentRef.current += delta;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              const dbId = pendingAssistantDbIdRef.current;
              if (dbId) updateMessageContent(dbId, pendingContentRef.current, "streaming").catch(() => {});
            }, 500);
          }
          break;
        }

        case "reasoning": {
          // Chaîne de pensée exposée par certains modèles : on l'accumule dans une
          // part `reasoning` dédiée (rendue en section repliable), sans la mêler au
          // texte de réponse ni au contenu persisté de l'assistant.
          const delta = event.delta;
          pendingPartsRef.current = appendReasoning(pendingPartsRef.current, delta);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, parts: appendReasoning(last.parts ?? [], delta) };
            }
            return next;
          });
          break;
        }

        case "tool-call": {
          // Un tour qui émet un outil d'écriture devient « sale » : c'est ce qui
          // déclenche l'affichage de la bannière Undo/Keep à la fin du tour.
          if (event.toolName === "write_file" || event.toolName === "edit" || event.toolName === "multi_edit") {
            streamDirtyRef.current = true;
          }
          // Un tool-call préfixé par `spawnId` appartient à un sous-agent : il est
          // ajouté à la liste d'outils de sa carte (et JAMAIS au flux du root).
          if (event.spawnId) {
            const subTc: ToolCallDisplay = { id: event.id, toolName: event.toolName, args: event.args, status: "running" };
            appendChildTool(event.spawnId, subTc);
            break;
          }
          const newPart: MessagePart = { type: "tool-call", tc: { id: event.id, toolName: event.toolName, args: event.args, status: "running" } };
          pendingPartsRef.current = [...pendingPartsRef.current, newPart];
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, parts: [...(last.parts ?? []), newPart] };
            }
            return next;
          });
          break;
        }

        case "tool-result": {
          if (event.spawnId) {
            updateChildTool(event.spawnId, event.id, { status: "complete", result: event.result });
            break;
          }
          const tcUpdate = { status: "complete" as const, result: event.result, approve: undefined, reject: undefined };
          pendingPartsRef.current = updateTcInParts(pendingPartsRef.current, event.id, tcUpdate);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.parts) {
              next[next.length - 1] = { ...last, parts: updateTcInParts(last.parts, event.id, tcUpdate) };
            }
            return next;
          });
          break;
        }

        case "approval-required": {
          const _action = event.action;
          if (_action.type === "edit" || _action.type === "write_file") {
            const proposed = _action.type === "edit" ? _action.mergedContent : _action.content;
            onOpenDiffTabRef.current?.({
              approvalId: event.id,
              filePath: _action.path,
              proposedContent: proposed,
              originalContent: _action.originalContent,
              approve: event.approve,
              reject: event.reject,
            });
          }
          const approvalUpdate = { status: "approval-required" as const, action: event.action, approve: event.approve, reject: event.reject };
          const hasInParts = pendingPartsRef.current.some(p => p.type === "tool-call" && p.tc.id === event.id);
          if (hasInParts) {
            pendingPartsRef.current = updateTcInParts(pendingPartsRef.current, event.id, approvalUpdate);
          } else {
            const tc = { id: event.id, toolName: event.action.type, args: event.action, ...approvalUpdate };
            pendingPartsRef.current = [...pendingPartsRef.current, { type: "tool-call", tc }];
          }
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (!last || last.role !== "assistant") return next;
            const existingParts = last.parts ?? [];
            const hasMatch = existingParts.some(p => p.type === "tool-call" && p.tc.id === event.id);
            if (hasMatch) {
              next[next.length - 1] = { ...last, parts: updateTcInParts(existingParts, event.id, approvalUpdate) };
            } else {
              const insertedTc = { id: event.id, toolName: event.action.type, args: event.action, ...approvalUpdate };
              next[next.length - 1] = { ...last, parts: [...existingParts, { type: "tool-call", tc: insertedTc }] };
            }
            return next;
          });
          break;
        }

        case "approval-resolved": {
          // Une action a été auto-approuvée ou bloquée sans carte de confirmation.
          // On fige l'état du tool call correspondant pour que l'UI (et l'historique)
          // reflète la décision.
          const resolved = event.status === "approved"
            ? { status: "complete" as const, approve: undefined, reject: undefined }
            : { status: "complete" as const, result: { cancelled: true }, approve: undefined, reject: undefined };
          pendingPartsRef.current = updateTcInParts(pendingPartsRef.current, event.id, resolved);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.parts) {
              next[next.length - 1] = { ...last, parts: updateTcInParts(last.parts, event.id, resolved) };
            }
            return next;
          });
          break;
        }

        case "notice": {
          // Bannière système in-line : compaction de l'historique ou reprise auto.
          // On la pousse comme part `status` dans le message assistant courant.
          const statusPart: MessagePart = { type: "status", kind: event.kind, detail: event.detail, savedTokens: event.savedTokens };
          pendingPartsRef.current = [...pendingPartsRef.current, statusPart];
          // Télémétrie : on incrémente le compteur de la session.
          setTelemetryRef.current?.(t => {
            const key = event.kind;
            return { ...t, [key]: (t[key] ?? 0) + 1, lastSavedTokens: event.savedTokens ?? t.lastSavedTokens };
          });
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, parts: [...(last.parts ?? []), statusPart] };
            }
            return next;
          });
          break;
        }

        case "step-finish":
          break;

        case "subagent-start": {
          // Carte de sous-agent rattachée au tool-call `spawn_agent` (si l'id est
          // connu) : on l'insère comme enfant du tool-call parent.
          startSubAgent({ spawnId: event.spawnId, role: event.role, task: event.task, toolCallId: event.toolCallId });
          const attachChild = (parts: MessagePart[]): MessagePart[] => {
            if (!event.toolCallId) return parts;
            return parts.map(p => {
              if (p.type !== "tool-call" || p.tc.id !== event.toolCallId) return p;
              const children = p.tc.children ?? [];
              if (children.some(c => c.spawnId === event.spawnId)) return p;
              return {
                ...p,
                tc: {
                  ...p.tc,
                  children: [...children, {
                    spawnId: event.spawnId, role: event.role, task: event.task,
                    iterations: 0, inputTokens: 0, outputTokens: 0, tools: [],
                  }],
                },
              };
            });
          };
          pendingPartsRef.current = attachChild(pendingPartsRef.current);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, parts: attachChild(last.parts ?? []) };
            return next;
          });
          break;
        }

        case "subagent-step":
          stepSubAgent(event.spawnId, event.iteration);
          break;

        case "subagent-end": {
          endSubAgent(event.spawnId, {
            status: event.status, report: event.report,
            iterations: event.iterations, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          });
          const finalizeChild = (parts: MessagePart[]): MessagePart[] => parts.map(p => {
            if (p.type !== "tool-call" || !p.tc.children) return p;
            let touched = false;
            const children = p.tc.children.map(c => {
              if (c.spawnId !== event.spawnId) return c;
              touched = true;
              return {
                ...c, status: event.status, report: event.report,
                iterations: event.iterations, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
              };
            });
            return touched ? { ...p, tc: { ...p.tc, children } } : p;
          });
          pendingPartsRef.current = finalizeChild(pendingPartsRef.current);
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, parts: finalizeChild(last.parts ?? []) };
            return next;
          });
          break;
        }

        case "finish": {
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          const dbId = pendingAssistantDbIdRef.current;
          const finalContent = pendingContentRef.current;
          const finalParts = pendingPartsRef.current;
          pendingAssistantDbIdRef.current = null;
          pendingPartsRef.current = [];
          const partsJson = finalParts.length > 0
            ? JSON.stringify(finalParts.map(p => {
                if (p.type !== "tool-call") return p;
                const { approve: _a, reject: _r, ...tcRest } = p.tc;
                // Les sous-agents sont persistés SANS leurs outils (transcript
                // volumineux) : seul le rapport borné est conservé pour l'historique.
                const children = tcRest.children?.map(c => ({ ...c, tools: undefined }));
                return { type: "tool-call", tc: children ? { ...tcRest, children } : tcRest };
              }))
            : null;
          if (dbId) updateMessageContent(dbId, finalContent, "complete", partsJson).catch(() => {});

          const sid = activeSessionIdRef.current;
          const fPath = folderPathRef.current ?? "";
          if (sid) {
            lsTouch(sid);
            touchSession(sid, modelId, providerId).catch(() => {});
          }
          setSessions(lsForPath(fPath));
          streamCleanupRef.current = null;

          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });

          const { usage } = event as { usage: UsageData };
          if (usage && !LOCAL_PROVIDERS.has(providerId)) {
            const prov = PROVIDERS.find(p => p.id === providerId);
            const modelName = prov?.models.find(m => m.id === modelId)?.name ?? modelId;
            const color = (prov as { color?: string })?.color ?? "#6366f1";
            const cost = computeCost(modelId, usage.inputTokens, usage.outputTokens);
            recordUsage(modelId, modelName, providerId, usage.inputTokens, usage.outputTokens, cost, color, usage.cacheReadTokens);
          }

          // Bannière Undo all / Keep all : seulement si ce tour a écrit des
          // fichiers (mode Plan phase 1 = lecture seule → jamais de bannière).
          if (streamDirtyRef.current) {
            const turnId = activeTurnIdRef.current;
            if (turnId) {
              // Résumé (chemins + deltas `+N/-N`) calculé côté Rust à partir des
              // snapshots : le front n'a pas à lire les fichiers.
              void summaryTurnCheckpoint(turnId).then(files => {
                if (files.length > 0) setCheckpointBanner({ turnId, files });
              }).catch(() => {});
              // Prévenu par la bannière, l'agent n'a plus besoin du checkpoint :
              // on le conserve jusqu'à l'action utilisateur (Undo/Keep).
            }
            streamDirtyRef.current = false;
          }

          // ── Pré-compaction réactive de fin de tour ───────────────────────────
          // Plutôt que d'attendre l'entrée du tour suivant, on vérifie l'usage
          // *projeté* (historique + marge pour la prochaine réponse/outils). Dès
          // qu'il franchit 80 %, on compacte maintenant et on l'annonce dans le
          // fil. La compaction effective au tour suivant reste faite par runAgent,
          // mais l'utilisateur voit immédiatement la pression mémoire.
          {
            const projectedHistory: ModelMessage[] = [
              ...buildModelHistory(messagesRef.current.filter(m => !m.streaming)),
            ];
            if (shouldPreCompact(projectedHistory, NEXT_TURN_MARGIN_TOKENS)) {
              const beforeTokens = estimateTokensWithOverhead(projectedHistory);
              const compacted = compactHistory(projectedHistory);
              const saved = Math.max(0, Math.round(beforeTokens - estimateTokensWithOverhead(compacted)));
              const statusPart: MessagePart = {
                type: "status", kind: "compaction",
                detail: "Compaction réactive de fin de tour (pression ≥ 80 %)",
                savedTokens: saved,
              };
              setTelemetryRef.current?.(t => ({
                ...t, compaction: t.compaction + 1,
                lastSavedTokens: saved || t.lastSavedTokens,
              }));
              setMessages(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  next[next.length - 1] = { ...last, parts: [...(last.parts ?? []), statusPart] };
                }
                return next;
              });
            }
          }

          if (currentModeRef.current === "plan") {
            currentModeRef.current = "agent";
            const plan = parsePlan(finalContent);
            if (plan) {
              phase1ContentRef.current = finalContent;
              setMessages(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  const cleanContent = last.content.replace(plan.rawXml, "").trimEnd();
                  const cleanParts = (last.parts ?? [])
                    .map(p => p.type === "text"
                      ? { ...p, content: p.content.replace(plan.rawXml, "").trimEnd() }
                      : p
                    )
                    .filter(p => p.type !== "text" || (p as { type: "text"; content: string }).content.trim() !== "");
                  const planPart: MessagePart = { type: "plan-card", plan, status: "pending" };
                  next[next.length - 1] = { ...last, content: cleanContent, parts: [...cleanParts, planPart], streaming: false };
                }
                return next;
              });
            } else {
              showToast("Plan mode: no structured plan was generated. Try rephrasing your request.", "error");
            }
          }
          break;
        }

        case "error": {
          if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
          const dbId = pendingAssistantDbIdRef.current;
          const partialContent = pendingContentRef.current;
          pendingAssistantDbIdRef.current = null;
          if (dbId) updateMessageContent(dbId, partialContent || `Error: ${event.message}`, "error").catch(() => {});
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, content: `Error: ${event.message}`, streaming: false };
            }
            return next;
          });
          streamCleanupRef.current = null;
          break;
        }
      }
    };

    // Applique une mutation à l'unique sous-agent `spawnId` d'un tool-call parent.
    // Un sous-agent est rattaché à exactement un tool-call `spawn_agent`.
    const mutateChild = (spawnId: string, fn: (children: SubAgentChild[]) => SubAgentChild[]): void => {
      const apply = (parts: MessagePart[]): MessagePart[] => parts.map(p => {
        if (p.type !== "tool-call" || !p.tc.children?.some(c => c.spawnId === spawnId)) return p;
        return { ...p, tc: { ...p.tc, children: fn(p.tc.children) } };
      });
      pendingPartsRef.current = apply(pendingPartsRef.current);
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, parts: apply(last.parts ?? []) };
        return next;
      });
    };

    // Ajoute un outil (read-only) à la carte d'un sous-agent en cours.
    const appendChildTool = (spawnId: string, tc: ToolCallDisplay): void => {
      mutateChild(spawnId, children => children.map(c =>
        c.spawnId === spawnId ? { ...c, tools: [...(c.tools ?? []), tc] } : c));
    };

    // Fige un outil d'un sous-agent (résultat reçu).
    const updateChildTool = (spawnId: string, toolId: string, update: Partial<ToolCallDisplay>): void => {
      mutateChild(spawnId, children => children.map(c => c.spawnId !== spawnId ? c : {
        ...c,
        tools: (c.tools ?? []).map(t => t.id === toolId ? { ...t, ...update } : t),
      }));
    };

    let model;
    try {
      model = buildLanguageModel(providerId, modelId, apiKey ?? "");
    } catch (e) {
      showToast(`Provider error: ${e instanceof Error ? e.message : String(e)}`, "error");
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, content: `Error: failed to build model.`, streaming: false };
        return next;
      });
      return;
    }

    const makeFullTools = () => createTools({
      folderPath: fp || ".",
      sessionId: activeSessionIdRef.current ?? undefined,
      onBeforeWrite: (path) => touchTurn(path, fp || "."),
      onApproval: (evt) => {
        // Politique de permission : on lit le mode à l'instant T (localStorage),
        // sans recréer les outils à chaque changement.
        const mode: PermissionMode = loadPermissionMode();
        const verdict = decideApproval(evt.action, { mode, workspace: fp || "." });

        if (verdict.decision === "block") {
          // Refus d'office (garde anti-catastrophe) : l'agent reçoit un échec de tool.
          showToast(verdict.reason, "error");
          evt.reject();
          handleEvent({ type: "approval-resolved", id: evt.id, status: "rejected" });
          return;
        }
        if (verdict.decision === "approve") {
          // Auto-approuvé : on exécute directement, sans carte de confirmation.
          void evt.approve();
          handleEvent({ type: "approval-resolved", id: evt.id, status: "approved" });
          return;
        }
        // `ask` : comportement normal (carte de confirmation).
        handleEvent({
          type: "approval-required",
          id: evt.id,
          action: evt.action,
          approve: evt.approve,
          reject: evt.reject,
        });
      },
    });

    if (mode === "plan") {
      currentModeRef.current = "plan";
      const capturedModelMessages = modelMessages;

      startPlanExecutionRef.current = async () => {
        const phase1Content = phase1ContentRef.current;
        const phase2Messages: ModelMessage[] = [
          ...capturedModelMessages,
          { role: "assistant" as const, content: phase1Content },
          { role: "user" as const, content: "The plan has been approved. Proceed with the implementation now." },
        ];

        if (activeSessionIdRef.current) {
          try {
            const aid = await insertMessage({ sessionId: activeSessionIdRef.current, messageType: "assistant", content: "", status: "streaming", model: modelId });
            pendingAssistantDbIdRef.current = aid;
          } catch { /* ignore */ }
        }
        pendingContentRef.current = "";
        pendingPartsRef.current = [];

        setMessages(prev => [
          ...prev,
          { role: "assistant", content: "", streaming: true, parts: [] },
        ]);

        const phase2IsMax = (localStorage.getItem("origin-ai-effort") ?? "normal") === "max";
        const phase2SystemPrompt = withOriginMd(localStorage.getItem("origin-ai-system-prompt") ?? (phase2IsMax ? DEFAULT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT_LITE));
        const { cancel } = runAgent({ model, messages: phase2Messages, tools: makeFullTools(), systemPrompt: phase2SystemPrompt, cacheSystem: providerId === "anthropic", onEvent: handleEvent });
        streamCleanupRef.current = cancel;
      };

      const readOnlyTools = createReadOnlyTools({ folderPath: fp || "." });
      const { cancel } = runAgent({ model, messages: modelMessages, tools: readOnlyTools, systemPrompt: planSystemPrompt, cacheSystem: providerId === "anthropic", onEvent: handleEvent });
      streamCleanupRef.current = cancel;
    } else if (mode === "ask") {
      const askTools = createAskTools({
        folderPath: fp || ".",
        getFileContents: getFileContents ?? (() => ({})),
        onShowDiff: (path, _original, patched) => {
          onApplyCodeRef.current?.(patched, path, undefined);
        },
      });
      const { cancel } = runAgent({ model, messages: modelMessages, tools: askTools, systemPrompt: askSystemPrompt, cacheSystem: providerId === "anthropic", onEvent: handleEvent });
      streamCleanupRef.current = cancel;
    } else {
      // ── Mode IA : orchestration avec sous-agents ──────────────────────────────
      // Le tool `spawn_agent` est exposé au root UNIQUEMENT ici (jamais en IDE).
      // Son `execute` est intercepté côté hôte : le root ne reçoit que le rapport
      // borné du sous-agent, le transcript complet reste hors de son contexte.
      const spawnCancels: Array<() => void> = [];
      // Contexte transmis aux sous-agents : un résumé borné du dernier échange de
      // l'utilisateur (« ce sur quoi on travaille ») + les todos en cours du tour.
      const lastUser = [...messages].reverse().find(m => m.role === "user");
      const threadSummary = (typeof lastUser?.content === "string" ? lastUser.content : "").slice(0, 1_500);
      const todos = getTodos(activeSessionIdRef.current ?? "").map(
        (t) => `[${t.status}] ${t.content}`,
      );
      const fullTools = wrapSpawnAgent(
        { ...makeFullTools(), spawn_agent: spawnAgentTool },
        {
          model,
          folderPath: fp || ".",
          cacheSystem: providerId === "anthropic",
          threadSummary,
          todos,
          callbacks: {
            onEvent: handleEvent,
            onSpawn: (cancel) => { spawnCancels.push(cancel); },
          },
        },
      );
      const { cancel } = runAgent({ model, messages: modelMessages, tools: fullTools, systemPrompt, cacheSystem: providerId === "anthropic", onEvent: handleEvent });
      // L'annulation du root coupe aussi les sous-agents en vol.
      streamCleanupRef.current = () => { cancel(); for (const c of spawnCancels) c(); };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getFileContents is read fresh at call time; including it would churn this callback
  }, [showToast]);

  // Annule le tour en cours. `cancel()` ne détache pas le flag `streaming`
  // (aucun event n'est émis à l'abort), on le remet donc à false nous-mêmes,
  // et on persiste le contenu partiel comme « interrupted » — comme le fait
  // déjà la sélection de session / nouveau chat.
  const handleStop = useCallback(() => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;

    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const prevDbId = pendingAssistantDbIdRef.current;
    if (prevDbId) {
      pendingAssistantDbIdRef.current = null;
      updateMessageContent(prevDbId, pendingContentRef.current, "interrupted").catch(() => {});
    }

    setMessages(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streaming) { next[i] = { ...next[i], streaming: false }; break; }
      }
      return next;
    });
  }, []);

  // Supprime côté DB tous les messages postérieurs à `fromIndex` (inclus) et
  // renvoie le nouveau tableau de messages tronqué. On se base sur les ids DB
  // indexés : les messages antérieurs ne sont jamais touchés, et un id manquant
  // (persistance en échec) est simplement ignoré côté suppression.
  const truncateFrom = useCallback(async (fromIndex: number): Promise<DisplayMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    const ids = dbIdsRef.current.slice(fromIndex);
    if (sessionId) {
      const toDelete = ids.filter((id): id is string => !!id);
      if (toDelete.length > 0) {
        deleteMessagesByIds(sessionId, toDelete).catch(err =>
          console.error("[AiPanel] Failed to truncate messages:", err));
      }
    }
    dbIdsRef.current = dbIdsRef.current.slice(0, fromIndex);
    const next = messagesRef.current.slice(0, fromIndex);
    setMessages(next);
    return next;
  }, []);

  // « Régénérer » : on remonte au message utilisateur qui précède la réponse,
  // on tronque tout ce qui suit et on relance le tour avec le même texte — les
  // pièces jointes d'origine sont conservées.
  const handleRegenerate = useCallback((assistantIndex: number) => {
    if (isStreaming) return;
    const msgs = messagesRef.current;
    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { userIndex = i; break; }
    }
    if (userIndex === -1) return;
    const user = msgs[userIndex];
    void (async () => {
      await truncateFrom(userIndex);
      const mode = currentModeRef.current === "plan" ? "plan" : "agent";
      void handleSend(
        user.content, activeModelIdRef.current, activeProviderIdRef.current,
        user.fileMentions ?? [], user.editorContext ?? null, mode,
      );
    })();
  }, [isStreaming, truncateFrom, handleSend]);

  // « Éditer et renvoyer » : on place le texte du message dans l'éditeur pour
  // que l'utilisateur le corrige, et on tronque l'historique à partir de ce
  // message (l'envoi reste manuel — pas de rejeu implicite).
  const handleEditUserMessage = useCallback((userIndex: number) => {
    if (isStreaming) return;
    const user = messagesRef.current[userIndex];
    if (!user) return;
    chatBoxRef.current?.setText(user.content);
    void truncateFrom(userIndex);
  }, [isStreaming, truncateFrom]);

  // « Supprimer » (message utilisateur) : on retire le message et tout ce qui
  // suit — l'utilisateur repart d'un historique propre, sans rejouer la demande.
  const handleDeleteUserMessage = useCallback((userIndex: number) => {
    if (isStreaming) return;
    void truncateFrom(userIndex);
  }, [isStreaming, truncateFrom]);

  // « Revert » (message utilisateur) : on annule TOUT ce qui a été généré pendant
  // ce run — les fichiers écrits (checkpoint du tour) ET les messages qui suivent
  // ce message. On restaure d'abord les fichiers (action destructive) avant de
  // tronquer l'historique, pour ne pas perdre de vue le checkpoint en cas d'échec.
  const handleRevertUserMessage = useCallback(async (userIndex: number) => {
    if (isStreaming) return;
    const fp = folderPathRef.current ?? "";
    const turnId = activeTurnIdRef.current;
    if (turnId) {
      try {
        const restored = await undoTurnCheckpoint(turnId, fp || null);
        showToast(`Reverted ${restored.length} file${restored.length === 1 ? "" : "s"}`, "success");
      } catch (e) {
        showToast(`Revert failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      discardTurnCheckpoint(turnId).catch(() => {});
      activeTurnIdRef.current = null;
      setCheckpointBanner(null);
    }
    void truncateFrom(userIndex);
  }, [isStreaming, showToast, truncateFrom]);

  // Toute action sur un message (copier, éditer, régénérer) vaut « Keep all » du
  // checkpoint courant : l'utilisateur ne reviendra plus en arrière sur ce tour,
  // et on évite ainsi de laisser une bannière Undo pointer sur un état obsolète.
  const handleMessageAction = useCallback(() => {
    const prevTurn = activeTurnIdRef.current;
    if (prevTurn) {
      activeTurnIdRef.current = null;
      discardTurnCheckpoint(prevTurn).catch(() => {});
    }
    setCheckpointBanner(null);
  }, []);

  // « Insérer » : place une citation du message dans l'éditeur du ChatBox, pour
  // que l'utilisateur réponde en citant un extrait (comportement type Cursor).
  const handleInsertMessage = useCallback((text: string) => {
    const quoted = text.split("\n").map(l => `> ${l}`).join("\n") + "\n\n";
    chatBoxRef.current?.setText(quoted);
  }, []);

  // Ouvre un chemin cité dans le chat. Les outils travaillent en chemins
  // relatifs au workspace : on les résout en absolu avant d'ouvrir l'onglet.
  const handleOpenFileRef = useRef(onOpenFile);
  useEffect(() => { handleOpenFileRef.current = onOpenFile; }, [onOpenFile]);
  const handleOpenFile = useCallback((path: string, line?: number, col?: number) => {
    if (!path) return;
    const fp = folderPathRef.current ?? "";
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
    const abs = isAbsolute || !fp
      ? path
      : `${fp.replace(/[\\/]$/, "")}/${path.replace(/^[\\/]+/, "")}`;
    handleOpenFileRef.current?.(abs, line, col);
  }, []);

  // Bascule le vote d'un message (mutuellement exclusif, re-clic = annulation).
  const handleVoteMessage = useCallback((index: number, vote: "up" | "down") => {
    setFeedbackByIndex(prev => {
      const next = { ...prev };
      if (prev[index] === vote) delete next[index];
      else next[index] = vote;
      return next;
    });
  }, []);

  const handleNewChat = useCallback(() => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;

    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const prevDbId = pendingAssistantDbIdRef.current;
    if (prevDbId) {
      pendingAssistantDbIdRef.current = null;
      updateMessageContent(prevDbId, pendingContentRef.current, "interrupted").catch(() => {});
    }

    setMessages([]);
    setActiveSessionId(null);
    const fp = folderPathRef.current ?? "";
    localStorage.removeItem(activeSessionKey(fp));
    onActiveSessionChangeRef.current?.(null);
    setChatView("new");
    localStorage.removeItem("origin-ai-chat-view");
    setSessions(lsForPath(fp));
  }, [setActiveSessionId]);

  // External drivers from the Agent mode task rail.
  const lastOpenSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openSessionId || openSessionId === lastOpenSessionRef.current) return;
    lastOpenSessionRef.current = openSessionId;
    if (openSessionId !== activeSessionIdRef.current) void handleSessionSelect(openSessionId);
  }, [openSessionId, handleSessionSelect]);

  const lastNewChatNonceRef = useRef(newChatNonce);
  useEffect(() => {
    if (newChatNonce === lastNewChatNonceRef.current) return;
    lastNewChatNonceRef.current = newChatNonce;
    handleNewChat();
  }, [newChatNonce, handleNewChat]);

  const handlePlanApprove = useCallback(async () => {
    setMessages(prev => {
      const next = [...prev];
      outer: for (let i = next.length - 1; i >= 0; i--) {
        const msg = next[i];
        if (!msg.parts) continue;
        for (let j = msg.parts.length - 1; j >= 0; j--) {
          const p = msg.parts[j];
          if (p.type === "plan-card" && p.status === "pending") {
            const newParts = [...msg.parts];
            newParts[j] = { ...p, status: "approved" };
            next[i] = { ...msg, parts: newParts };
            break outer;
          }
        }
      }
      return next;
    });
    await startPlanExecutionRef.current?.();
  }, []);

  const handlePlanReject = useCallback(() => {
    setMessages(prev => {
      const next = [...prev];
      outer: for (let i = next.length - 1; i >= 0; i--) {
        const msg = next[i];
        if (!msg.parts) continue;
        for (let j = msg.parts.length - 1; j >= 0; j--) {
          const p = msg.parts[j];
          if (p.type === "plan-card" && p.status === "pending") {
            const newParts = [...msg.parts];
            newParts[j] = { ...p, status: "rejected" };
            next[i] = { ...msg, parts: newParts };
            break outer;
          }
        }
      }
      return next;
    });
    startPlanExecutionRef.current = null;
    currentModeRef.current = "agent";
  }, []);

  // ── Undo all / Keep all ──────────────────────────────────────────────────
  // « Keep all » : on oublie simplement le checkpoint (les écritures restent).
  const handleKeepAll = useCallback(async () => {
    const banner = checkpointBanner;
    setCheckpointBanner(null);
    if (!banner) return;
    discardTurnCheckpoint(banner.turnId).catch(() => {});
    showToast("Changes kept", "success");
  }, [checkpointBanner, showToast]);

  // « Undo all » : on restaure chaque fichier capturé dans son état d'origine.
  const handleUndoAll = useCallback(async () => {
    const banner = checkpointBanner;
    if (!banner) return;
    const fp = folderPathRef.current ?? "";
    try {
      const restored = await undoTurnCheckpoint(banner.turnId, fp || null);
      setCheckpointBanner(null);
      showToast(`Reverted ${restored.length} file${restored.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      showToast(`Undo failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [checkpointBanner, showToast]);

  // Ouvre le diff relatif au tour : « avant » (backup du checkpoint) vs état
  // courant. Réutilise l'onglet diff de l'IA en mode lecture seule (approve et
  // reject sont des no-op — la bannière Undo/Keep reste la seule action).
  const handleOpenCheckpointDiff = useCallback(async (file: TurnFileDelta) => {
    const banner = checkpointBanner;
    if (!banner || !onOpenDiffTab) return;
    const fp = folderPathRef.current ?? "";
    const isAbs = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(file.path);
    const abs = isAbs || !fp
      ? file.path
      : `${fp.replace(/[\\/]$/, "")}/${file.path.replace(/^[\\/]+/, "")}`;
    try {
      const before = await fileBeforeTurnCheckpoint(banner.turnId, file.path);
      const current = getFileContents?.()[abs] ?? "";
      onOpenDiffTab({
        approvalId: `cp-${banner.turnId}-${file.path}`,
        filePath: abs,
        originalContent: before,
        proposedContent: current,
        approve: () => {},
        reject: () => {},
      });
    } catch (e) {
      showToast(`Could not open diff: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [checkpointBanner, onOpenDiffTab, getFileContents, showToast]);

  const handleStartPin = useCallback((content: string) => {
    setPendingPin({ content, sessionId: activeSessionIdRef.current ?? undefined });
  }, []);

  const handleConfirmPin = useCallback((label: string) => {
    if (!pendingPin) return;
    const fp = folderPathRef.current ?? "";
    const pin: PinnedMessage = { id: crypto.randomUUID(), content: pendingPin.content, pinnedAt: Date.now(), sessionId: pendingPin.sessionId, label: label || undefined };
    const next = [pin, ...pbRead(fp)];
    pbWrite(fp, next);
    setPinnedMessages(next);
    setPendingPin(null);
    showToast("Pinned to Pinboard", "success");
  }, [pendingPin, showToast]);

  const handleNavigateToPin = useCallback(async (pin: PinnedMessage) => {
    if (!pin.sessionId) return;
    pendingScrollContentRef.current = pin.content;
    await handleSessionSelect(pin.sessionId);
  }, [handleSessionSelect]);

  const handleUnpin = useCallback((id: string) => {
    const fp = folderPathRef.current ?? "";
    const next = pbRead(fp).filter(p => p.id !== id);
    pbWrite(fp, next);
    setPinnedMessages(next);
  }, []);

  const handleNotesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setNotesValue(val);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      localStorage.setItem(NOTES_KEY(folderPathRef.current ?? ""), val);
    }, 500);
  }, []);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    lsDelete(sessionId);
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    const fp = folderPathRef.current ?? "";
    if (activeSessionIdRef.current === sessionId) {
      setActiveSessionId(null);
      localStorage.removeItem(activeSessionKey(fp));
      onActiveSessionChangeRef.current?.(null);
    }
    deleteSession(sessionId).catch(err => console.error("[AiPanel] Failed to delete session:", err));
  }, [setActiveSessionId]);

  const dragging = useRef(false);
  const startX   = useRef(0);
  const startW   = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true; startX.current = e.clientX; startW.current = width;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(effMax, Math.max(effMin, startW.current + (startX.current - ev.clientX)));
      setWidth(next);
      localStorage.setItem("origin-ai-panel-width", String(next));
    };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width, effMin, effMax]);

  // Right-edge resize handle (Agent mode): dragging right widens the panel.
  const onRightMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true; startX.current = e.clientX; startW.current = width;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(effMax, Math.max(effMin, startW.current + (ev.clientX - startX.current)));
      setWidth(next);
      localStorage.setItem("origin-ai-panel-width", String(next));
    };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width, effMin, effMax]);

  const onCtxMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true; startX.current = e.clientX; startW.current = contextWidth;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(CTX_MAX, Math.max(CTX_MIN, startW.current + (startX.current - ev.clientX)));
      setContextWidth(next);
      localStorage.setItem("origin-ai-ctx-width", String(next));
    };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [contextWidth]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
    <div className="flex shrink-0 h-full gap-1">

      {/* ── Chat section ── */}
      <div
        className="relative flex flex-col shrink-0 overflow-hidden"
        style={{ width, backgroundColor: "var(--origin-bg-sidebar)" }}
      >
        {renderMode !== "agent" && (
          <div
            onMouseDown={onMouseDown}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10"
            style={{ backgroundColor: "transparent" }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-border-default)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          />
        )}
        {renderMode === "agent" && (
          <div
            onMouseDown={onRightMouseDown}
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10"
            style={{ backgroundColor: "transparent" }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-border-default)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          />
        )}

        {/* Header */}
        <div className="flex items-center px-3 shrink-0" style={{ height: "36px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.04em", color: "var(--origin-fg-default)" }}>AGENT</span>
          <div className="flex items-center gap-0.5 ml-auto">
            <HeaderBtn
              label="History"
              active={chatView === "history"}
              onClick={() => {
                if (chatView === "history") {
                  setChatView(messages.length > 0 ? "chat" : "new");
                } else {
                  setSessions(lsForPath(folderPath ?? ""));
                  setChatView("history");
                }
              }}
            ><Icon icon="lucide:history" width={14} /></HeaderBtn>
            <HeaderBtn label="New Chat" onClick={handleNewChat}><Icon icon="lucide:plus" width={14} /></HeaderBtn>
            <Tooltip content="Toggle Pinboard" side="left">
              <HeaderBtn label="Toggle Pinboard" active={contextOpen} onClick={() => setContextOpen(v => !v)}>
                <Icon icon="lucide:pin" width={14} />
              </HeaderBtn>
            </Tooltip>
          </div>
        </div>

        {/* New chat view — Agent empty state */}
        {chatView === "new" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <RecentSessions
              sessions={sessions}
              onSelect={handleSessionSelect}
              onShowAll={() => { setSessions(lsForPath(folderPath ?? "")); setChatView("history"); }}
            />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", gap: "18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <img src={logoCode} alt="Origin" style={{ width: 32, height: 32, flexShrink: 0 }} />
                <span style={{ fontSize: "26px", fontWeight: 700, color: "var(--origin-fg-default)" }}>Agent</span>
              </div>
              <div style={{ fontSize: "13px", color: "var(--origin-fg-muted)", textAlign: "center" }}>
                Deep understanding of complex tasks
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px", maxWidth: 360 }}>
                {[
                  { icon: "lucide:check", text: "Handles iterations, bug fixes, and refactoring in large projects" },
                  { icon: "lucide:check", text: "Plans tasks intelligently and drives execution with precision" },
                  { icon: "lucide:check", text: "Orchestrates intelligent multi-agent collaboration" },
                ].map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <Icon icon={f.icon} width={14} style={{ color: "var(--origin-semantic-success)", flexShrink: 0, marginTop: "2px" }} />
                    <span style={{ fontSize: "13px", color: "var(--origin-fg-muted)", lineHeight: 1.5 }}>{f.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <ChatBox onSend={handleSend} getEditorContext={getEditorContext} forcedContext={forcedContext} onForcedContextConsumed={onForcedContextConsumed} isStreaming={isStreaming} onStop={handleStop} handleRef={chatBoxRef} />
          </div>
        )}

        {/* Active chat view */}
        {chatView === "chat" && (
          <>
            <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div ref={scrollContainerRef} onScroll={handleThreadScroll} style={{ flex: 1, overflowY: "auto", padding: "16px 14px 8px", display: "flex", flexDirection: "column" }}>
                {messages.map((msg, i) => (
                  <div key={i} ref={el => { if (el) messageRefsMap.current.set(i, el); else messageRefsMap.current.delete(i); }}>
                    <MessageBubble
                      message={msg}
                      folderPath={folderPath}
                      onApplyCode={onApplyCode}
                      getOpenTabPaths={getOpenTabPaths}
                      onResolveFail={() => showToast("Could not determine target file for this code block.", "error")}
                      onPin={handleStartPin}
                      onPlanApprove={handlePlanApprove}
                      onPlanReject={handlePlanReject}
                      onRegenerate={() => handleRegenerate(i)}
                      onEditUserMessage={() => handleEditUserMessage(i)}
                      onDeleteUserMessage={() => handleDeleteUserMessage(i)}
                      onRevertUserMessage={() => handleRevertUserMessage(i)}
                      onInsert={() => handleInsertMessage(msg.content)}
                      onOpenFile={handleOpenFile}
                      canRegenerate={!isStreaming && i === messages.length - 1}
                      onActionCopy={handleMessageAction}
                      vote={feedbackByIndex[i] ?? null}
                      onVote={v => handleVoteMessage(i, v)}
                      /* L'anneau de contexte n'apparaît que sur le dernier message :
                         il reflète l'état courant, pas un historique par message. */
                      contextUsed={i === messages.length - 1 ? contextTokens : undefined}
                      contextBudget={i === messages.length - 1 ? DEFAULT_TOKEN_BUDGET : undefined}
                    />
                  </div>
                ))}
                {telemetry.compaction > 0 || telemetry.retry > 0 ? (
                  <div style={{
                    marginTop: "4px", display: "flex", flexWrap: "wrap", gap: "10px",
                    fontSize: "10px", fontFamily: "var(--font-mono)",
                    color: "var(--origin-fg-subtle)",
                  }}>
                    {telemetry.compaction > 0 && (
                      <span>
                        {telemetry.compaction} compaction{telemetry.compaction > 1 ? "s" : ""}
                        {telemetry.lastSavedTokens ? ` · ≈ ${telemetry.lastSavedTokens.toLocaleString()} tokens` : ""}
                      </span>
                    )}
                    {telemetry.retry > 0 && (
                      <span>{telemetry.retry} reprise{telemetry.retry > 1 ? "s" : ""} auto</span>
                    )}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
              {showJumpToBottom && (
                <button
                  onClick={jumpToBottom}
                  title="Descendre en bas"
                  style={{
                    position: "absolute", bottom: "10px", left: "50%", transform: "translateX(-50%)",
                    display: "flex", alignItems: "center", gap: "5px",
                    padding: "4px 10px", borderRadius: "14px",
                    border: "1px solid var(--origin-border-default)",
                    backgroundColor: "var(--origin-bg-active)",
                    color: "var(--origin-fg-default)", cursor: "pointer",
                    fontSize: "11px", boxShadow: "0 2px 8px rgba(0,0,0,0.25)", zIndex: 5,
                  }}
                >
                  <Icon icon="lucide:arrow-down" width={12} />
                  Descendre
                </button>
              )}
            </div>
            {checkpointBanner && (
              <div style={{ padding: "0 14px" }}>
                <TurnCheckpointCard
                  files={checkpointBanner.files}
                  undo={handleUndoAll}
                  keep={handleKeepAll}
                  onOpenDiff={onOpenDiffTab ? handleOpenCheckpointDiff : undefined}
                />
              </div>
            )}
            {activeSessionId && <PinnedTodoList sessionId={activeSessionId} />}
            <ChatBox onSend={handleSend} getEditorContext={getEditorContext} forcedContext={forcedContext} onForcedContextConsumed={onForcedContextConsumed} isStreaming={isStreaming} onStop={handleStop} handleRef={chatBoxRef} />
          </>
        )}

        {/* History view */}
        {chatView === "history" && (
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--origin-border-default)" }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)" }}>Chat History</div>
              {folderPath && (
                <div style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {folderPath.split(/[/\\]/).pop()}
                </div>
              )}
            </div>
            {sessions.length === 0 ? (
              <div style={{ padding: "20px 14px", fontSize: "12px", color: "var(--origin-fg-subtle)" }}>
                No chat history for this project yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1px", padding: "6px" }}>
                {sessions.map(s => (
                  <div
                    key={s.id}
                    style={{ display: "flex", alignItems: "center", borderRadius: "6px", position: "relative" }}
                    onMouseEnter={() => setHoveredSessionId(s.id)}
                    onMouseLeave={() => setHoveredSessionId(null)}
                  >
                    <button
                      onClick={() => handleSessionSelect(s.id)}
                      style={{
                        display: "flex", alignItems: "center", flex: 1,
                        padding: "8px 8px", borderRadius: "6px",
                        background: hoveredSessionId === s.id ? "var(--origin-bg-hover)" : "none",
                        border: "none", cursor: "pointer", gap: "8px", textAlign: "left", minWidth: 0,
                      }}
                    >
                      <Icon icon="lucide:message-square" width={13} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: "12px", color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.title}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", flexShrink: 0, marginRight: "4px" }}>
                        {formatRelativeTime(s.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setConfirmDelete({ id: s.id, title: s.title }); }}
                      style={{
                        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                        width: "26px", height: "26px", borderRadius: "5px",
                        background: "none", border: "none", cursor: "pointer",
                        color: "var(--origin-fg-subtle)",
                        opacity: hoveredSessionId === s.id ? 1 : 0,
                        pointerEvents: hoveredSessionId === s.id ? "auto" : "none",
                        marginRight: "4px", transition: "opacity 0.1s",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.backgroundColor = "var(--origin-bg-active)"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "var(--origin-fg-subtle)"; e.currentTarget.style.backgroundColor = "transparent"; }}
                      aria-label="Delete session"
                    >
                      <Icon icon="lucide:trash-2" width={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Pinboard panel ── */}
      {contextOpen && (
        <div
          className="relative flex flex-col shrink-0 overflow-hidden"
          style={{ width: contextWidth, backgroundColor: "var(--origin-bg-sidebar)" }}
        >
          <div
            onMouseDown={onCtxMouseDown}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10"
            style={{ backgroundColor: "transparent" }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-border-default)"; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          />
          <div className="flex items-center px-3 shrink-0" style={{ height: "36px", borderBottom: "1px solid var(--origin-border-default)", gap: "6px" }}>
            <Icon icon="lucide:pin" width={13} style={{ color: "var(--origin-fg-muted)" }} />
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--origin-fg-default)" }}>Pinboard</span>
          </div>

          <div style={{ flex: 7, minHeight: 0, overflowY: "auto", padding: "8px 8px 4px" }}>
            {pinnedMessages.length === 0 ? (
              <div style={{ padding: "16px 6px", fontSize: "12px", color: "var(--origin-fg-subtle)", lineHeight: 1.55 }}>
                No pinned messages yet. Hover over an AI response and click the pin icon to save it here.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {pinnedMessages.map(pin => {
                  const isExpanded = expandedPins.has(pin.id);
                  const preview = pinPreview(pin);
                  return (
                    <div key={pin.id} style={{ borderRadius: "7px", border: "1px solid var(--origin-border-default)", backgroundColor: "var(--origin-bg-base)", overflow: "hidden" }}>
                      <div
                        onClick={() => setExpandedPins(prev => { const next = new Set(prev); if (next.has(pin.id)) next.delete(pin.id); else next.add(pin.id); return next; })}
                        style={{ display: "flex", alignItems: "flex-start", gap: "6px", padding: "8px 8px 6px", cursor: "pointer" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--origin-bg-hover)"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent"; }}
                      >
                        <span style={{ flexShrink: 0, marginTop: "1px", color: "var(--origin-fg-subtle)" }}>
                          {isExpanded ? <Icon icon="lucide:chevron-down" width={12} /> : <Icon icon="lucide:chevron-right" width={12} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: "12px", fontWeight: pin.label ? 600 : 400, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {preview}
                          </div>
                          <div style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", marginTop: "2px" }}>
                            {formatRelativeTime(pin.pinnedAt)}
                          </div>
                        </div>
                        {pin.sessionId && (
                          <button onClick={e => { e.stopPropagation(); handleNavigateToPin(pin); }} title="Go to message" style={{ flexShrink: 0, display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: "2px", borderRadius: "3px", color: "var(--origin-fg-subtle)" }} onMouseEnter={e => { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.backgroundColor = "var(--origin-bg-active)"; }} onMouseLeave={e => { e.currentTarget.style.color = "var(--origin-fg-subtle)"; e.currentTarget.style.backgroundColor = "transparent"; }}>
                            <Icon icon="lucide:arrow-up-right" width={12} />
                          </button>
                        )}
                        <button onClick={e => { e.stopPropagation(); handleUnpin(pin.id); }} title="Unpin" style={{ flexShrink: 0, display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: "2px", borderRadius: "3px", color: "var(--origin-fg-subtle)" }} onMouseEnter={e => { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.backgroundColor = "var(--origin-bg-active)"; }} onMouseLeave={e => { e.currentTarget.style.color = "var(--origin-fg-subtle)"; e.currentTarget.style.backgroundColor = "transparent"; }}>
                          <Icon icon="lucide:pin-off" width={11} />
                        </button>
                      </div>
                      {isExpanded && (
                        <div style={{ padding: "0 10px 10px", borderTop: "1px solid var(--origin-border-default)", fontSize: "12px", lineHeight: 1.55, overflowY: "auto", maxHeight: "320px" }}>
                          <MarkdownMessage content={pin.content} isStreaming={false} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ flex: 3, minHeight: 0, borderTop: "1px solid var(--origin-border-default)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "6px 12px 4px", fontSize: "10px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>
              Notes
            </div>
            <textarea
              value={notesValue}
              onChange={handleNotesChange}
              placeholder="Write anything…"
              style={{ flex: 1, resize: "none", border: "none", outline: "none", background: "transparent", padding: "4px 12px 10px", fontSize: "12px", lineHeight: 1.6, color: "var(--origin-fg-default)", fontFamily: "var(--font-sans)", overflowY: "auto" }}
            />
          </div>
        </div>
      )}
    </div>

    {pendingPin && (
      <PinLabelPopover onConfirm={handleConfirmPin} onCancel={() => setPendingPin(null)} />
    )}
    {confirmDelete && (
      <ConfirmDialog
        title="Delete Chat"
        message="Are you sure you want to delete this chat? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => { handleDeleteSession(confirmDelete.id); setConfirmDelete(null); }}
        onCancel={() => setConfirmDelete(null)}
      />
    )}
    </>
  );
}
