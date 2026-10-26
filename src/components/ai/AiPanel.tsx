import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { Tooltip } from "../ui/Tooltip";
import { useToast } from "../ui/Toast";
import ChatBox, { type ChatBoxHandle } from "./ChatBox";
import MessageBubble from "./MessageBubble";
import TurnReviewCard from "./TurnReviewCard";
import PinnedTodoList from "./PinnedTodoList";
import {
  beginTurnCheckpoint, touchTurnFile, discardTurnCheckpoint, keepTurnCheckpoint,
  summaryTurnCheckpoint, fileBeforeTurnCheckpoint, listTurnCheckpoints,
  previewRevertTurns, revertTurns,
  type TurnFileDelta, type RevertPlanEntry,
} from "../../lib/turnCheckpoint";
import { parentOf } from "../../lib/explorer/treeModel";
import { notifyExplorerDirsChanged } from "../../lib/explorer/refreshBus";
import { handleMessageAreaCopy } from "../../lib/ai/copyConversation";
import {
  collectTurnIdsFrom as collectTurnIdsFromPure,
  keepFrom,
  revertableIndexesAfterKeep,
  hydrateTurns,
  keptReviewsBefore,
} from "../../lib/agent/reviewState";
import RevertConfirmDialog from "./RevertConfirmDialog";
import QuestionPrompt from "./QuestionPrompt";
import MarkdownMessage from "./MarkdownMessage";
import { accentForModel } from "./providers";
import { findCustomModel } from "../../lib/agent/customModels";
import { resolveMiraModel } from "../../lib/agent/miraModels";
import logoCode from "../../assets/logo-code.svg";
import {
  STYLE_GUARDRAIL,
  buildSystemPrompt,
  composeSystemPrompt,
  type UsageData,
} from "../../lib/ai";
import { ensurePricing, computeCost } from "../../lib/pricing";
import { recordUsage } from "../../lib/usage";
import { loadApiKey } from "../../lib/secrets";
import { readFile, readDir, revealInExplorer } from "../../lib/fs";
import { invoke } from "@tauri-apps/api/core";
import { resolveClineProvider, buildLanguageModel } from "../../lib/agent/providers";
import { type AgentEvent } from "../../lib/agent/run";
import { startClineHarness } from "../../lib/agent/clineHarness";
import { PREVIEW_ACTIVE_TARGET } from "../../lib/ai/previewTabs";
import { listExtensions as listClineExtensions, EXTENSIONS_CHANGED_EVENT } from "../../lib/agent/clineClient";
import type { ClineRunHandle, ClineSessionExtensions } from "../../lib/agent/clineClient";
import { isWriteTool } from "../../lib/agent/clineBridge";
import { isVerificationCommand, shouldBlockForVerification, VERIFY_BEFORE_FINISH_REMINDER } from "../../lib/agent/terminationGate";
import { toPendingAction } from "../../lib/agent/clineApproval";
import { agentTerminalCommandStart, agentTerminalCommandEnd, agentTerminalOutput } from "../../lib/agent/agentTerminalStore";
import { log } from "../../lib/logger";
import { neutralizeForClient } from "../../lib/brand";
import { resetProjectContext } from "../../lib/agent/projectContext";
import { getRun, forgetRun, setRunMessages, getRunMessages, listLiveRuns } from "../../lib/agent/runState";
import { beginTaskRun, markTaskWaiting, markTaskRunning, type RegisterRunHandle } from "../../lib/agent/taskRuntime";
import { planNotification, isToastEnabled } from "../../lib/notify/notify";
import { playSound, isSoundEnabled, primeSound } from "../../lib/notify/sound";
import { startSubAgent, stepSubAgent, endSubAgent, clearSubAgents } from "../../lib/agent/swarmStore";
import { isBuiltinControlEnabled } from "../../lib/browserPrefs";
import { getDisabledTools, isFamilyEnabled, AGENT_TOOLS } from "../../lib/agent/agentToolPrefs";
import { listAgents, readSelectedAgentId, resolveSelectedAgent, CUSTOM_AGENTS_EVENT, type CustomAgent } from "../../lib/agent/customAgents";
import { finalizeTodos, setTodos, clearTodos } from "../../lib/agent/todoStore";
import { enqueueMessage, dequeueMessage } from "../../lib/agent/messageQueue";
import { shouldPreCompact, estimateTokens, estimateTokensWithOverhead, contextStatusPrompt, DEFAULT_TOKEN_BUDGET, PRESERVE_RECENT_TOKENS } from "../../lib/agent/tokenBudget";
import { compactHistory, findStaleReads, compactDisplayMessages, mutatedPathsOf, compactLargeToolResults } from "../../lib/agent/compactHistory";
import { summarizeHistory, SUMMARY_SYSTEM_PROMPT, recentWindowStart } from "../../lib/agent/historySummary";
import { readCompactionSummary, writeCompactionSummary, clearCompactionSummary, withCompactionSummary } from "../../lib/agent/compactionStore";
import { parsePlan } from "../../lib/agent/planTypes";
import { generateText, type ModelMessage } from "ai";
import {
  createSession,
  touchSession,
  insertMessage,
  updateMessageContent,
  deleteMessagesByIds,
  deleteSession,
  getClineSessionId,
  setClineSessionId,
  getSessionAppMode,
  setSessionAppMode as persistSessionAppMode,
  type DbSession,
} from "../../lib/db";
import type { EditorContext } from "../editor/Editor";
import { useWorkspace } from "../../context/WorkspaceContext";
import {
  type DisplayMessage, type MessagePart, type PinnedMessage, type ToolCallDisplay, type SubAgentChild,
  type QueuedMessage,
  appendText, appendReasoning, updateTcInParts, isQuotaError,
} from "../../lib/aiTypes";
import {
  activeSessionKey, lsForPath, lsPush, lsTouch, lsDelete,
  restoreSession,
} from "../../lib/sessionStore";
import { pbRead, pbWrite, pinPreview, NOTES_KEY } from "../../lib/pinboardStore";
import type { ContextRef } from "../../lib/contextMentions";
import { serializeContextRefs, parseContextRef } from "../../lib/contextMentions";
import { useDiagnostics, type DiagnosticEntry } from "../../context/DiagnosticsContext";
import { useAccount } from "../../lib/agent/account";
import { requestSignIn } from "../../lib/agent/signInBus";

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

/** Table de correspondance extension → langage de fence Markdown (partagée). */
const FENCE_MAP: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", rs: "rs",
  py: "python", css: "css", html: "html", json: "json", md: "markdown",
};

function buildContextPrefix(ctx: EditorContext, displayPath?: string): string {
  // Une sélection de terminal n'a pas d'extension de fichier : on force le fence
  // `shell` et un libellé explicite, pour que le modèle sache qu'il s'agit de
  // sortie/commandes de terminal et non de code d'un fichier.
  if (ctx.type === "terminal") {
    return `[Terminal selection]\n\`\`\`shell\n${ctx.code}\n\`\`\`\n\n`;
  }
  const ext = ctx.filename.split(".").pop()?.toLowerCase() ?? "";
  const fence = FENCE_MAP[ext] ?? ext;
  const label = ctx.type === "selection" ? "Selected code" : "Visible code";
  return `[${label} in ${displayPath ?? ctx.filename}]\n\`\`\`${fence}\n${ctx.code}\n\`\`\`\n\n`;
}

function toWorkspaceRelPath(fullPath: string, folderPath: string): string {
  const fpNorm = folderPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const spNorm = fullPath.replace(/\\/g, "/");
  return spNorm.startsWith(fpNorm) ? spNorm.slice(fpNorm.length) : spNorm.split("/").pop() ?? fullPath;
}

/** Réponse de `expand_context_folder` / `expand_context_workspace` (cf. context.rs). */
interface ContextExpansionFile { name: string; path: string; rel: string; content: string; skipped: boolean }
interface ContextExpansion { files: ContextExpansionFile[]; truncated: boolean; included: number }

/** Réponse de `read_rule` (cf. extensions_store.rs). */
interface RuleContent { name: string; content: string; scope: string }

/**
 * Formate les diagnostics LSP en bloc texte pour `#Problems`.
 * Groupé par fichier, erreur d'abord : le modèle voit d'emblée ce qui casse.
 * Renvoie `""` si aucun problème (on n'injecte alors aucun bruit).
 */
function formatDiagnostics(byFile: Map<string, DiagnosticEntry[]>): string {
  const rows: string[] = [];
  for (const [path, entries] of byFile) {
    if (entries.length === 0) continue;
    const rel = path.split(/[\\/]/).slice(-3).join("/");
    for (const d of entries) {
      rows.push(`${rel}:${d.line}:${d.col} ${d.severity}${d.code ? ` [${d.code}]` : ""} ${d.message}`);
    }
  }
  if (rows.length === 0) return "";
  return `\n\n[Problems — ${rows.length} diagnostic(s)]\n${rows.join("\n")}`;
}

/**
 * Formate une expansion de dossier/workspace en blocs `[File: rel]` + fence.
 * On préfère `rel` (court, lisible) au chemin absolu, et on signale la troncature
 * pour que le modèle sache que la vue est partielle.
 */
function formatExpansion(
  title: string,
  exp: ContextExpansion,
  fenceFor: (name: string) => string,
): string {
  let out = `\n\n[${title} — ${exp.included} file(s)${exp.truncated ? ", truncated" : ""}]`;
  for (const f of exp.files) {
    if (f.skipped) continue;
    out += `\n\n[File: ${f.rel || f.name}]\n\`\`\`${fenceFor(f.name)}\n${f.content}\n\`\`\``;
  }
  return out;
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

/**
 * Vue « surface agent » exportée au parent (mode Agent) pour alimenter les tool
 * panels DiffView / DocView sans dupliquer l'état. Trae fait de même : ces
 * panneaux ne détiennent pas la donnée, ils reflètent la tâche courante.
 */
export interface AgentSurfaceState {
  /** Fichiers du tour de revue courant (bannière Undo/Keep), [] si aucun. */
  reviewFiles: TurnFileDelta[];
  /** Actions du tour courant, absentes si rien n'est annulable. */
  undoAll?: () => Promise<void>;
  keepAll?: () => Promise<void>;
  /** Ouvre le diff avant/après d'un fichier. */
  openDiff?: (file: TurnFileDelta) => void;
  /** Markdown du dernier artefact assistant substantiel (source de DocView). */
  docMarkdown: string;
  /** Plan structuré encore en attente, s'il y en a un. */
  plan?: import("../../lib/agent/planTypes").ParsedPlan | null;
  /**
   * Tool-calls actuellement `running`, dans l'ordre chronologique. Sert au Flow :
   * le parent en déduit l'onglet d'outil à activer automatiquement.
   */
  runningTools: { toolName: string }[];
  /** Un tour d'agent est-il en cours ? Le Flow ne s'active que dans ce cas. */
  isRunning: boolean;
}

interface AiPanelProps {
  getEditorContext?: () => EditorContext | null;
  getActiveFilePath?: () => string | null;
  forcedContext?: EditorContext | null;
  onForcedContextConsumed?: () => void;
  getFileContents?: () => Record<string, string>;
  onOpenDiffTab?: (data: AiDiffTabInput) => void;
  /**
   * Rafraîchit l'éditeur après une action EXTERNE qui modifie des fichiers sur
   * disque (typ. « Undo all » / revert de l'agent) : les chemins concernés sont
   * relus (ou leur onglet fermé s'ils ont été supprimés). Indispensable pour que
   * l'éditeur n'affiche jamais un contenu que l'agent vient d'annuler.
   */
  onExternalFileChanges?: (paths: string[]) => Promise<void>;
  /** Ouvre un fichier du workspace dans l'éditeur (clic sur un chemin dans le chat). */
  onOpenFile?: (path: string, line?: number, col?: number) => void;
  /** Exécute une commande d'un bloc shell du chat dans le terminal (bouton `Run`). */
  onRunCommand?: (command: string) => void;
  /** Insère un texte dans le terminal actif, sans l'exécuter. */
  onInsertTerminal?: (text: string) => void;
  /**
   * Ouvre le sélecteur de répertoire natif (définit le workspace courant).
   * Utilisé pour FORCER le choix d'un dossier de travail avant de lancer
   * l'agent : sans workspace, l'agent tournerait sur un cwd arbitraire.
   */
  onOpenFolder?: () => void;
  /** When set (and changed), the panel loads the given session id. Driven by the Agent mode task rail. */
  openSessionId?: string | null;
  /** Incrementing counter that triggers a fresh chat (Agent mode "New Task"). */
  newChatNonce?: number;
  /** Notifies the host when the active session changes (created, selected, cleared). */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /**
   * Expose au parent (mode Agent) l'état de la « surface agent » : fichiers en
   * revue + actions Undo/Keep + dernier document. Permet aux tool panels
   * DiffView / DocView de refléter la conversation sans détenir d'état parallèle
   * (le parent ne fait que déléguer l'affichage). Inutilisé en mode sidebar.
   */
  onAgentSurface?: (state: AgentSurfaceState) => void;
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
  getFileContents, onOpenDiffTab, onOpenFile,
  onRunCommand, onInsertTerminal,
  onExternalFileChanges, onOpenFolder,
  openSessionId = null,
  newChatNonce = 0,
  onActiveSessionChange,
  onAgentSurface,
  renderMode = "sidebar",
}: AiPanelProps) {
  const { folderPath, setFolderPath } = useWorkspace();
  // Session Mira : sans elle, l'agent n'a aucun modèle à qui parler. On
  // l'utilise comme GARDE-FOU à l'envoi (cf. `handleSend`) et pour piloter
  // l'affichage de l'état vide (invitation à se connecter).
  const { signedIn } = useAccount();
  // `handleSend` est mémoïsé : on lit la connexion via une ref pour que le
  // garde-fou reste exact même si `signedIn` change après la mémoïsation.
  const signedInRef = useRef(signedIn);
  useEffect(() => { signedInRef.current = signedIn; }, [signedIn]);
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  useEffect(() => { onActiveSessionChangeRef.current = onActiveSessionChange; }, [onActiveSessionChange]);

  const isAgent = renderMode === "agent";
  // Diagnostics LSP : source du contexte `#Problems`.
  const diagnostics = useDiagnostics();
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
  // Message saisi pendant un tour en cours, envoyé automatiquement à la fin
  // (fin normale, erreur ou stop). Un seul message en attente, comme Trae.
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(null);
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
  // MULTITASKING : l'état du run (seq, buffers, cleanup, timer, miroir) vit
  // désormais PAR SESSION dans `runState` (cf. `getRun`). Plus de refs
  // mono-instance ici : plusieurs tâches peuvent tourner en parallèle.
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
  const getActiveFilePathRef       = useRef(getActiveFilePath);
  const onOpenDiffTabRef           = useRef(onOpenDiffTab);
  const currentModeRef             = useRef<"agent" | "plan">("agent");
  // Agent personnalisé actif au moment de l'envoi (résolu depuis la sélection
  // persistée + la liste chargée). `null` = aucun agent perso (mode intégré).
  const activeAgentRef             = useRef<CustomAgent | null>(null);
  // Modèle/provider du dernier envoi : « régénérer » rejoue avec la même cible
  // sans dépendre d'un état local exposé par le ChatBox.
  const activeModelIdRef           = useRef<string>("");
  const activeProviderIdRef        = useRef<string>("");
  const phase1ContentRef           = useRef<string>("");
  const startPlanExecutionRef      = useRef<(() => Promise<void>) | null>(null);
  // Miroir de `handleSend` : permet de relancer un envoi (dépilage de la file)
  // depuis les handlers de fin de tour sans créer de dépendance circulaire dans
  // les `useCallback` (pattern « ref mirroring » utilisé pour les callbacks
  // sensibles de ce fichier).
  const handleSendRef              = useRef<((text: string, modelId: string, providerId: string, fileMentions: string[], editorContext: EditorContext | null, mode: "agent" | "ask" | "plan", contextRefs: ContextRef[]) => Promise<void>) | null>(null);
  // Empêche un double dépilage (ex. `finish` suivi immédiatement d'un stop).
  const dequeuingRef               = useRef<boolean>(false);
  // Miroir réactif de `queuedMessage` : `flushQueue` est appelé depuis des
  // handlers stables (events du stream) qui ne peuvent pas dépendre de l'état.
  const queuedMessageRef           = useRef<QueuedMessage | null>(null);

  // Checkpoint du tour courant : id + fichiers capturés (pour la bannière Undo/Keep).
  const activeTurnIdRef            = useRef<string | null>(null);
  // Index du message utilisateur du tour courant : c'est la PORTÉE consignée
  // dans la bannière, utilisée par « Undo all » pour agir sur le bon run.
  const activeTurnUserIndexRef     = useRef<number | null>(null);
  // Tour ↔ message utilisateur : chaque envoi ouvre un checkpoint et l'associe à
  // l'index du message utilisateur qui l'a déclenché. Reverter un message = agir
  // sur TOUS les tours générés depuis lui (un run pouvant couvrir plusieurs
  // envois), ce qui n'était pas possible avec un unique turnId courant.
  const turnIdsByUserIndexRef      = useRef<Map<number, string[]>>(new Map());
  // La bannière porte AUSSI l'index du message utilisateur du run : c'est lui
  // qui définit la PORTÉE d'un « Undo all » (tous les tours générés depuis ce
  // message). Sans cela, « Undo all » devinait le tour visé (dernier index connu)
  // et pouvait annuler un autre run — l'instabilité signalée.
  const [reviewBanner, setReviewBanner] = useState<{ turnId: string; userIndex: number; files: TurnFileDelta[] } | null>(null);
  // Marqueurs « gardé » par index de message utilisateur : après un Keep all (ou
  // un Keep par message), on garde une trace VISUELLE persistante plutôt qu'un
  // simple toast éphémère (demande explicite : « Keep all ne marque rien
  // visuellement »). On fige le résumé des fichiers au moment du Keep — sinon,
  // le checkpoint étant purgé, on ne saurait plus quoi afficher.
  const [keptReviews, setKeptReviews] = useState<Record<number, TurnFileDelta[]>>({});
  // Index (par message utilisateur) possédant au moins un checkpoint actif —
  // donc éligible à Undo/Keep. On le duplique en STATE réactif car
  // `turnIdsByUserIndexRef` est une ref : la modifier ne déclenche pas de
  // re-render, et les boutons par message n'apparaîtraient pas de façon fiable.
  const [revertableIndexes, setRevertableIndexes] = useState<number[]>([]);
  // Dialogue de confirmation de revert : affiche la liste des fichiers qui seront
  // supprimés (créés pendant le run) ou restaurés (modifiés) avant validation.
  const [revertConfirm, setRevertConfirm] = useState<{ userIndex: number; plan: RevertPlanEntry[] } | null>(null);

  // ── Persistance de la revue : le DISQUE est la source de vérité ──────────
  // `turnIdsByUserIndexRef`, `keptReviews` et `revertableIndexes` vivent en
  // mémoire React et sont perdus au rechargement, alors que les checkpoints
  // survivent sur disque. On rejoue donc `checkpoint_list_turns` (tours encore
  // non consommés) pour reconstruire l'état de revue : chaque tour encore
  // présent redevient visible (bannière réaffichée) et annulable (Undo/Keep par
  // message), au lieu de disparaître silencieusement. Les marqueurs « gardé »
  // sont eux aussi persistés par message, car un checkpoint gardé n'existe plus
  // sur disque et serait sinon irrécupérable.
  const reviewsStorageKey = useCallback(
    (fp: string) => `origin.reviews.v1::${fp}`,
    [],
  );

  // Reconstruit l'état de revue depuis le disque. Appelé au montage et à chaque
  // changement de conversation : les tours encore présents redeviennent
  // annulables, et les marqueurs « gardé » sont restaurés depuis le stockage
  // local. On ne réaffiche la bannière QUE si des tours subsistent (sinon, une
  // bannière vide traînerait après un Keep).
  const hydrateReviews = useCallback(async () => {
    const fp = folderPathRef.current ?? "";
    // 1. Marqueurs « gardé » persistés (un checkpoint gardé n'existe plus sur
    //    disque : c'est le seul moyen de les retrouver après un reload).
    if (fp) {
      try {
        const raw = localStorage.getItem(reviewsStorageKey(fp));
        setKeptReviews(raw ? (JSON.parse(raw) as Record<number, TurnFileDelta[]>) : {});
      } catch { setKeptReviews({}); }
    } else {
      setKeptReviews({});
    }
    // 2. Tours encore présents sur disque → reconstruit le suivi et l'ensemble
    //    des index annulables. On réassocie chaque tour au PLUS GRAND index de
    //    message utilisateur dont la génération le couvre ; faute de corrélation
    //    parfaite après reload, on rattache tous les tours orphelins au dernier
    //    message utilisateur — c'est le seul point d'ancrage fiable, et « Undo
    //    all » agira alors sur l'ensemble du run, ce qui reste correct.
    const records = await listTurnCheckpoints().catch(
      () => [] as { turnId: string; count: number; paths: string[] }[],
    );
    const msgs = messagesRef.current;
    let lastUserIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIndex = i; break; }
    }
    const { byUser, revertable } = hydrateTurns(records.map(r => r.turnId), lastUserIndex);
    turnIdsByUserIndexRef.current = byUser;
    setRevertableIndexes(revertable);
    activeTurnIdRef.current = null;
    activeTurnUserIndexRef.current = null;
    if (records.length === 0 || lastUserIndex < 0) {
      setReviewBanner(null);
      return;
    }
    // Réaffiche la bannière du dernier tour encore présent (le plus récent).
    const latest = records[records.length - 1];
    try {
      const files = await summaryTurnCheckpoint(latest.turnId);
      if (files.length > 0) {
        setReviewBanner({ turnId: latest.turnId, userIndex: lastUserIndex, files });
      } else {
        setReviewBanner(null);
      }
    } catch { setReviewBanner(null); }
  }, [reviewsStorageKey]);
  // Question de l'agent en attente de réponse (`ask_user`). Le run est EN PAUSE
  // tant qu'elle n'est pas résolue. On la garde ici pour la dockser AU-DESSUS de
  // l'input (là où l'utilisateur regarde), plutôt que de la perdre dans le fil.
  const [pendingQuestion, setPendingQuestion] = useState<{ id: string; question: string; options: string[]; answer: (a: string) => void } | null>(null);

  // Miroir de `onExternalFileChanges` : les handlers de revert (mémorisés) y
  // accèdent sans dépendre de l'identité du callback du parent.
  const externalFileChangesRef      = useRef(onExternalFileChanges);
  useEffect(() => { externalFileChangesRef.current = onExternalFileChanges; }, [onExternalFileChanges]);

  // Miroir réactif de `activeSessionIdRef` : le rendu (todo list épinglée) a
  // besoin de la session courante comme état, pas comme ref.
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const setActiveSessionId = useCallback((id: string | null) => {
    activeSessionIdRef.current = id;
    setActiveSessionIdState(id);
    // La jauge de contexte dépend du résumé de compaction persisté PAR session :
    // au changement de conversation, on force son recalcul.
    setCompactionVersion((v) => v + 1);
  }, []);

  // ── Mode applicatif de la conversation (parité Trae) ─────────────────────
  // Trae garantit qu'une conversation ne perd RIEN quand on bascule IDE↔AI : le
  // mode de CRÉATION de la conversation fait foi à la reprise, quel que soit le
  // layout courant. On mémorise donc ce mode (en base, colonne `app_mode`) et on
  // reflète ici la valeur de la conversation active. `null` = conversation neuve
  // ou héritée d'avant la migration → on retombe sur le mode du layout courant,
  // ce qui préserve la dégradation gracieuse. La ref est la source de vérité
  // (lue par la boucle d'envoi, potentiellement asynchrone).
  const sessionAppModeRef = useRef<'ide' | 'ai' | null>(null);
  const setSessionAppMode = useCallback((m: 'ide' | 'ai' | null) => {
    sessionAppModeRef.current = m;
  }, []);
  // Réhydrate le mode depuis la base au profit de la conversation active (et le
  // renseigne en secours si `NULL`). Non bloquant : l'appelant n'attend pas.
  const loadSessionAppMode = useCallback(async (sessionId: string) => {
    try {
      let am = await getSessionAppMode(sessionId);
      if (am === null) {
        // Session héritée : on fige le mode courant comme mode de création pour
        // que les prochaines reprises soient stables dans le temps.
        am = isAgent ? 'ai' : 'ide';
        await persistSessionAppMode(sessionId, am);
      }
      // Pas de réactivité nécessaire : la valeur n'est relue qu'au prochain envoi.
      if (activeSessionIdRef.current === sessionId) sessionAppModeRef.current = am;
    } catch (err) {
      console.error("[AiPanel] loadSessionAppMode failed:", err);
    }
  }, [isAgent]);

  // Télémétrie du tour : nb de compactions / reprises automatiques, et dernier
  // gain de tokens obtenu par compaction. Affichée en pied de fil.
  const [telemetry, setTelemetry] = useState<{ compaction: number; retry: number; lastSavedTokens?: number }>(
    { compaction: 0, retry: 0 },
  );
  // Vote (pouce haut/bas) par index de message. Éphémère — il vit le temps de la
  // session et ne prétend pas persister un feedback durable (pas de télémétrie
  // sortante). Il sert d'indicateur visuel immédiat.
  const [feedbackByIndex, setFeedbackByIndex] = useState<Record<number, "up" | "down">>({});
  // Surface d'extension de la session courante (skills découvertes, slash-
  // commands runtime, diagnostics non fatals). Résolue par le sidecar au `start`
  // et remontée via `onExtensions` : on l'affiche telle quelle dans l'input au
  // lieu de coder des skills/commandes en dur. Effacée à chaque session NEUVE.
  const [sessionExtensions, setSessionExtensions] = useState<ClineSessionExtensions | null>(null);
  // `setTelemetry` (useState) est stable : on le garde en ref pour que les
  // closures de `handleSend` (mémorisées) y accèdent sans dépendre de lui.
  const setTelemetryRef = useRef(setTelemetry);
  /**
   * Incrémenté à chaque écriture/effacement du résumé de compaction. Force le
   * recalcul de la jauge de contexte, dont la valeur dépend d'un stockage local
   * (hors du graphe React) que rien d'autre ne signalerait.
   */
  const [compactionVersion, setCompactionVersion] = useState(0);

  // Usage du contexte courant : estimation (chars/4 + overhead) de CE QUI EST
  // RÉELLEMENT ENVOYÉ au modèle. Quand une compaction manuelle a persisté un
  // résumé, la tête ancienne n'est plus envoyée : on ne compte donc que la
  // fenêtre récente (+ le résumé lui-même). Sans cela la jauge continuerait
  // d'afficher la taille du fil AFFICHÉ (intact) et ignorerait le gain réel.
  // `compactionVersion` force le recalcul quand le résumé persisté change.
  const contextTokens = useMemo(() => {
    const full = buildModelHistory(messages.filter(m => !m.streaming));
    const stored = readCompactionSummary(activeSessionIdRef.current);
    if (!stored) return estimateTokensWithOverhead(full);
    const start = recentWindowStart(full, PRESERVE_RECENT_TOKENS, estimateTokens);
    const tail = start > 0 && start < full.length ? full.slice(start) : full;
    return estimateTokensWithOverhead(withCompactionSummary(tail, stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, compactionVersion]);

  /**
   * Compaction MANUELLE, déclenchée par l'utilisateur (bouton « Compact » du
   * menu de la jauge de contexte).
   *
   * DEUX ÉTAGES, DANS CET ORDRE
   * ---------------------------
   *  1. NETTOYAGE DÉTERMINISTE (gratuit, instantané, sans LLM) : `compactHistory`
   *     retire les `read_file` périmés, puis `compactLargeToolResults` vide les
   *     tool results VOLUMINEUX anciens (terminal, recherche, listing…). C'est ce
   *     qui manquait : sans lui, une session d'écritures n'avait « rien à
   *     compacter » et le bouton semblait inerte.
   *  2. RÉSUMÉ SÉMANTIQUE (LLM) : l'historique ancien restant est résumé en un
   *     bloc structuré et remplacé, la fenêtre récente (~20 000 tokens) restant
   *     verbatim. C'est la vraie compaction façon Trae : la jauge chute franchement.
   *
   * CE QUI EST ÉCRIT DANS LE FIL
   * ----------------------------
   * Les BULLES restent intactes (choix produit : on ne réécrit pas l'historique
   * affiché) ; une bannière de statut rend le résultat visible et chiffré. Le
   * contexte RÉELLEMENT envoyé au modèle, lui, est bien réduit (étage 1 + 2).
   *
   * SÉCURITÉ / INTÉGRITÉ
   * --------------------
   *  - Jamais pendant une génération (`isStreaming`) : on ne réécrit pas un fil
   *    en cours de production.
   *  - L'étage 2 ne touche jamais le dernier message ni la fenêtre récente, et
   *    un échec de résumé laisse l'historique INTACT (aucune perte de contexte).
   *  - La clé d'API ne sert qu'à l'appel de résumé et n'est jamais journalisée ;
   *    un résumé ne part qu'après une action EXPLICITE de l'utilisateur.
   *  - Compatible mode local : si le provider est local, il n'y a pas de clé et
   *    l'étage 2 est simplement sauté (l'étage 1 reste appliqué).
   */
  const handleManualCompact = useCallback(async () => {
    if (isStreaming) return;
    const current = messagesRef.current.filter(m => !m.streaming);
    const beforeTokens = estimateTokensWithOverhead(buildModelHistory(current));

    // ── Étage 1 : nettoyage déterministe (read_file périmés + gros tool results).
    const stale = findStaleReads(buildModelHistory(current));
    const displayAfterStale = compactDisplayMessages(current, stale, mutatedPathsOf(current));
    const modelAfterStale = compactLargeToolResults(
      compactHistory(buildModelHistory(displayAfterStale)),
    );
    const afterStage1 = estimateTokensWithOverhead(modelAfterStale);
    const saved1 = Math.max(0, Math.round(beforeTokens - afterStage1));

    // ── Étage 2 : résumé LLM de l'historique ancien (hors fenêtre récente).
    // Le résumé remplace la TÊTE de l'historique modèle ; la fenêtre récente
    // reste verbatim. En cas d'échec (pas de clé, provider muet), on garde
    // l'historique de l'étage 1 tel quel — jamais de perte de contexte.
    let summarySaved = 0;
    let summaryApplied = false;
    try {
      const providerId = activeProviderIdRef.current;
      const modelId = activeModelIdRef.current;
      // Résout la clé d'UI vers l'id réel attendu par l'API (Mira / custom).
      const miraRef = await resolveMiraModel(providerId);
      const apiModelId = miraRef?.modelId ?? findCustomModel(providerId)?.modelId ?? modelId;
      // La clé est celle du PROVIDER : pour un modèle Mira, c'est la clé Mira
      // (`orvyx`), jamais celle saisie par le client pour ce modèle.
      const apiKey = await loadApiKey(miraRef?.providerId ?? providerId);
      const isLocal = LOCAL_PROVIDERS.has(providerId);
      if (providerId && apiModelId && (apiKey || isLocal)) {
        const model = buildLanguageModel(miraRef?.providerId ?? providerId, apiModelId, apiKey ?? "", miraRef?.baseUrl);
        const res = await summarizeHistory(
          modelAfterStale,
          PRESERVE_RECENT_TOKENS,
          estimateTokens,
          async (transcript, signal) => {
            const { text } = await generateText({
              model, system: SUMMARY_SYSTEM_PROMPT, prompt: transcript, abortSignal: signal,
            });
            return text;
          },
        );
        if (res) {
          summaryApplied = true;
          summarySaved = Math.max(0, Math.round(afterStage1 - estimateTokensWithOverhead(res.compacted)));
          // Le résumé est PERSISTÉ par session : il sera réinjecté en tête de
          // l'historique à chaque tour suivant, et survivra à un rechargement.
          const sid = activeSessionIdRef.current;
          if (sid) {
            writeCompactionSummary(sid, {
              summary: res.info.summary,
              coveredCount: res.info.coveredCount,
              at: Date.now(),
            });
            // La jauge lit le résumé depuis le stockage local : on la force à se
            // recalculer pour qu'elle reflète immédiatement le gain réel.
            setCompactionVersion(v => v + 1);
          }
        }
      }
    } catch {
      // Un échec de résumé ne doit jamais casser la compaction déterministe.
      summaryApplied = false;
    }

    const saved = saved1 + summarySaved;
    const detail = summaryApplied
      ? (stale.size > 0
          ? "Contexte compacté — lectures périmées nettoyées puis historique ancien résumé"
          : "Contexte compacté — historique ancien résumé")
      : (stale.size > 0
          ? "Contexte compacté — lectures périmées et résultats volumineux nettoyés"
          : "Contexte compacté — résultats d'outils volumineux nettoyés");
    const statusPart: MessagePart = {
      type: "status", kind: "compaction", detail, savedTokens: saved,
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
    const sid = activeSessionIdRef.current;
    if (sid) setRunMessages(sid, messagesRef.current);
  }, [isStreaming, setCompactionVersion]);

  // Ouvre un checkpoint pour un nouveau tour d'agent. Best-effort : l'échec
  // n'empêche jamais le tour de se dérouler (le mode Ask n'écrit rien sur disque).
  // Le turnId est associé à l'index du message utilisateur qui a déclenché ce
  // tour : reverter ce message agira sur TOUS les tours générés depuis lui.
  // Contrairement à l'ancien comportement, on ne purge PAS le checkpoint du tour
  // précédent (sinon revert ne saurait restaurer que le tout dernier run).
  const beginTurn = useCallback((userIndex: number) => {
    const id = crypto.randomUUID();
    activeTurnIdRef.current = id;
    activeTurnUserIndexRef.current = userIndex;
    getRun(activeSessionIdRef.current).dirty = false;
    const byUser = turnIdsByUserIndexRef.current;
    const list = byUser.get(userIndex);
    if (list) list.push(id);
    else byUser.set(userIndex, [id]);
    setRevertableIndexes(prev => (prev.includes(userIndex) ? prev : [...prev, userIndex]));
    setReviewBanner(null);
    void beginTurnCheckpoint(id).catch(() => {});
  }, []);

  // Snapshot d'un fichier avant sa première écriture du tour (idempotent).
  const touchTurn = useCallback((path: string, ws: string) => {
    const id = activeTurnIdRef.current;
    if (!id) return;
    void touchTurnFile(id, path, ws).catch(() => {});
    // L'agent vient d'écrire (ou va écrire) ce fichier : on prévient
    // l'explorateur pour qu'il recharge le dossier parent, sans recharger tout
    // l'arbre. `path` est déjà confiné au workspace en amont ; le bus et
    // `useExplorer` refiltrent de toute façon. On ne rafraîchit PAS quand le
    // checkpoint est inactif (aucune écriture réelle n'a suivi) — l'appel est
    // donc bien conditionné à une écriture effective.
    notifyExplorerDirsChanged([parentOf(path)]);
  }, []);

  // ── Revue des fichiers « live » (pattern Trae) ───────────────────────────
  // La bannière « N files changed » + « Keep all / Undo all » doit être visible
  // DÈS la première écriture et rester affichée, en se mettant à jour au fil du
  // run — pas seulement au `finish`. On rafraîchit donc le résumé du tour en
  // continu, mais de façon debounced : les outils d'écriture peuvent se
  // succéder, on ne veut pas un aller-retour Rust par event.
  const reviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshReview = useCallback((turnId: string, immediate = false) => {
    const run = () => {
      summaryTurnCheckpoint(turnId)
        .then(files => {
          // Le tour a pu changer entre-temps (nouvel envoi) : on ignore un
          // résumé obsolète pour ne jamais afficher les fichiers d'un autre run.
          if (activeTurnIdRef.current !== turnId) return;
          const userIndex = activeTurnUserIndexRef.current;
          if (userIndex === null) return;
          if (files.length > 0) setReviewBanner({ turnId, userIndex, files });
        })
        .catch(() => {});
    };
    if (reviewTimerRef.current) clearTimeout(reviewTimerRef.current);
    if (immediate) { reviewTimerRef.current = null; run(); return; }
    reviewTimerRef.current = setTimeout(() => { reviewTimerRef.current = null; run(); }, 120);
  }, []);

  // Idem, mais SANS annuler un timer de rafraîchissement déjà programmé. Utilisé
  // par « Keep all » PENDANT un run : on rafraîchit tout de suite (retour visuel
  // immédiat) tout en laissant le timer de fond continuer à capturer les
  // écritures qui suivent — sinon la bannière pourrait ne plus jamais réapparaître.
  const refreshReviewNow = useCallback((turnId: string) => {
    summaryTurnCheckpoint(turnId)
      .then(files => {
        if (activeTurnIdRef.current !== turnId) return;
        const userIndex = activeTurnUserIndexRef.current;
        if (userIndex === null) return;
        if (files.length > 0) setReviewBanner({ turnId, userIndex, files });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { ensurePricing().catch(() => {}); }, []);
  useEffect(() => { folderPathRef.current = folderPath; }, [folderPath]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  /**
   * Historique des messages utilisateur (du plus ancien au plus récent) pour la
   * navigation ↑/↓ dans l'input. On lit la source de vérité `messagesRef` pour
   * éviter de recréer la callback (et re-rendre ChatBox) à chaque message.
   */
  const getUserHistory = useCallback((): string[] => {
    const out: string[] = [];
    for (const m of messagesRef.current) {
      if (m.role === "user" && !m.streaming && m.content.trim()) out.push(m.content);
    }
    return out;
  }, []);
  useEffect(() => { getActiveFilePathRef.current = getActiveFilePath; }, [getActiveFilePath]);
  useEffect(() => { onOpenDiffTabRef.current = onOpenDiffTab; }, [onOpenDiffTab]);

  useEffect(() => {
    const fp = folderPath ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load persisted state for the current folder
    setPinnedMessages(pbRead(fp));
    setNotesValue(localStorage.getItem(NOTES_KEY(fp)) ?? "");
  }, [folderPath]);

  // Chargement AUTOMATIQUE de la surface d'extension (skills, slash-commands) dès
  // qu'un workspace est connu, SANS attendre le premier envoi. Sinon l'input
  // afficherait « aucun skill » tant qu'aucune session n'a démarré. On relance
  // aussi à chaque changement de workspace (les skills sont projet-scopées) et
  // sur l'événement `EXTENSIONS_CHANGED_EVENT` (mutation depuis les Settings).
  // Course possible avec `onExtensions` (résolution au `start`) : les deux
  // écrivent la même forme normalisée, le dernier arrivé gagne — inoffensif.
  useEffect(() => {
    const fp = folderPath ?? "";
    if (!fp) return;
    let cancelled = false;
    const reload = () => {
      listClineExtensions(fp)
        .then((ext) => { if (!cancelled) setSessionExtensions(ext); })
        .catch(() => {});
    };
    reload();
    window.addEventListener(EXTENSIONS_CHANGED_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(EXTENSIONS_CHANGED_EVENT, reload);
    };
  }, [folderPath]);

  // Reconstruction de l'état de revue au démarrage et à chaque changement de
  // dossier/projet : le disque redevient la source de vérité (cf. hydrateReviews).
  // On attend le tick suivant le mount pour que `messagesRef` porte l'historique
  // rechargé — sinon le dernier message utilisateur ne serait pas encore connu.
  useEffect(() => {
    const timer = setTimeout(() => { void hydrateReviews(); }, 0);
    return () => clearTimeout(timer);
  }, [folderPath, hydrateReviews]);

  // Persiste les marqueurs « gardé » (par message) : sans cela, un Keep
  // disparaîtrait de l'UI après un rechargement, car son checkpoint n'existe
  // plus sur disque.
  useEffect(() => {
    const fp = folderPathRef.current ?? "";
    if (!fp) return;
    try { localStorage.setItem(reviewsStorageKey(fp), JSON.stringify(keptReviews)); } catch { /* quota */ }
  }, [keptReviews, reviewsStorageKey, folderPath]);

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

  // Copie propre : une sélection à la souris dans le fil ne doit PAS embarquer
  // le HTML rendu du markdown (balises, styles inline). On réécrit le
  // presse-papier en texte brut ; hors de la zone des messages, on laisse le
  // comportement natif (l'éditeur, par ex., garde sa propre copie).
  const handleThreadCopy = useCallback((e: React.ClipboardEvent) => {
    handleMessageAreaCopy(e, scrollContainerRef.current);
  }, []);

  // Copie de TOUTE la conversation en texte brut (markdown source, sans balises
  // ni style). Donne un transcript lisible et collable partout.
  const [conversationCopied, setConversationCopied] = useState(false);
  const handleCopyConversation = useCallback(async () => {
    const parts = messagesRef.current
      .filter(m => (m.content ?? "").trim() !== "")
      .map(m => `${m.role === "user" ? "You" : "Agent"}:\n${m.content.trim()}`);
    if (parts.length === 0) return;
    try {
      await navigator.clipboard.writeText(parts.join("\n\n"));
      setConversationCopied(true);
      setTimeout(() => setConversationCopied(false), 1200);
    } catch { /* presse-papier indisponible — on ignore */ }
  }, []);

  useEffect(() => {
    const fp = folderPath ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load persisted sessions for the current folder
    setSessions(lsForPath(fp));

    if (!isFirstFolderEffect.current) {
      // Project switched — les sessions d'un autre projet n'ont plus de sens :
      // on coupe TOUS les runs vivants, quel que soit le projet d'origine.
      // MULTITASKING : plusieurs runs peuvent coexister, on les purge tous.
      const leaving = getRun(activeSessionIdRef.current);
      if (leaving.flushTimer) { clearTimeout(leaving.flushTimer); leaving.flushTimer = null; }
      const prevDbId = leaving.pendingAssistantDbId;
      if (prevDbId) {
        leaving.pendingAssistantDbId = null;
        updateMessageContent(prevDbId, leaving.pendingContent, "interrupted").catch(() => {});
      }
      for (const id of listLiveRuns()) {
        // MULTITASKING : on marque « interrupted » AVANT de purger l'état, sinon
        // le rail garderait ces tâches éternellement « running » (le registre de
        // statut est indépendant de `runState`).
        getRun(id).task?.interrupt();
        forgetRun(id);
      }
      setMessages([]);
      setActiveSessionId(null);
      setSessionAppMode(null);
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
          // Même priorité que `handleSessionSelect` : si un run VIVANT existe pour
          // cette session dans le process, son miroir mémoire est plus FRAIS que
          // la DB (le stream n'est flushé qu'au fil de l'eau). C'est ce qui évite
          // le « tout est mélangé » au changement de mode : sans cela, l'instance
          // neuve relisait une DB en retard et réaffichait un fil incohérent.
          const mirror = getRunMessages(storedId);
          const live = getRun(storedId).cleanup !== null;
          if (mirror && live) {
            dbIdsRef.current = mirror.map(m => m.dbId ?? null);
            setMessages(mirror);
            setActiveSessionId(storedId);
            setChatView("chat");
            localStorage.setItem("origin-ai-chat-view", "chat");
            void loadSessionAppMode(storedId);
            return;
          }
          const displayMsgs = await restoreSession(storedId);
          if (cancelled) return;
          if (displayMsgs.length > 0) {
            dbIdsRef.current = displayMsgs.map(m => m.dbId ?? null);
            setMessages(displayMsgs);
            setActiveSessionId(storedId);
            setChatView("chat");
            localStorage.setItem("origin-ai-chat-view", "chat");
            void loadSessionAppMode(storedId);
          }
        } catch (err) {
          console.error("[AiPanel] DB session restore failed:", err);
        }
      })();
    }
    return () => { cancelled = true; };
  }, [folderPath, setActiveSessionId, setSessionAppMode, loadSessionAppMode]);

  const handleSessionSelect = useCallback(async (sessionId: string) => {
    const prevSessionId = activeSessionIdRef.current;
    // MULTITASKING (parité Trae) : changer de tâche n'interrompt PLUS le run en
    // cours. Si une autre tâche travaille, on mémorise son fil pour pouvoir le
    // réafficher en flux direct à la reprise, et on la laisse vivre en arrière-plan.
    if (prevSessionId && prevSessionId !== sessionId) {
      setRunMessages(prevSessionId, messagesRef.current);
    }
    // Plus de cleanup du run courant : il continue en arrière-plan.

    setActiveSessionId(sessionId);
    const fp = folderPathRef.current ?? "";
    localStorage.setItem(activeSessionKey(fp), sessionId);
    onActiveSessionChangeRef.current?.(sessionId);
    setMessages([]);
    setChatView("chat");
    localStorage.setItem("origin-ai-chat-view", "chat");
    // Le mode suit la conversation : on relit le mode mémorisé de la conv reprise.
    void loadSessionAppMode(sessionId);

    try {
      // Si la session visée a un run EN COURS dans ce process, on réaffiche son
      // miroir en direct (le flux se poursuit) plutôt que de relire une DB en
      // retard sur le stream. Sinon, rechargement normal depuis la DB.
      const mirror = getRunMessages(sessionId);
      const live = getRun(sessionId).cleanup !== null;
      if (mirror && live) {
        dbIdsRef.current = mirror.map(m => m.dbId ?? null);
        setMessages(mirror);
        return;
      }
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
  }, [setActiveSessionId, loadSessionAppMode]);

  /**
   * Envoie le message en attente si présent. Appelé à la fin d'un tour (fin,
   * erreur ou stop) pour enchaîner automatiquement. Le flag `dequeuingRef`
   * évite un double envoi lorsque plusieurs signaux de fin se chevauchent.
   */
  const flushQueueRef = useRef<(() => void) | null>(null);

  /**
   * Émet une notification de tâche (toast + son) en respectant les préférences
   * et les règles anti-bruit. Centralise l'appel à `planNotification` : la
   * décision « faut-il notifier ? » reste testable hors React (cf. notify.ts).
   *
   * `displayedId` permet de savoir si la tâche concernée est celle AFFICHÉE :
   * une tâche qui se termine en arrière-plan mérite une alerte, celle qu'on
   * regarde se voit déjà dans le fil.
   */
  const notifyTask = useCallback((
    kind: "finish" | "question" | "error" | "stop",
    sessionId: string,
    opts?: { errorMessage?: string },
  ) => {
    const fp = folderPathRef.current ?? "";
    const label = lsForPath(fp).find(s => s.id === sessionId)?.title || "Task";
    const plan = planNotification(kind, {
      taskLabel: label,
      isDisplayed: activeSessionIdRef.current === sessionId,
      errorMessage: opts?.errorMessage,
      toastEnabled: isToastEnabled(),
      soundEnabled: isSoundEnabled(),
    });
    if (plan.playSound) playSound(plan.playSound);
    if (plan.toast) showToast(plan.toast.text, plan.toast.type);
  }, [showToast]);

  /**
   * Résout les références de contexte `#` en un bloc de texte injectable.
   *
   * ── Pourquoi ici et pas dans ChatBox ────────────────────────────────────────
   * ChatBox ne connaît que la *référence* (`#Folder src`, `#Rule project:x`) : il
   * lui manque le disque et les diagnostics. La résolution est donc faite au
   * moment de l'envoi, là où l'on dispose du workspace et du contexte LSP.
   *
   * ── Sécurité ────────────────────────────────────────────────────────────────
   *  - `#Folder`/`#Workspace` passent par les commands Rust (`context.rs`) qui
   *    confinent le chemin au workspace et bornent fichiers/octets. On ne lit
   *    JAMAIS d'arborescence arbitraire depuis le front.
   *  - `#Rule` n'accepte qu'une rule déjà listée (identifiant `scope:rel`),
   *    relue via `read_rule` — pas de chemin disque brut.
   *  - `#Problems` vient des diagnostics déjà calculés (aucun accès disque).
   *  - `#Code` est la sélection éditeur déjà capturée par l'app.
   * Un échec de résolution est TOLÉRÉ (on l'ignore) : un contexte indisponible ne
   * doit jamais faire échouer l'envoi du message.
   */
  const resolveContextRefs = useCallback(async (
    refs: ContextRef[],
    wsRoot: string,
    editorContext: EditorContext | null,
  ): Promise<string> => {
    if (refs.length === 0) return "";
    let out = "";

    const fenceFor = (name: string): string => {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      return FENCE_MAP[ext] ?? ext;
    };

    for (const ref of refs) {
      try {
        if (ref.kind === "workspace") {
          const exp = await invoke<ContextExpansion>("expand_context_workspace", { workspaceRoot: wsRoot });
          out += formatExpansion(`Workspace: ${wsRoot}`, exp, fenceFor);
        } else if (ref.kind === "folder") {
          if (!ref.path) continue;
          const exp = await invoke<ContextExpansion>("expand_context_folder", { path: ref.path, workspaceRoot: wsRoot });
          out += formatExpansion(`Folder: ${ref.label || ref.path}`, exp, fenceFor);
        } else if (ref.kind === "file") {
          if (!ref.path) continue;
          const content = await readFile(ref.path);
          out += `\n\n[File: ${ref.path}]\n\`\`\`${fenceFor(ref.label || ref.path)}\n${content}\n\`\`\``;
        } else if (ref.kind === "rule") {
          // `path` porte l'identifiant `scope:rel` produit par le RulePicker.
          const [scope, ...rest] = (ref.path ?? "").split(":");
          const relPath = rest.join(":");
          if (!relPath) continue;
          const rule = await invoke<RuleContent>("read_rule", { scope, workspace: wsRoot, relPath });
          out += `\n\n[Rule: ${ref.label || relPath}]\n${rule.content}`;
        } else if (ref.kind === "problems") {
          const block = formatDiagnostics(diagnostics.byFile);
          if (block) out += block;
        } else if (ref.kind === "code") {
          if (editorContext && editorContext.code.trim()) {
            const activePath = getActiveFilePathRef.current?.();
            const rel = activePath ? toWorkspaceRelPath(activePath, wsRoot) : undefined;
            out += `\n\n${buildContextPrefix(editorContext, rel)}`;
          }
        }
      } catch {
        // Contexte indisponible : on l'ignore silencieusement (jamais bloquant).
      }
    }
    return out;
  }, [diagnostics]);

  const handleSend = useCallback(async (
    text: string,
    modelId: string,
    providerId: string,
    fileMentions: string[] = [],
    editorContext: EditorContext | null = null,
    mode: "agent" | "ask" | "plan" = "agent",
    contextRefs: ContextRef[] = [],
  ) => {
    // GARDE-FOU CONNEXION — placé EN TÊTE, avant toute création de session ou de
    // run. Raison : l'agent Mira s'exécute sur nos modèles, donc derrière une
    // session authentifiée. Sans elle, l'appel échouerait plus loin avec un
    // message technique peu clair. On court-circuite ici, on invite l'utilisateur
    // à se connecter, et on n'écrit RIEN (pas de session, pas de bulle, pas
    // d'appel réseau) — ce garde-fou couvre tous les chemins d'entrée : Entrée
    // clavier, bouton d'envoi, régénération, dépilage de la file d'attente.
    if (!signedInRef.current) {
      showToast("Sign in to Mira to start a conversation.", "info");
      requestSignIn();
      return;
    }
    // MULTITASKING : l'état du run est propre à la session (cf. runState.ts).
    // On résout la session AVANT tout : sans session existante, on en crée une
    // d'emblée, ce qui garantit un run isolé par tâche.
    // `handleSend` part TOUJOURS d'une action utilisateur (envoi) : c'est le
    // meilleur moment pour « débloquer » l'AudioContext (exigé par les webviews
    // avant tout son), afin que les notifications sonores suivantes passent.
    primeSound();
    const prevSessionId = activeSessionIdRef.current;
    const sessionId = prevSessionId ?? crypto.randomUUID();
    const run = getRun(sessionId);

    // Nouvelle génération : tout event d'un run antérieur devient périmé et sera
    // ignoré par `handleEvent` (cf. `run.seq`). Incrémenté AVANT l'abort du run
    // précédent pour que ses éventuels events tardifs ne soient jamais acceptés.
    const runSeq = ++run.seq;
    run.cleanup?.();

    // MULTITASKING : on démarre ce tour dans le REGISTRE DE STATUT (taskRuntime).
    // La tâche devient « running » et le rail la voit travailler MÊME si l'UI
    // affiche une autre conversation. Le handle permet de ré-enregistrer l'abort
    // à chaque création de run Cline (cf. runCline) et de clôturer proprement.
    const taskRun: RegisterRunHandle = beginTaskRun(sessionId);
    run.task = taskRun;

    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    const prevDbId = run.pendingAssistantDbId;
    if (prevDbId) {
      run.pendingAssistantDbId = null;
      updateMessageContent(prevDbId, run.pendingContent, "interrupted").catch(() => {});
    }
    run.pendingContent = "";
    run.pendingParts = [];

    // ── Résolution de la CIBLE ───────────────────────────────────────────────
    // `modelId`/`providerId` reçus du ChatBox sont des CLÉS d'UI. Pour un modèle
    // personnalisé ou Mira, la clé n'est PAS l'id réel attendu par l'API.
    // On résout donc ici, une seule fois, l'id à envoyer au moteur.
    const miraTarget = await resolveMiraModel(providerId);
    // Id modèle réellement transmis au provider (id Mira, id custom, ou id brut).
    const apiModelId = miraTarget?.modelId ?? findCustomModel(providerId)?.modelId ?? modelId;
    // Mémorise la cible du tour pour permettre une régénération ultérieure.
    activeModelIdRef.current = modelId;
    activeProviderIdRef.current = providerId;

    // Plus de catalogue de providers hardcodé : `providerId` EST la clé du modèle
    // choisi par le client (ex. `custom-<uuid>`). S'il est inconnu du magasin, la
    // résolution lèvera plus bas — on ne bloque donc pas ici, et on laisse
    // `resolveClineProvider` décider.

    const fp = folderPathRef.current ?? "";
    // GARDE-FOU WORKSPACE : l'agent ne démarre JAMAIS sans dossier de travail.
    // Sans lui, le sidecar recevrait `workspace: "."` (le cwd du process Node) et
    // l'agent écrirait dans un dossier arbitraire, hors du contrôle du client.
    // On ouvre donc le sélecteur natif et on interrompt l'envoi : l'utilisateur
    // choisit son répertoire, puis renvoie son message.
    if (!fp) {
      showToast("Select a working directory to start the agent.", "info");
      onOpenFolder?.();
      return;
    }
    const sourceFilePath = fileMentions.length === 1
      ? fileMentions[0]
      : (getActiveFilePathRef.current?.() ?? undefined);

    // ── UI optimiste ─────────────────────────────────────────────────────────
    // On affiche la bulle utilisateur ET la bulle assistant (« streaming ») AVANT
    // le moindre await : le feedback est instantané, et tout le travail lent
    // (clé API, DB, lecture des fichiers mentionnés) se fait pendant que l'UI est
    // déjà à jour. `handleEvent` garde de toute façon `run.seq` pour ignorer
    // les events d'un run périmé.
    const userMsg: DisplayMessage = {
      role: "user", content: text, sourceFilePath,
      fileMentions: fileMentions.length > 0 ? fileMentions : undefined,
      editorContext: editorContext ?? undefined,
    };

    setMessages(prev => [
      ...prev,
      userMsg,
      { role: "assistant", content: "", streaming: true, parts: [], sourceFilePath: userMsg.sourceFilePath },
    ]);
    // MULTITASKING : on ancre le fil de CE run SUR la même base que l'UI
    // optimiste ci-dessus (`messagesRef` n'est pas encore synchronisé par l'effet
    // au moment où le run démarre). Sans cet ancrage, `updateThread` repartirait
    // d'un fil SANS les deux bulles qui viennent d'être affichées.
    const runSeed = messagesRef.current;
    run.messages = [...runSeed, userMsg, { role: "assistant", content: "", streaming: true, parts: [], sourceFilePath: userMsg.sourceFilePath }];
    setChatView("chat");
    localStorage.setItem("origin-ai-chat-view", "chat");
    // On capture la longueur AVANT l'édition optimiste : le contexte projet est
    // dérivé de `messagesRef` qui n'inclut pas encore cette bulle.
    const historyBeforeSend = buildModelHistory(messagesRef.current.filter(m => !m.streaming));

    // Clé API : lue en parallèle de la lecture des fichiers mentionnés (deux
    // familles d'IPC indépendantes). Le cache mémoire de `loadApiKey` évite de
    // re-sonder le keychain à chaque tour.
    //
    // Modèle Mira : ce n'est PAS la clé du client qui est utilisée, mais celle
    // que Mira fournit (config d'env, provider `orvyx`). On résout donc la clé
    // sur l'id de provider Mira, jamais sur la clé du modèle.
    const apiKeyPromise = loadApiKey(miraTarget?.providerId ?? providerId);
    // Fichiers mentionnés : lus EN PARALLÈLE (une promesse par fichier) au lieu
    // d'une boucle séquentielle d'IPC.
    const mentionedFilesPromise = Promise.all(
      fileMentions.map(async (filepath) => {
        try { return { filepath, content: await readFile(filepath) }; }
        catch { return null; }
      }),
    );

    const apiKey = await apiKeyPromise;
    // Un modèle Mira est censé avoir SA clé fournie par Mira : si elle manque,
    // c'est un problème de configuration côté Mira, pas une clé oubliée par le
    // client. On affiche donc un message distinct (pas d'invite « ajoute ta clé »).
    const knownError = !apiKey && !LOCAL_PROVIDERS.has(providerId)
      ? (miraTarget
        ? "This model is temporarily unavailable. Please try later or pick another model."
        : "No API key found for this model. Please add your API key in Settings → Models.")
      : null;

    // ── Session bookkeeping ──────────────────────────────────────────────────
    // `sessionId` a déjà été résolu en tête de `handleSend` (`prevSessionId`).
    // Mode effectif de la conversation : c'est le mode MÉMORISÉ (mode de création
    // de la conv) qui décide des capacités d'agent, PAS le layout courant. Une
    // conv ouverte en AI garde donc ses sous-agents même relue en IDE, et
    // inversement — c'est la garantie « le mode suit la conversation » de Trae.
    // Repli sur le mode du layout tant qu'aucun mode n'est mémorisé (nouvelle conv).
    const effAppMode: 'ide' | 'ai' = sessionAppModeRef.current ?? (isAgent ? 'ai' : 'ide');
    const convIsAgent = effAppMode === 'ai';
    if (!prevSessionId) {
      // `sessionId` a déjà été généré en tête de `handleSend` (et `run` y est
      // rattaché) : on ne le régénère PAS, sinon le run travaillerait sur un
      // état orphelin. On se contente de publier la nouvelle conversation.
      setActiveSessionId(sessionId);
      localStorage.setItem(activeSessionKey(fp), sessionId);
      onActiveSessionChangeRef.current?.(sessionId);
      lsPush({ id: sessionId, title: text, workspace_path: fp, updated_at: Date.now() });
      // Le mode de création de la conversation est figé ici (source de vérité).
      setSessionAppMode(effAppMode);
      createSession(fp, text, modelId, providerId, sessionId, effAppMode)
        .catch(err => console.error("[AiPanel] DB createSession failed:", err));
    } else {
      lsTouch(sessionId);
      touchSession(sessionId, modelId, providerId)
        .catch(err => console.error("[AiPanel] DB touchSession failed:", err));
    }

    // ── DB: persist user message + assistant placeholder ─────────────────────
    // On mémorise les ids DB au fur et à mesure : `dbIdsRef` reste aligné sur
    // `messages` (user puis assistant), ce qui permet d'éditer/régénérer en
    // supprimant les messages postérieurs. Un id reste `null` si la persistance
    // a échoué pour cette ligne. Les insertions partent en parallèle (latence
    // minimale) mais portent un `created_at` EXPLICITE et strictement croissant
    // (user = t, assistant = t+1) : l'ordre de relecture est donc déterministe,
    // même si les deux tombent dans la même milliseconde. En cas de clé manquante
    // (échec connu d'avance), on persiste quand même la bulle utilisateur puis on
    // affiche l'erreur sans jamais lancer le réseau.
    if (sessionId) {
      const turnStartMs = Date.now();
      const editorContextJson = editorContext
        ? JSON.stringify({ filename: editorContext.filename, startLine: editorContext.startLine, endLine: editorContext.endLine, type: editorContext.type })
        : null;
      const userInsert = insertMessage({
        sessionId,
        messageType: "user",
        content: text,
        attachmentsJson: fileMentions.length > 0 ? JSON.stringify(fileMentions) : null,
        editorContextJson,
        createdAt: turnStartMs,
      });
      // Placeholder assistant : en erreur connue, on le crée déjà « complete ».
      // `turnStartMs + 1` garantit un ORDRE DÉTERMINISTE (user avant assistant) :
      // les deux inserts partent en parallèle, donc `Date.now()` pouvait tomber
      // sur la même milliseconde et laisser l'ordre de relecture indéterminé.
      const assistantInsert = insertMessage({
        sessionId,
        messageType: "assistant",
        content: knownError ?? "",
        status: knownError ? "complete" : "streaming",
        model: modelId,
        createdAt: turnStartMs + 1,
      });
      const [uid, assistantDbId] = await Promise.all([
        userInsert.catch(err => { console.error("[AiPanel] Failed to persist user message:", err); return null; }),
        assistantInsert.catch(err => { console.error("[AiPanel] Failed to persist assistant placeholder:", err); return null; }),
      ]);
      dbIdsRef.current.push(uid, assistantDbId);
      run.pendingAssistantDbId = assistantDbId;
    } else {
      dbIdsRef.current.push(null, null);
    }

    // Échec connu (clé absente) : la bulle assistant affiche l'erreur, on arrête.
    if (knownError) {
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, content: knownError, streaming: false };
        return next;
      });
      return;
    }

    // ── Build enriched message for the API ──────────────────────────────────
    let apiText = text;
    if (editorContext && editorContext.code.trim()) {
      const relPath = sourceFilePath ? toWorkspaceRelPath(sourceFilePath, fp) : undefined;
      apiText = buildContextPrefix(editorContext, relPath) + apiText;
    }
    // Contexte `#` : résolu et concaténé dans `apiText` (même canal que les `@`).
    // On ignore le `#Code` ici pour ne pas dupliquer le préfixe « Selected code »
    // déjà injecté juste au-dessus depuis `editorContext`.
    const hashRefs = contextRefs.filter(r => r.kind !== "code");
    if (hashRefs.length > 0) {
      apiText += await resolveContextRefs(hashRefs, fp, editorContext);
    }
    for (const file of await mentionedFilesPromise) {
      if (!file) continue;
      const fname = file.filepath.split(/[\\/]/).pop() ?? file.filepath;
      const ext = fname.split(".").pop()?.toLowerCase() ?? "";
      apiText += `\n\n[File: ${file.filepath}]\n\`\`\`${FENCE_MAP[ext] ?? ext}\n${file.content}\n\`\`\``;
    }

    const modelMessages: ModelMessage[] = [
      // Le résumé de compaction persisté (« à côté » des bulles intactes) est
      // réinjecté ici, au seul point qui alimente le modèle : le gain de la
      // compaction manuelle est donc réellement actif au tour suivant, et il
      // survit à un rechargement de session.
      ...withCompactionSummary(historyBeforeSend, readCompactionSummary(activeSessionIdRef.current)),
      { role: "user" as const, content: apiText },
    ];

    const originMd = originMdRef.current;
    // Composeur UNIQUE pour les trois modes : les blocs sont assemblés par le
    // module central (prompts.ts), puis la consigne de style et ORIGIN.md sont
    // ajoutés en fin (la consigne de style prime sur un prompt personnalisé).
    // Un prompt personnalisé (localStorage) REMPLACE les blocs par défaut mais
    // reçoit le même habillage : style + ORIGIN.md.
    const withOriginMd = (base: string) =>
      composeSystemPrompt({ blocks: [base], style: STYLE_GUARDRAIL, extra: originMd || undefined });

    const isMax = (localStorage.getItem("origin-ai-effort") ?? "normal") === "max";
    const customAgent = localStorage.getItem("origin-ai-system-prompt");
    const customAsk   = localStorage.getItem("origin-ai-ask-prompt");
    const customPlan  = localStorage.getItem("origin-ai-plan-prompt");
    // Agent personnalisé actif (sélectionné dans l'input) : son prompt de rôle
    // est INJECTÉ dans le prompt système de base (jamais en remplacement), et sa
    // liste d'outils se COMBINE (intersection) avec les préférences globales de
    // Settings › Agent. Un agent vide = aucun effet : comportement inchangé.
    const selectedAgent = activeAgentRef.current;
    const agentPromptBlock = selectedAgent?.prompt?.trim();
    const baseDisabled = getDisabledTools();
    // Outils désactivés = préférences globales ∪ (outils NON retenus par l'agent).
    // On n'ajoute « tout ce qui n'est pas listé » que si l'agent déclare des
    // outils : un agent sans outils garde la dotation complète par défaut.
    const disabledTools: ReadonlySet<string> =
      selectedAgent && selectedAgent.tools.length > 0
        ? new Set<string>([
            ...baseDisabled,
            ...AGENT_TOOLS.filter(t => !selectedAgent.tools.includes(t.id)).map(t => t.id),
          ])
        : baseDisabled;
    // Injecte le prompt d'agent (rôle) en tête des blocs, puis le reste.
    const withAgentPrompt = (base: string) =>
      agentPromptBlock ? `${base}\n\n---\n\n# Agent Role\n\n${agentPromptBlock}` : base;
    // Le mode IA (conversation créée en AI) tourne avec des coéquipiers Cline
    // (`team_*`) : on annonce TOUJOURS la délégation dans ce cas, indépendamment
    // de l'effort. En IDE il n'y a qu'un agent : la consigne de sous-agents serait
    // trompeuse, on ne l'inclut qu'à l'effort max (variante `spawn_agent`).
    // Un agent personnalisé est SINGULIER : on coupe les équipes pour que « son »
    // identité et sa dotation d'outils restent respectées.
    const systemPrompt     = withOriginMd(withAgentPrompt(customAgent ?? buildSystemPrompt("agent", isMax, "", convIsAgent, disabledTools)));
    const askSystemPrompt  = withOriginMd(withAgentPrompt(customAsk   ?? buildSystemPrompt("ask",   isMax, "", false, disabledTools)));
    const planSystemPrompt = withOriginMd(withAgentPrompt(customPlan  ?? buildSystemPrompt("plan",  isMax, "", false, disabledTools)));

    // ── Checkpoint du tour ───────────────────────────────────────────────────
    // Ouvre un checkpoint dès qu'un tour peut écrire (Agent) ; en Ask, aucun
    // fichier n'est touché et `finish` ne montrera donc jamais de bannière.
    // L'index du message utilisateur (sa position avant ajout) sert de clé pour
    // rattacher ce tour à ce message, afin que « revert » puisse agir sur tous
    // les tours générés depuis lui.
    const userIndex = messagesRef.current.length;
    if (mode !== "ask") beginTurn(userIndex);
    // Réinitialise la télémétrie du tour : on repart d'un compteur vierge.
    setTelemetry({ compaction: 0, retry: 0 });
    // L'onglet Agents ne montre que les sous-agents du tour courant (les cartes
    // du chat, elles, restent persistées dans les parts des messages).
    // MULTITASKING : la purge cible CETTE session — les sous-agents d'une tâche
    // parallèle ne doivent jamais disparaître quand une autre tâche démarre.
    clearSubAgents(sessionId);
    // Le contexte projet dérivé (stack/arbo/fichiers clés) est recalculé au début
    // de chaque tour : jamais figé d'un tour à l'autre — et propre à cette session.
    resetProjectContext(sessionId);

    // Clé stable de session pour les stores clé-par-session (sous-agents, contexte).
    const runSessionKey = sessionId;

    // ── Fil propre à CE run (multitasking) ───────────────────────────────────
    //
    // `messagesRef` ne peut pas servir de source de vérité à un run : il reflète
    // le fil AFFICHÉ, qui peut appartenir à une AUTRE tâche. Chaque run travaille
    // donc sur SON propre fil, `run.messages` (état par session de `runState`).
    //  - si la session du run est AFFICHÉE → on pousse vers React (`setMessages`) ;
    //  - sinon → on ne mute QUE le miroir : le fil affiché (autre tâche) est
    //    intact et le run sera rejoué à la reprise (cf. handleSessionSelect).
    const isDisplayed = () => activeSessionIdRef.current === sessionId;
    const updateThread = (updater: (prev: DisplayMessage[]) => DisplayMessage[]): void => {
      const prev = run.messages ?? messagesRef.current;
      const next = updater(prev);
      run.messages = next;
      if (isDisplayed()) setMessages(next);
    };

    // Le fil de ce run a déjà été ancré au moment de l'UI optimiste (cf. le début
    // de `handleSend`) : `updateThread` part donc du bon état (bulles incluses).

    // ── Suivi shell en DIRECT (parité SOLO) ──────────────────────────────────
    //
    // Le terminal « Agent » du panneau bas est un MIROIR lecture seule : il ne
    // ré-exécute JAMAIS la commande (sinon `rm`/`git commit` s'exécuteraient deux
    // fois). Il lit le flux réel du SDK :
    //   - `tool-call` shell → on ouvre la commande (`agentTerminalCommandStart`) ;
    //   - `terminal-output` → on écrit la sortie streamée (`agentTerminalOutput`) ;
    //   - `tool-result` shell → on clôt avec le code de sortie (`CommandEnd`).
    // Aucune écriture clavier n'est possible côté client : le store n'expose
    // aucune API de saisie (contrainte structurelle, pas seulement visuelle).
    //
    // `liveToolId` mémorise l'id du tool-call shell courant : les `chunk` du SDK
    // n'étant pas corrélés à un id, on rattache la sortie à la dernière commande
    // ouverte, et on ignore les chunks d'outils non-shell (le terminal est
    // réservé au shell).
    let liveToolId: string | null = null;

    const isShellTool = (toolName: string): boolean => {
      const action = toPendingAction(toolName, {});
      return action?.type === "bash_run";
    };

    /** Code de sortie lu sur le résultat d'un outil shell (défensif). */
    const shellExitCode = (result: unknown): number => {
      if (typeof result === "string" && /(?:error|exit code|failed)/i.test(result)) return 1;
      if (result && typeof result === "object") {
        const o = result as Record<string, unknown>;
        if (typeof o.exitCode === "number") return o.exitCode;
        if (typeof o.code === "number") return o.code;
        if (o.error) return 1;
      }
      return 0;
    };

    // ── Event handler ────────────────────────────────────────────────────────
    const handleEvent = (event: AgentEvent) => {
      // Garde de génération : un run remplacé/annulé ne doit PLUS toucher l'état
      // de l'UI, même si un outil déjà « en vol » émet encore un event tardif.
      if (run.seq !== runSeq) return;
      switch (event.type) {

        case "token": {
          const delta = event.delta;
          // Un token préfixé par `spawnId` appartient à un sous-agent : il va dans
          // la carte du sous-agent, JAMAIS dans le message du root. C'est le seul
          // moyen de garantir que le root ne reçoit que le rapport borné.
          if (event.spawnId) {
            appendChildStream(event.spawnId, delta);
            break;
          }
          run.pendingParts = appendText(run.pendingParts, delta);
          updateThread(prev => {
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
          run.pendingContent += delta;
          if (!run.flushTimer) {
            run.flushTimer = setTimeout(() => {
              run.flushTimer = null;
              const dbId = run.pendingAssistantDbId;
              if (dbId) updateMessageContent(dbId, run.pendingContent, "streaming").catch(() => {});
            }, 500);
          }
          break;
        }

        case "reasoning": {
          // Chaîne de pensée exposée par certains modèles : on l'accumule dans une
          // part `reasoning` dédiée (rendue en section repliable), sans la mêler au
          // texte de réponse ni au contenu persisté de l'assistant. Le reasoning
          // d'un sous-agent, lui, n'alimente jamais le fil du root.
          if (event.spawnId) break;
          const delta = event.delta;
          run.pendingParts = appendReasoning(run.pendingParts, delta);
          updateThread(prev => {
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
          // Détection centralisée (`isWriteTool`) : le SDK Cline émet `editor` /
          // `apply_patch`, PAS `write_file`/`edit` — une comparaison littérale
          // ici rendait la bannière muette.
          if (isWriteTool(event.toolName)) {
            run.dirty = true;
          }
          // Faits du GATE DE TERMINAISON (Lot D) : on mémorise, à titre
          // d'OBSERVATION, si ce tour a réellement vérifié son travail ou
          // sollicité l'utilisateur. Aucune décision ici — elle est prise à la
          // clôture (cf. `shouldBlockForVerification`).
          if (event.toolName === "ask_question") {
            run.askedUser = true;
          } else if (isShellTool(event.toolName)) {
            const cmd = toPendingAction(event.toolName, event.args);
            if (cmd?.type === "bash_run" && isVerificationCommand(cmd.command)) {
              run.ranVerification = true;
            }
          }
          // MULTITASKING : dès qu'un outil (du root) démarre, la tâche passe en
          // « waiting » — elle reste VIVANTE (donc basculable sans perte), mais le
          // rail peut l'afficher comme « en attente d'outil ». Les outils de
          // sous-agents n'y touchent pas : le root, lui, n'attend rien.
          if (!event.spawnId) markTaskWaiting(sessionId, event.toolName);
          // Un tool-call préfixé par `spawnId` appartient à un sous-agent : il est
          // ajouté à la liste d'outils de sa carte (et JAMAIS au flux du root).
          if (event.spawnId) {
            const subTc: ToolCallDisplay = { id: event.id, toolName: event.toolName, args: event.args, status: "running" };
            appendChildTool(event.spawnId, subTc);
            break;
          }
          // Terminal agent (parité SOLO) : une commande shell du root ouvre une
          // entrée dans le miroir lecture seule (en-tête `$ cmd`).
          if (isShellTool(event.toolName)) {
            liveToolId = event.id;
            const cmd = toPendingAction(event.toolName, event.args);
            agentTerminalCommandStart(sessionId, cmd?.type === "bash_run" ? cmd.command : event.toolName);
          }
          // Idempotence : un `approval-required` peut avoir créé la carte AVANT
          // que le `tool-call` ne soit consommé du flux (l'approbation démarre
          // dès que l'appel est parsé, donc l'ordre des deux events n'est pas
          // garanti). Sans ce garde-fou, la carte apparaîtrait en DOUBLE — une
          // fois via l'approbation, une fois via le tool-call. On met à jour la
          // part existante au lieu d'en ajouter une seconde.
          const alreadyHasCall = run.pendingParts.some(p => p.type === "tool-call" && p.tc.id === event.id);
          const newPart: MessagePart = { type: "tool-call", tc: { id: event.id, toolName: event.toolName, args: event.args, status: "running" } };
          if (alreadyHasCall) {
            run.pendingParts = updateTcInParts(run.pendingParts, event.id, { toolName: event.toolName, args: event.args });
            updateThread(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant" && last.parts) {
                next[next.length - 1] = { ...last, parts: updateTcInParts(last.parts, event.id, { toolName: event.toolName, args: event.args }) };
              }
              return next;
            });
            break;
          }
          run.pendingParts = [...run.pendingParts, newPart];
          updateThread(prev => {
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
          // MULTITASKING : l'outil du root a rendu la main, l'agent regénère —
          // retour en « running ». (Les outils de sous-agents ne pilotent pas le
          // statut : c'est le root qui travaille.)
          if (!event.spawnId) markTaskRunning(sessionId);
          if (event.spawnId) {
            updateChildTool(event.spawnId, event.id, { status: "complete", result: event.result });
            break;
          }
          // Terminal agent : la commande shell est terminée → on clôt son entrée
          // avec le code de sortie (marqueur vert/rouge dans le miroir).
          if (liveToolId === event.id) {
            agentTerminalCommandEnd(sessionId, shellExitCode(event.result));
            liveToolId = null;
          }
          // Revue « live » (pattern Trae) : dès qu'un outil d'écriture aboutit, on
          // rafraîchit la bannière « N files changed / Keep all / Undo all » pour
          // qu'elle apparaisse et se mette à jour PENDANT le run, pas à la fin.
          if (isWriteTool(event.toolName)) {
            const turnId = activeTurnIdRef.current;
            if (turnId) refreshReview(turnId);
          }
          const tcUpdate = { status: "complete" as const, result: event.result, approve: undefined, reject: undefined };
          run.pendingParts = updateTcInParts(run.pendingParts, event.id, tcUpdate);
          updateThread(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.parts) {
              next[next.length - 1] = { ...last, parts: updateTcInParts(last.parts, event.id, tcUpdate) };
            }
            return next;
          });
          break;
        }

        case "terminal-output": {
          // Sortie shell streamée (stdout/stderr) pendant qu'une commande tourne :
          // on l'écrit dans le miroir du terminal agent, rattachée à la commande
          // shell ouverte. Un chunk reçu hors commande (bruit d'un autre outil)
          // est ignoré : le terminal est réservé au shell.
          if (liveToolId) agentTerminalOutput(sessionId, event.chunk);
          break;
        }

        case "approval-required": {
          const _action = event.action;
          // Question (`ask_user`) : on ne l'affiche PAS dans le fil mais dockée
          // au-dessus de l'input, avec ses options + « Other ». Le run est en
          // pause ; la réponse passe par `event.reject(answer)`, puis on purge.
          if (_action.type === "ask_user") {
            const resolve = event.reject;
            setPendingQuestion({
              id: event.id,
              question: _action.question,
              options: _action.options,
              answer: (a: string) => {
                resolve?.(a);
                setPendingQuestion(null);
              },
            });
            break;
          }
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
          // La carte du tool-call a pu être flushée de `pendingParts` vers
          // `messages` entre le `tool-call` et l'approbation (flush de fin
          // d'étape). On cherche donc l'id dans les deux : si on ne regardait
          // que `pendingParts`, on recréerait une seconde carte → doublon.
          const inPending = run.pendingParts.some(p => p.type === "tool-call" && p.tc.id === event.id);
          const inMessages = (messagesRef.current[messagesRef.current.length - 1]?.parts ?? []).some(p => p.type === "tool-call" && p.tc.id === event.id);
          if (inPending) {
            run.pendingParts = updateTcInParts(run.pendingParts, event.id, approvalUpdate);
          } else if (!inMessages) {
            const tc = { id: event.id, toolName: event.action.type, args: event.action, ...approvalUpdate };
            run.pendingParts = [...run.pendingParts, { type: "tool-call", tc }];
          }
          updateThread(prev => {
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
          // L'agent est BLOQUÉ en attente d'une décision (réponse à une question
          // ou approbation d'édition) : son + toast, quel que soit le tool. La
          // session visée est celle du run courant.
          {
            const waitSid = sessionId || activeSessionIdRef.current;
            if (waitSid) notifyTask("question", waitSid);
          }
          break;
        }

        case "approval-resolved": {
          // Une action a été auto-approuvée ou bloquée sans carte de confirmation.
          // On fige l'état du tool call correspondant pour que l'UI (et l'historique)
          // reflète la décision.
          // Si la question dockée correspond à ce tool call, on la retire.
          setPendingQuestion(q => (q && q.id === event.id ? null : q));
          const resolved = event.status === "approved"
            ? { status: "complete" as const, approve: undefined, reject: undefined }
            : { status: "complete" as const, result: { cancelled: true }, approve: undefined, reject: undefined };
          run.pendingParts = updateTcInParts(run.pendingParts, event.id, resolved);
          updateThread(prev => {
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
          run.pendingParts = [...run.pendingParts, statusPart];
          // Télémétrie : on incrémente le compteur de la session.
          setTelemetryRef.current?.(t => {
            const key = event.kind;
            return { ...t, [key]: (t[key] ?? 0) + 1, lastSavedTokens: event.savedTokens ?? t.lastSavedTokens };
          });
          updateThread(prev => {
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

        case "timing":
          // Instrumentation : trace de latence d'un tour. Reléguée au logger
          // central → terminal `tauri dev` + fichier `~/.origin/logs/origin.log`.
          // Sert à objectiver le TTFT/débit et à voir les bascules de cascade.
          log.info(
            "ai/panel",
            `timing model=${event.model || "?"} ttft=${event.ttftMs}ms ` +
            `total=${event.totalMs}ms gen=${event.genMs}ms ` +
            `chars=${event.outputChars} tok/s=${event.tokPerSec} fallbacks=${event.fallbacks}`,
          );
          break;

        case "subagent-start": {
          // Carte de sous-agent rattachée à un tool-call parent.
          //
          // DEUX CAS :
          //  - IDE (`spawn_agent`) : l'événement porte le `toolCallId` exact du
          //    tool-call qui a lancé l'agent → rattachement direct.
          //  - IA (équipes) : le `toolCallId` est le `runId` du run Cline, qui ne
          //    correspond à AUCUN tool-call du fil (le run est lancé par
          //    `team_run_task`, mais avec un id différent). On rattache alors la
          //    carte au DERNIER tool-call d'orchestration (`team_*`) : c'est
          //    visuellement le bon parent, et sans ce fallback la carte du
          //    coéquipier n'existerait nulle part dans le fil (son contenu, routé
          //    par `spawnId`, serait perdu — le bug « rien pour le suivi »).
          run.spawned += 1;
          startSubAgent(runSessionKey, { spawnId: event.spawnId, role: event.role, task: event.task, toolCallId: event.toolCallId });
          const targetId = event.toolCallId;
          const attachChild = (parts: MessagePart[]): MessagePart[] => {
            // Cible directe par id, sinon dernier tool-call `team_*` sans cette carte.
            let target: string | undefined;
            if (targetId && parts.some(p => p.type === "tool-call" && p.tc.id === targetId)) {
              target = targetId;
            } else {
              for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i];
                if (p.type === "tool-call" && p.tc.toolName.startsWith("team_")) { target = p.tc.id; break; }
              }
            }
            if (!target) return parts;
            return parts.map(p => {
              if (p.type !== "tool-call" || p.tc.id !== target) return p;
              const children = p.tc.children ?? [];
              const existing = children.find(c => c.spawnId === event.spawnId);
              // Déjà rattachée : on ENRICHIT la tâche si elle était vide (cas IA :
              // `teammate_spawned` crée la carte sans tâche, `run_started` la
              // fournit juste après) au lieu d'ignorer — sinon la carte resterait
              // sans libellé.
              if (existing) {
                if (existing.task || !event.task) return p;
                return {
                  ...p,
                  tc: { ...p.tc, children: children.map(c => c.spawnId === event.spawnId ? { ...c, task: event.task } : c) },
                };
              }
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
          run.pendingParts = attachChild(run.pendingParts);
          updateThread(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, parts: attachChild(last.parts ?? []) };
            return next;
          });
          break;
        }

        case "subagent-step":
          stepSubAgent(runSessionKey, event.spawnId, event.iteration);
          break;

        case "subagent-end": {
          endSubAgent(runSessionKey, event.spawnId, {
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
          run.pendingParts = finalizeChild(run.pendingParts);
          updateThread(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, parts: finalizeChild(last.parts ?? []) };
            return next;
          });
          break;
        }

        case "finish": {
          if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
          // ── GATE DE TERMINAISON (Lot D) ──────────────────────────────────────
          // Avant d'accepter la clôture : si ce tour a ÉCRIT sans rien vérifier
          // puis revendiqué un succès, on REFUSE le `finish` et on relance un
          // tour de VÉRIFICATION. Décision fondée sur des faits observés
          // (cf. `shouldBlockForVerification`), jamais sur la formulation seule.
          // Une seule relance par run (`verificationGuardFired`).
          {
            const decision = shouldBlockForVerification(run.pendingContent, {
              wroteWorkspace: run.dirty,
              ranVerification: run.ranVerification,
              askedUser: run.askedUser,
              // Le gate n'a de sens que si l'outillage de contrôle est branché.
              qualityToolsAvailable: isFamilyEnabled(["detect_checks"]),
              guardFired: run.verificationGuardFired,
            });
            if (decision.action === "verify") {
              run.verificationGuardFired = true;
              // On abandonne PROPREMENT ce tour : le contenu déjà écrit est
              // persisté, le run reste vivant (pas de `complete`), et le
              // rappel de vérification part comme tour de SUIVI immédiat.
              const vDbId = run.pendingAssistantDbId;
              const vContent = run.pendingContent;
              const vParts = run.pendingParts;
              run.pendingAssistantDbId = null;
              run.pendingContent = "";
              run.pendingParts = [];
              if (vDbId) updateMessageContent(vDbId, vContent, "complete").catch(() => {});
              updateThread(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant" && last.streaming) {
                  next[next.length - 1] = { ...last, content: vContent, parts: vParts, streaming: false };
                }
                return next;
              });
              log.info("ai/panel", `gate de terminaison: relance de vérification (${decision.reason})`);
              // Reset des faits pour le tour de vérification.
              run.dirty = false;
              run.ranVerification = false;
              run.askedUser = false;
              setTimeout(() => {
                handleSendRef.current?.(VERIFY_BEFORE_FINISH_REMINDER, modelId, providerId, [], null, "agent", [])
                  .catch(err => log.warn("ai/panel", `relance de vérification échouée: ${String(err)}`));
              }, 0);
              break;
            }
          }
          // Trace d'orchestration discrète : on consigne le nombre de sous-agents
          // réellement lancés pendant le tour. Aucune ligne si le root a choisi
          // de tout faire lui-même (choix légitime) — c'est un journal, pas une
          // injonction. La part est ajoutée au corps final, donc persistée.
          if (run.spawned > 0) {
            const n = run.spawned;
            run.pendingParts = [
              ...run.pendingParts,
              { type: "status", kind: "orchestration", detail: `${n} sous-agent${n > 1 ? "s" : ""} ${n > 1 ? "ont" : "a"} travaillé pour ce tour.` },
            ];
          }
          const dbId = run.pendingAssistantDbId;
          const finalContent = run.pendingContent;
          const finalParts = run.pendingParts;
          run.pendingAssistantDbId = null;
          run.pendingParts = [];
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

          const sid = sessionId;
          const fPath = folderPathRef.current ?? "";
          if (sid) {
            lsTouch(sid);
            touchSession(sid, modelId, providerId).catch(() => {});
          }
          setSessions(lsForPath(fPath));
          run.cleanup = null;
          // MULTITASKING : le tour s'est terminé proprement → la tâche passe
          // « completed » dans le registre. Le handle est libéré : un abort
          // ultérieur ne coupera plus rien.
          taskRun.complete();
          run.task = null;

          updateThread(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });

          // Coche automatique de fin de tour : les tâches restées ouvertes sont
          // marquées terminées pour que la checklist reflète un run achevé.
          if (activeSessionIdRef.current) finalizeTodos(activeSessionIdRef.current);

          // Notification d'ORIGINE (avant flushQueue, qui peut relancer un run) :
          // la tâche qui vient de se terminer est identifiée par SA session
          // (`sid`), pas par la session affichée — le helper gère l'anti-bruit
          // (pas de son/toast si c'est justement la tâche regardée).
          if (sid) notifyTask("finish", sid);

          // File d'attente : envoie le message suivant, s'il y en a un.
          flushQueueRef.current?.();

          const { usage } = event as { usage: UsageData };
          if (usage && !LOCAL_PROVIDERS.has(providerId)) {
            const modelName = findCustomModel(providerId)?.displayName ?? modelId;
            const color = accentForModel(providerId);
            const cost = computeCost(modelId, usage.inputTokens, usage.outputTokens);
            recordUsage(modelId, modelName, providerId, usage.inputTokens, usage.outputTokens, cost, color, usage.cacheReadTokens);
          }

          // Bannière Undo all / Keep all : seulement si ce tour a écrit des
          // fichiers (mode Plan phase 1 = lecture seule → jamais de bannière).
          // La bannière a déjà été alimentée en continu (refreshReview) ; ce
          // dernier rafraîchissement « immédiat » garantit l'état final exact
          // (dernier delta) juste avant le retour au repos.
          if (run.dirty) {
            const turnId = activeTurnIdRef.current;
            if (turnId) refreshReview(turnId, true);
            run.dirty = false;
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
              updateThread(prev => {
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
              updateThread(prev => {
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
          if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
          const dbId = run.pendingAssistantDbId;
          const partialContent = run.pendingContent;
          run.pendingAssistantDbId = null;
          // Trace exploitable : c'est LE point où un tour casse. Écrit dans le
          // terminal `tauri dev` + le fichier de log, sans DevTools.
          log.error("ai/panel", `tour en erreur (dbId=${dbId ?? "-"}, partiel=${partialContent.length} car.) : ${event.message}`);
          log.flush();
          // Quota Orvyx épuisé (402) : on le distingue d'une erreur technique,
          // car l'action attendue est commerciale (« passer à une offre
          // supérieure ») et non un simple « réessayer ». L'erreur brute reste
          // affichée ; on ajoute seulement la carte d'upgrade.
          const quota = isQuotaError(event.message);
          const errStatus = quota ? "quota" : "error";
          if (dbId) updateMessageContent(dbId, partialContent || `Error: ${event.message}`, errStatus).catch(() => {});
          updateThread(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, content: `Error: ${event.message}`, streaming: false, quotaExhausted: quota || undefined };
            }
            return next;
          });
          run.cleanup = null;
          // MULTITASKING : le tour a échoué → la tâche est « interrupted » (elle
          // n'est plus vivante, mais elle n'a pas abouti). Handle libéré.
          taskRun.interrupt();
          run.task = null;
          // Notification d'erreur : son + toast (toujours, même si la tâche est
          // affichée — un échec doit interpeller). La session visée est celle du
          // run courant.
          {
            const errSid = sessionId || activeSessionIdRef.current;
            if (errSid) notifyTask("error", errSid, { errorMessage: event.message });
          }
          // Le tour s'est terminé en erreur : on enchaîne tout de même le
          // message en attente (l'utilisateur a explicitement choisi de l'envoyer).
          flushQueueRef.current?.();
          break;
        }
      }

      // Le fil de CE run est déjà tenu à jour par `updateThread` (miroir
      // `run.messages`) : rien d'autre à synchroniser ici.
    };

    // Applique une mutation à l'unique sous-agent `spawnId` d'un tool-call parent.
    // Un sous-agent est rattaché à exactement un tool-call `spawn_agent`.
    const mutateChild = (spawnId: string, fn: (children: SubAgentChild[]) => SubAgentChild[]): void => {
      const apply = (parts: MessagePart[]): MessagePart[] => parts.map(p => {
        if (p.type !== "tool-call" || !p.tc.children?.some(c => c.spawnId === spawnId)) return p;
        return { ...p, tc: { ...p.tc, children: fn(p.tc.children) } };
      });
      run.pendingParts = apply(run.pendingParts);
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

    // Accumule le texte produit EN DIRECT par un sous-agent dans sa carte. Le flux
    // est borné (le rapport final reste la source de vérité) : on ne garde que la
    // fin, suffisante pour « voir » le sous-agent travailler sans exploser la
    // mémoire du message pendant un long run.
    const CHILD_STREAM_MAX_CHARS = 8_000;
    const appendChildStream = (spawnId: string, delta: string): void => {
      mutateChild(spawnId, children => children.map(c => {
        if (c.spawnId !== spawnId) return c;
        const merged = (c.stream ?? "") + delta;
        return { ...c, stream: merged.length > CHILD_STREAM_MAX_CHARS ? merged.slice(-CHILD_STREAM_MAX_CHARS) : merged };
      }));
    };

    // Fige un outil d'un sous-agent (résultat reçu).
    const updateChildTool = (spawnId: string, toolId: string, update: Partial<ToolCallDisplay>): void => {
      mutateChild(spawnId, children => children.map(c => c.spawnId !== spawnId ? c : {
        ...c,
        tools: (c.tools ?? []).map(t => t.id === toolId ? { ...t, ...update } : t),
      }));
    };

    // ── Moteur d'agent Cline (utilisé par TOUS les modes) ──────────────────────
    // Depuis la bascule, `plan`, `ask`, IDE et IA partagent le MÊME moteur (SDK
    // Cline via le sidecar Node). On ne construit plus d'outils ni de chaîne de
    // modèles côté front : le SDK exécute ses propres outils (lecture, édition,
    // recherche, patch, shell) dans le sidecar. Le front ne fait plus que :
    //   - fournir le modèle + le prompt (composition Origin conservée) ;
    //   - router les événements traduits vers `handleEvent` (mêmes types) ;
    //   - décider des approbations via `permissions.ts` (harness partagé) ;
    //   - capturer les checkpoints undo/keep avant chaque écriture.
    //
    // Le mode SDK pilote le périmètre d'action :
    //   - `plan` : LECTURE SEULE (aucune écriture, l'agent produit un plan) ;
    //   - `ask`  : LECTURE SEULE (questions ciblées, pas de modification) ;
    //   - `act`  : EXÉCUTION complète (IDE = 1 agent ; IA = équipes).
    //
    // CONTINUITÉ DE SESSION : on RÉUTILISE la session Cline persistée (colonne DB
    // `cline_session_id`) pour que l'agent garde tout son historique entre tours.
    // Sur reprise, les outils custom existent déjà : on ne les réinjecte pas.
    const clineProvider = resolveClineProvider(providerId);
    const runCline = async (opts: {
      systemPrompt: string;
      sdkMode: "act" | "plan";
      enableTeams: boolean;
      /** Expose l'outil léger `escalate_to_team` (mode IA sans agent perso). */
      enableEscalate: boolean;
      prompt: string;
    }): Promise<ClineRunHandle | null> => {
      // Modèle fourni par Mira (`mira-<id>`) : la base URL vient de la config
      // Mira (`miraTarget`), pas d'un catalogue côté front.
      if (miraTarget) clineProvider.baseUrl = miraTarget.baseUrl;
      const clineSessionId = sessionId ? await getClineSessionId(sessionId) : null;
      // Session NEUVE : la surface d'extension (skills/commands) va être
      // rescanée par le sidecar. On repart d'une base propre pour ne pas
      // afficher les extensions d'une session précédente en attendant la
      // réponse (le callback `onExtensions` la repeuplera).
      if (!clineSessionId) setSessionExtensions(null);
      // OUTILS CUSTOM : envoyés à CHAQUE `start`, PAS seulement à la création.
      //
      // POURQUOI (bug corrigé) — la « reprise » n'est PAS une réutilisation : le
      // SDK ne garde ses sessions qu'en mémoire vive, et la continuité se fait
      // par RE-SEED (un nouveau `start` avec `initialMessages`, cf.
      // `clineClient.startClineRun`). Un `start` reconstruit le runtime à zéro :
      // les outils custom d'une session précédente n'existent donc PLUS. Les
      // omettre sur reprise les faisait disparaître silencieusement (todo,
      // navigateur, index de code) dès le 2ᵉ tour. On les redéclare donc
      // systématiquement — sans risque de doublon, puisque le runtime est neuf.
      const needsTodoTools = !!sessionId;
      // Navigateur piloté : on déclare le panel de prévisualisation comme cible
      // de l'agent (parité Trae SOLO).
      const wantsBrowser = !!sessionId;
      // Browser › « Allow AI to Control Built-in Browser » : si l'utilisateur a
      // coupé le pilotage du navigateur intégré, on n'expose pas les outils
      // browser_* à l'agent (le contrat système reste cohérent côté prompts).
      const browserAllowed = wantsBrowser && isBuiltinControlEnabled();
      // Recherche dans l'index local : exposée à l'agent UNIQUEMENT en mode
      // Agent/SOLO (`act`). En plan/ask (lecture seule sans action), l'index
      // n'est pas branché — parité avec le comportement attendu, et on évite
      // d'ajouter un outil de recherche à des modes qui n'agissent pas.
      const wantsCodeIndex = !!sessionId && opts.sdkMode === "act";
      // Outils de COMPRÉHENSION DU PROJET (arborescence, git, symboles, imports) :
      // exposés dans les mêmes conditions que l'index — modes qui AGISSENT
      // (`act`). Inutiles en ask/plan (pas d'action), donc on ne les branche pas
      // là pour ne pas élargir inutilement la surface d'outils du modèle.
      // DE PLUS, on respecte la préférence Settings › Agent : si la famille est
      // coupée, elle n'est pas seulement masquée du prompt, elle n'est PAS
      // branchée côté sidecar. Sinon deux dérives : (a) le modèle disposerait
      // d'outils absents de son contrat (incohérence prompt/outils), (b) le
      // client croirait avoir désactivé une capacité qui reste appelable.
      const wantsProjectTools =
        !!sessionId
        && opts.sdkMode === "act"
        && isFamilyEnabled(["project_overview", "git_status", "git_diff", "search_symbols", "find_imports"]);
      // CONTRÔLE QUALITÉ : l'outil `detect_checks` lit les manifestes du projet
      // (via `read_file`, confiné au workspace) pour en déduire les commandes de
      // vérification (typecheck, tests, lint, build). Il DÉTECTE mais N'EXÉCUTE
      // PAS : l'exécution reste sur `run_commands` (chemin unique, une seule
      // politique d'approbation). Mêmes conditions de branchement que la
      // compréhension projet + respect de la préférence Settings › Agent.
      const wantsQualityTools =
        !!sessionId
        && opts.sdkMode === "act"
        && isFamilyEnabled(["detect_checks"]);
      // Escalade d'équipe « à la demande » : en mode IA et sans agent
      // personnalisé, on offre TOUJOURS l'outil léger `escalate_to_team`. Le
      // modèle l'appelle s'il juge la tâche trop large, ce qui déclenche une
      // relance AVEC les équipes (voir plus bas). Présent même quand les équipes
      // sont déjà actives : un appel devient alors un no-op côté front.
      const wantsEscalate = opts.enableEscalate;
      const extraTools = [
        ...(needsTodoTools ? [{ kind: "todo" as const, sessionId }] : []),
        ...(browserAllowed
          ? [{ kind: "browser" as const, sessionId, panelId: PREVIEW_ACTIVE_TARGET }]
          : []),
        ...(wantsCodeIndex ? [{ kind: "code_index" as const, sessionId }] : []),
        ...(wantsProjectTools ? [{ kind: "project" as const, sessionId }] : []),
        ...(wantsQualityTools ? [{ kind: "quality" as const, sessionId }] : []),
        ...(wantsEscalate ? [{ kind: "team_escalate" as const, sessionId }] : []),
      ];
      // Dotation MCP d'un agent personnalisé : on n'autorise que les serveurs
      // explicitement cochés. RÉAPPLIQUÉE à chaque `start` (même raison que les
      // outils custom : le re-seed reconstruit le runtime, donc l'autorisation
      // doit être réaffirmée, sinon un agent restreint ré-verrait tous les
      // serveurs au 2ᵉ tour — régression de sécurité).
      // `undefined` (pas d'agent) → tous les serveurs restent exposés.
      const enabledMcpServers = activeAgentRef.current ? activeAgentRef.current.mcp : undefined;
      // Poignée d'annulation du tour EN COURS, partagée avec le callback
      // d'escalade : `onToolEvent` peut se déclencher pendant le `start`, donc on
      // ne peut pas capturer `handle` (encore non assigné) dans sa closure.
      // Conteneur (et non simple variable) : TypeScript n'analyserait qu'une
      // variable affectée après coup comme `never` dans la closure.
      const self: { abort: (() => Promise<void>) | null } = { abort: null };
      const handle = await startClineHarness({
        // `fp` est garanti non vide par la garde-fou workspace ci-dessus : pas de
        // fallback `.` (qui pointerait sur le cwd du process, hors projet).
        workspace: fp,
        providerId: clineProvider.providerId,
        baseUrl: clineProvider.baseUrl,
        // Le protocole (chat-completions / responses / messages) vient du format
        // d'API choisi par le client : sans lui, tout partirait en OpenAI-compatible.
        ...(clineProvider.clientType ? { clientType: clineProvider.clientType } : {}),
        // Plafond de tours d'outils par tour (503 par défaut si non renseigné).
        ...(clineProvider.maxIterations ? { maxIterations: clineProvider.maxIterations } : {}),
        apiKey: apiKey ?? "",
        modelId: apiModelId,
        systemPrompt: opts.systemPrompt,
        mode: opts.sdkMode,
        enableTeams: opts.enableTeams,
        ...(clineSessionId ? { resumeSessionId: clineSessionId } : {}),
        ...(extraTools.length > 0 ? { extraTools } : {}),
        ...(enabledMcpServers ? { enabledMcpServers } : {}),
        onEvent: handleEvent,
        onToolEvent: (evt) => {
          // Effets d'outils custom (todo_write) : on applique dans le store
          // réactif de la session UI pour que la liste épinglée se rafraîchisse.
          if (evt.tool === "todo" && evt.todos) setTodos(evt.sessionId, evt.todos as import("../../lib/agent/todoStore").TodoItem[]);
          // ESCALADE D'ÉQUIPE (pilotée par le modèle) : le modèle, en plein tour
          // léger, juge la tâche trop large et demande les équipes. On marque la
          // conversation COLLANTE puis on relance à froid AVEC les équipes.
          //
          // Le travail du tour léger n'est PAS perdu : il a déjà été écrit dans
          // `run.messages` (via `updateThread`) et persisté en DB, et la relance
          // part de ce même fil (`resumeSessionId` → re-seed `initialMessages`).
          // Le nouveau tour reprend donc exactement là où le modèle s'est arrêté.
          // Garde-fous :
          //  - un seul déclenchement par escalade (`teamsEnabled` fait office de
          //    verrou : toute demande ultérieure est un no-op) → pas de boucle ;
          //  - on ABANDONNE le tour léger (il a fini son travail utile ; le SDk le
          //    laisse sinon poursuivre sans les outils d'équipe, en divergence).
          if (evt.tool === "team_escalate" && !run.teamsEnabled && opts.enableEscalate) {
            run.teamsEnabled = true;
            const r = evt.reason?.trim();
            showToast(r ? `Working with a team: ${neutralizeForClient(r)}` : "Working with a team on this task.", "info");
            void (async () => {
              try {
                // Abandon du tour léger via la poignée partagée (pas `handle` :
                // encore non assigné au moment où `onToolEvent` est câblé).
                await self.abort?.();
                // Nouveau run à froid (`enableTeams:true`) sur la MÊME session : la
                // reprise re-seede l'historique, donc le travail du tour léger est
                // conservé. `enableEscalate:false` : les équipes sont là, plus rien
                // à escalader. On ne renvoie AUCUN texte — tout est déjà dans
                // l'historique re-seedé.
                await runCline({
                  systemPrompt: opts.systemPrompt,
                  sdkMode: opts.sdkMode,
                  enableTeams: true,
                  enableEscalate: false,
                  prompt: "",
                });
              } catch (err) {
                log.error("ai/panel", `escalade d'équipe échouée : ${(err as Error)?.message ?? String(err)}`);
              }
            })();
          }
        },
        onExtensions: (ext) => {
          // Surface d'extension résolue au `start` : on l'expose à l'input
          // (skills réelles + slash-commands). Les problèmes non fatals sont
          // signalés une fois, sans bloquer le run.
          setSessionExtensions(ext);
          for (const issue of ext.issues) {
            // Dernière barrière avant l'écran : on neutralise toute marque interne.
            showToast(`Extension ${issue.scope}: ${neutralizeForClient(issue.message)}`, "error");
          }
        },
        onBlocked: (action, reason) => {
          // Refus d'office (garde anti-catastrophe) : on l'EXPLIQUE, on ne
          // l'avale pas. Le SDK reçoit un échec d'outil côté agent.
          void action;
          showToast(reason, "error");
        },
        onBeforeWrite: (path, ws) => touchTurn(path, ws ?? fp),
      });
      if (!handle) {
        handleEvent({ type: "error", message: "The agent engine did not start (sidecar unavailable)." });
        return null;
      }
      // Expose la poignée d'annulation du tour vivant au callback d'escalade.
      self.abort = () => handle.abort();
      // Persiste la session SDK attribuée : les tours suivants la reprendront.
      if (sessionId && handle.sessionId && handle.sessionId !== clineSessionId) {
        setClineSessionId(sessionId, handle.sessionId)
          .catch(err => console.error("[AiPanel] DB setClineSessionId failed:", err));
      }
      // Annulation : coupe le tour en cours côté SDK, puis détache l'écouteur.
      run.cleanup = () => {
        void handle.abort();
        handle.dispose();
      };
      // MULTITASKING : on publie l'abort au registre de statut pour qu'une
      // interruption externe (rail de tâches, fermeture) coupe CE run précis.
      taskRun.setAbort(() => {
        void handle.abort();
        handle.dispose();
      });
      return handle;
    };

    if (mode === "plan") {
      currentModeRef.current = "plan";
      // Phase 2 (après approbation du plan) : on REJOUE sur la MÊME session Cline
      // en mode `act` — l'agent a déjà tout le contexte du plan dans son
      // historique, on lui demande juste de passer à l'implémentation.
      startPlanExecutionRef.current = async () => {
        // Phase 2 : on cible le run de la session ACTIVE au moment de l'exécution
        // (l'utilisateur a pu basculer de tâche entre-temps).
        const phase2Run = getRun(activeSessionIdRef.current);
        if (activeSessionIdRef.current) {
          try {
            const aid = await insertMessage({ sessionId: activeSessionIdRef.current, messageType: "assistant", content: "", status: "streaming", model: modelId });
            phase2Run.pendingAssistantDbId = aid;
          } catch { /* ignore */ }
        }
        phase2Run.pendingContent = "";
        phase2Run.pendingParts = [];
        setMessages(prev => [...prev, { role: "assistant", content: "", streaming: true, parts: [] }]);

        const phase2IsMax = (localStorage.getItem("origin-ai-effort") ?? "normal") === "max";
        const phase2SystemPrompt = withOriginMd(localStorage.getItem("origin-ai-system-prompt") ?? buildSystemPrompt("agent", phase2IsMax));
        const handle = await runCline({ systemPrompt: phase2SystemPrompt, sdkMode: "act", enableTeams: false, enableEscalate: false, prompt: "" });
        // `mode:"act"` explicite : la session a été créée en lecture seule pour
        // le plan ; on la bascule en exécution pour la phase d'implémentation.
        if (handle) await handle.send("The plan has been approved. Proceed with the implementation now.", "act");
      };

      // Phase 1 : plan en lecture seule.
      const handle = await runCline({ systemPrompt: planSystemPrompt, sdkMode: "plan", enableTeams: false, enableEscalate: false, prompt: "" });
      if (handle) await handle.send(apiText);
    } else if (mode === "ask") {
      // Ask : lecture seule (le SDK en mode `plan` ne modifie aucun fichier).
      const handle = await runCline({ systemPrompt: askSystemPrompt, sdkMode: "plan", enableTeams: false, enableEscalate: false, prompt: "" });
      if (handle) await handle.send(apiText);
    } else {
      // ── Modes IDE et IA : exécution complète ─────────────────────────────────
      // IDE (conversation créée en IDE) : un SEUL agent (`enableTeams:false`),
      //   volontairement sans orchestration pour économiser les tokens.
      // IA  (conversation créée en AI)  : les équipes Cline orchestrent elles-
      //   mêmes (sous-agents, coordination) — l'UI route leurs flux par `spawnId`.
      //
      // Le contexte projet reste porté par `systemPrompt` (composé plus haut) :
      // on y ajoute l'état réel du contexte seulement en IA (le root Cline le lit
      // comme n'importe quelle consigne).
      const contextStatus = convIsAgent ? contextStatusPrompt(modelMessages, DEFAULT_TOKEN_BUDGET) : "";
      const rootSystemPrompt = contextStatus ? `${systemPrompt}\n\n---\n\n${contextStatus}` : systemPrompt;

      if (convIsAgent) run.spawned = 0;

      // ── ÉQUIPES « À LA DEMANDE » (pilotées par le MODÈLE) ───────────────────
      // En mode IA, exposer les 18 outils `team_*` alourdit CHAQUE requête (coût
      // de TTFT fixe imposé par le SDK). On ne les ouvre donc PAS d'emblée : on
      // démarre LÉGER (comme l'IDE) et on expose un unique outil `escalate_to_team`.
      //
      // POURQUOI PAS UN CLASSIFICATEUR DE TEXTE : juger la forme d'une demande
      // (longueur, mots-clés, puces) ne dit RIEN de la complexité réelle du
      // travail à fournir. Seul le modèle, une fois face au code, sait s'il bute
      // sur l'ampleur. L'escalade est donc décidée PENDANT le run : s'il juge la
      // tâche trop large, il appelle `escalate_to_team`, le front coupe ce tour et
      // relance AVEC les équipes en réinjectant l'historique (le travail déjà fait
      // est conservé — cf. `onToolEvent`).
      // `run.teamsEnabled` reste COLLANT : une conversation déjà passée en équipes
      // ne rebascule pas en runtime allégé en plein travail d'équipe.
      const wantTeams = convIsAgent && !selectedAgent && run.teamsEnabled;
      // Un agent personnalisé est SINGULIER : jamais d'équipes ni d'escalade.
      const enableEscalate = convIsAgent && !selectedAgent && !wantTeams;

      const handle = await runCline({ systemPrompt: rootSystemPrompt, sdkMode: "act", enableTeams: wantTeams, enableEscalate, prompt: "" });
      if (handle) await handle.send(apiText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getFileContents is read fresh at call time; including it would churn this callback
  }, [showToast, isAgent, setSessionAppMode]);

  // Maintient le miroir de `handleSend` à jour (cf. déclaration de la ref).
  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  // Charge les agents personnalisés et garde `activeAgentRef` aligné sur la
  // sélection de l'input (`origin-ai-agent`). On recharge aussi à chaque
  // changement (événement `CUSTOM_AGENTS_EVENT`, émis par le store front) : un
  // agent supprimé/renommé est immédiatement reflété.
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void listAgents().then(list => {
        if (cancelled) return;
        activeAgentRef.current = resolveSelectedAgent(list, readSelectedAgentId());
      });
    };
    reload();
    window.addEventListener(CUSTOM_AGENTS_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(CUSTOM_AGENTS_EVENT, reload);
    };
  }, []);
  // Maintient le miroir `queuedMessageRef` synchronisé avec l'état.
  useEffect(() => { queuedMessageRef.current = queuedMessage; }, [queuedMessage]);

  /**
   * Met un message en file d'attente (l'utilisateur a envoyé pendant un tour en
   * cours). Renvoie toujours `true` : la file accepte le message. Un nouvel
   * envoi remplace le précédent (un seul message en attente, comme Trae).
   */
  const handleQueue = useCallback((
    text: string, modelId: string, providerId: string,
    fileMentions: string[], editorContext: EditorContext | null, mode: "agent" | "ask" | "plan",
    contextRefs: ContextRef[],
  ): boolean => {
    setQueuedMessage(enqueueMessage(null, {
      text, modelId, providerId, fileMentions, editorContext, mode,
      contextRefs: contextRefs.length > 0 ? serializeContextRefs(contextRefs) : undefined,
    }));
    return true;
  }, []);

  /**
   * Envoie le message en attente si présent. Appelé à la fin d'un tour (fin,
   * erreur ou stop) pour enchaîner automatiquement. Le flag `dequeuingRef`
   * évite un double envoi lorsque plusieurs signaux de fin se chevauchent.
   */
  const flushQueue = useCallback(() => {
    if (dequeuingRef.current) return;
    const next = dequeueMessage(queuedMessageRef.current);
    if (!next) return;
    dequeuingRef.current = true;
    setQueuedMessage(null);
    // Laisse le tour précédent se stabiliser (état `streaming` retombé) avant de
    // relancer, pour que `isStreaming` soit bien recalculé côté rendu.
    setTimeout(() => {
      dequeuingRef.current = false;
      // Les refs `#` sont stockées sérialisées dans la file ; on les reparse en
      // `ContextRef` avant l'envoi (même canal que l'envoi direct).
      const refs = (next.contextRefs ?? [])
        .map(parseContextRef)
        .filter((r): r is ContextRef => r !== null);
      handleSendRef.current?.(next.text, next.modelId, next.providerId, next.fileMentions, next.editorContext, next.mode, refs);
    }, 0);
  }, []);

  // Expose `flushQueue` aux handlers stables (events du stream) via une ref.
  useEffect(() => { flushQueueRef.current = flushQueue; }, [flushQueue]);

  // Annule le tour en cours. `cancel()` ne détache pas le flag `streaming`
  // (aucun event n'est émis à l'abort), on le remet donc à false nous-mêmes,
  // et on persiste le contenu partiel comme « interrupted » — comme le fait
  // déjà la sélection de session / nouveau chat.
  const handleStop = useCallback(() => {
    // Invalide le run courant : ses events tardifs (ex. un `tool-result` d'un
    // outil déjà en vol) sont désormais ignorés par `handleEvent`, au lieu de
    // continuer à muter le fil après l'arrêt.
    // MULTITASKING : on n'arrête QUE le run de la session active.
    const run = getRun(activeSessionIdRef.current);
    run.seq++;
    run.cleanup?.();
    run.cleanup = null;
    // MULTITASKING : l'utilisateur a stoppé CE run → la tâche est « interrupted »
    // dans le registre (elle cesse d'être comptée comme active).
    run.task?.interrupt();
    run.task = null;

    // La bannière de revue RESTE affichée après un stop : l'utilisateur peut
    // encore « Undo all » ce qui a été écrit. On rafraîchit une dernière fois
    // pour capter l'état exact des écritures du tour interrompu.
    const stopTurnId = activeTurnIdRef.current;
    if (stopTurnId) refreshReview(stopTurnId, true);

    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    const prevDbId = run.pendingAssistantDbId;
    if (prevDbId) {
      run.pendingAssistantDbId = null;
      updateMessageContent(prevDbId, run.pendingContent, "interrupted").catch(() => {});
    }

    setMessages(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streaming) { next[i] = { ...next[i], streaming: false }; break; }
      }
      return next;
    });

    // L'utilisateur a stoppé le tour : on enchaîne le message en attente, s'il
    // existe (il l'avait saisi en connaissance de cause pendant le run).
    flushQueueRef.current?.();
    // Une question en attente n'a plus de run pour la consommer : on la retire.
    setPendingQuestion(null);

    // Arrêt brutal (volontaire) : SON seul, jamais de toast — l'action vient de
    // l'utilisateur, la commenter serait du bruit. `activeSessionIdRef` identifie
    // la tâche stoppée (multitâche).
    const stoppedSid = activeSessionIdRef.current;
    if (stoppedSid) notifyTask("stop", stoppedSid);
  }, [refreshReview, notifyTask]);

  /** Retire de la file le message en attente (l'utilisateur a changé d'avis). */
  const handleRemoveQueued = useCallback(() => {
    setQueuedMessage(null);
  }, []);

  /**
   * Réinjecte dans l'éditeur le message en attente pour le corriger, et le
   * retire de la file (l'utilisateur doit le renvoyer lui-même). Les mentions de
   * fichiers ne sont pas réinjectées : elles sont retapables, et les re-placer
   * correctement dans un contentEditable est fragile.
   */
  const handleEditQueued = useCallback(() => {
    const q = queuedMessageRef.current;
    if (!q) return;
    setQueuedMessage(null);
    chatBoxRef.current?.setText(q.text);
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
    // Tout ce qui suit le point de troncature n'existe plus : plus rien à
    // annuler/conserver au-delà de cet index.
    setRevertableIndexes(prev => prev.filter(idx => idx < fromIndex));
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

  // « Revert » (message utilisateur) : on annule TOUT ce qui a été généré depuis
  // ce message — les fichiers écrits par TOUS les tours du run (créés → supprimés,
  // modifiés → restaurés) ET les messages qui suivent. Avant d'agir, on affiche
  // à l'utilisateur la liste exacte de ce qui sera supprimé / restauré : le revert
  // est destructif, il doit être confirmé en connaissance de cause.
  /** Rassemble tous les turnIds ouverts depuis `userIndex` (inclus). */
  const collectTurnIdsFrom = useCallback((userIndex: number): string[] => {
    return collectTurnIdsFromPure(turnIdsByUserIndexRef.current, userIndex);
  }, []);

  // `force` court-circuite la garde `isStreaming` : « Undo all » appelle cette
  // fonction APRÈS avoir avorté le run, et l'état `isStreaming` (dérivé des
  // messages) n'est pas encore retombé au moment de l'appel — sans ce drapeau,
  // l'annulation serait silencieusement ignorée (« bypass » constaté).
  const handleRevertUserMessage = useCallback(async (userIndex: number, force = false) => {
    if (isStreaming && !force) return;
    // Dernière digue : on ne rejoue jamais un revert tant qu'un run tourne encore.
    if (getRun(activeSessionIdRef.current).cleanup) return;
    const fp = folderPathRef.current ?? "";
    const turnIds = collectTurnIdsFrom(userIndex);
    // Aucun checkpoint (ex. échanges en mode Ask, ou tours déjà gardés) : on
    // tronque simplement l'historique, il n'y a rien à restaurer sur disque.
    if (turnIds.length === 0) {
      void truncateFrom(userIndex);
      return;
    }
    try {
      const plan = await previewRevertTurns(turnIds, fp || null);
      const deletes = plan.filter(p => p.action === "delete").length;
      const restores = plan.length - deletes;
      // Rien à modifier sur disque : on tronque sans dialogue inutile.
      if (plan.length === 0) {
        void truncateFrom(userIndex);
        return;
      }
      setRevertConfirm({ userIndex, plan });
      // Rappel du volume pour un plan volumineux : l'utilisateur voit le dialogue.
      if (deletes + restores > 0) {
        showToast(`Revert: ${deletes} to delete, ${restores} to restore`, "info");
      }
    } catch (e) {
      showToast(`Revert preview failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [isStreaming, showToast, truncateFrom, collectTurnIdsFrom]);

  // Exécute le revert confirmé : applique le plan sur disque, puis tronque
  // l'historique à partir du message utilisateur concerné.
  const handleConfirmRevert = useCallback(async () => {
    const pending = revertConfirm;
    if (!pending) return;
    const { userIndex, plan } = pending;
    const fp = folderPathRef.current ?? "";
    const turnIds = collectTurnIdsFrom(userIndex);
    try {
      const applied = await revertTurns(turnIds, fp || null);
      // Les checkpoints consommés ne sont plus valides : purge de l'état local.
      turnIdsByUserIndexRef.current = keepFrom(turnIdsByUserIndexRef.current, userIndex);
      activeTurnIdRef.current = null;
      activeTurnUserIndexRef.current = null;
      setRevertableIndexes(prev => revertableIndexesAfterKeep(prev, userIndex));
      // Les messages annulés disparaissent : leurs marqueurs « gardé » aussi.
      setKeptReviews(prev => keptReviewsBefore(prev, userIndex));
      setReviewBanner(null);
      setRevertConfirm(null);
      const deletes = plan.filter(p => p.action === "delete").length;
      const restores = plan.length - deletes;
      showToast(`Reverted: ${deletes} deleted, ${restores} restored`, "success");
      void truncateFrom(userIndex);
      // L'éditeur affichait le contenu d'avant l'annulation : on le resynchronise
      // sur l'état réel du disque (fichiers restaurés relus, onglets supprimés
      // fermés). Sans cela, corriger le fichier après un revert réécrivait par
      // dessus le contenu annulé — le « bypass » constaté.
      void externalFileChangesRef.current?.(applied.map(p => p.path));
    } catch (e) {
      showToast(`Revert failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [revertConfirm, showToast, truncateFrom, collectTurnIdsFrom]);

  const handleCancelRevert = useCallback(() => setRevertConfirm(null), []);

  // Toute action sur un message (copier, éditer, régénérer) vaut « Keep all » du
  // checkpoint courant : l'utilisateur ne reviendra plus en arrière sur ce tour,
  // et on évite ainsi de laisser une bannière Undo pointer sur un état obsolète.
  const handleMessageAction = useCallback(() => {
    const prevTurn = activeTurnIdRef.current;
    const prevIdx = activeTurnUserIndexRef.current;
    if (prevTurn) {
      activeTurnIdRef.current = null;
      discardTurnCheckpoint(prevTurn).catch(() => {});
    }
    // L'action vaut « keep » du tour courant : tous les tours couverts par ce
    // message sont actés, on les oublie pour ne pas laisser de tours fantômes.
    if (prevIdx !== null) {
      turnIdsByUserIndexRef.current = keepFrom(turnIdsByUserIndexRef.current, prevIdx);
      setRevertableIndexes(prev => revertableIndexesAfterKeep(prev, prevIdx));
      // On fige aussi le marqueur visuel « gardé » pour ce message.
      setKeptReviews(prev => (prev[prevIdx] ? prev : { ...prev, [prevIdx]: [] }));
    }
    setReviewBanner(null);
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

  // Ouvre un chemin cité en TEXTE BRUT (fichier ou dossier). On résout d'abord
  // le chemin absolu, puis on interroge le FS pour lever l'ambiguïté : `readDir`
  // n'aboutit que sur un dossier.
  //
  // Décision (sans biais, selon le contexte) :
  //  - DOSSIER déjà DANS le workspace courant → révélé dans le gestionnaire
  //    système (l'arbre Mira l'affiche déjà).
  //  - DOSSIER HORS du workspace (ex. un repo que l'agent vient de cloner
  //    ailleurs) → ouvert COMME workspace : c'est le seul moyen de le voir dans
  //    Mira, sinon il resterait invisible.
  //  - FICHIER → ouvert dans l'éditeur.
  // Aucune action si le chemin n'existe pas (pas de fausse promesse).
  const handleOpenPath = useCallback((path: string) => {
    if (!path) return;
    const fp = folderPathRef.current ?? "";
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
    const abs = isAbsolute || !fp
      ? path
      : `${fp.replace(/[\\/]$/, "")}/${path.replace(/^[\\/]+/, "")}`;
    const scope = { workspaceRoot: fp || null };
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const insideWorkspace = fp
      ? norm(abs) === norm(fp) || norm(abs).startsWith(norm(fp) + "/")
      : false;
    void (async () => {
      let isDir = /[\\/]$/.test(path);
      if (!isDir) {
        try {
          await readDir(abs, scope);
          isDir = true;
        } catch {
          // Pas un dossier accessible : on considère que c'est un fichier. Si le
          // dossier est HORS workspace, `readDir` est refusé par la garde de
          // confinement : on retente sans scope pour ne pas rater un vrai dossier.
          try {
            await readDir(abs);
            isDir = true;
          } catch {
            isDir = false;
          }
        }
      }
      if (isDir) {
        if (insideWorkspace) await revealInExplorer(abs).catch(() => {});
        else setFolderPath(abs);
        return;
      }
      handleOpenFile(abs);
    })();
  }, [handleOpenFile, setFolderPath]);

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
    const prevSessionId = activeSessionIdRef.current;
    // MULTITASKING : une nouvelle conversation ne coupe PLUS un run en
    // arrière-plan. On mémorise simplement le fil de la session quittée pour
    // pouvoir le RÉAFFICHER (flux direct) à la reprise ; le run continue de
    // vivre et de persister son message assistant normalement. On ne fige donc
    // RIEN en « interrupted » et on n'invalide PAS `pendingAssistantDbId`, sinon
    // la tâche d'arrière-plan perdrait sa cible d'écriture DB.
    if (prevSessionId) {
      setRunMessages(prevSessionId, messagesRef.current);
    }

    setMessages([]);
    setActiveSessionId(null);
    // Nouvelle conv : plus aucun mode mémorisé — il sera figé au premier envoi.
    setSessionAppMode(null);
    const fp = folderPathRef.current ?? "";
    localStorage.removeItem(activeSessionKey(fp));
    onActiveSessionChangeRef.current?.(null);
    setChatView("new");
    localStorage.removeItem("origin-ai-chat-view");
    setSessions(lsForPath(fp));
  }, [setActiveSessionId, setSessionAppMode]);

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
  // Pendant un run (`getRun(...).cleanup` non nul), la bannière est « live » :
  //   • « Keep all » masque seulement la revue SANS purger le checkpoint — le run
  //     continue et de nouvelles écritures doivent rester annulables. Purger ici
  //     casserait « Undo all » pour la suite du tour.
  //   • « Undo all » reste disponible : il annule réellement ce qui a été écrit
  //     (après avoir stoppé le run en cours, cf. ci-dessous).
  // Hors run, « Keep all » oublie le checkpoint (les écritures restent), comme avant.
  const handleKeepAll = useCallback(async () => {
    const banner = reviewBanner;
    if (!banner) return;
    if (getRun(activeSessionIdRef.current).cleanup) {
      // Run en cours : on masque la revue mais on NE purge PAS le checkpoint (les
      // écritures à venir doivent rester annulables). On rafraîchit aussitôt —
      // SANS annuler le timer de fond ni toucher `activeTurnIdRef` — pour que la
      // bannière réapparaisse dès que le résumé contient encore des fichiers.
      setReviewBanner(null);
      if (banner.turnId === activeTurnIdRef.current) refreshReviewNow(banner.turnId);
      return;
    }
    // Hors run : on fige le résumé AVANT de purger, pour le marqueur « gardé ».
    const files = await keepTurnCheckpoint(banner.turnId).catch(() => banner.files);
    // TOUS les tours couverts par ce message sont actés : on les oublie, sinon
    // ils resteraient « fantômes » (encore annulables alors que leur checkpoint
    // n'existe plus sur disque) et « Undo » viserait une mauvaise cible.
    turnIdsByUserIndexRef.current = keepFrom(turnIdsByUserIndexRef.current, banner.userIndex);
    setKeptReviews(prev => ({ ...prev, [banner.userIndex]: files.length > 0 ? files : banner.files }));
    setRevertableIndexes(prev => revertableIndexesAfterKeep(prev, banner.userIndex));
    setReviewBanner(null);
    showToast("Changes kept", "success");
  }, [reviewBanner, showToast, refreshReviewNow]);

  // « Undo all » : annule le run représenté par la bannière. La PORTÉE est
  // portée par la bannière elle-même (`userIndex`) — plus aucune déduction sur
  // le dernier index connu, qui pouvait viser un autre run. Pendant un run, on
  // annule D'ABORD le run en cours (abort) : sinon une écriture encore « en vol »
  // recréerait le fichier juste après la restauration.
  const handleUndoAll = useCallback(async () => {
    const banner = reviewBanner;
    if (!banner) return;
    // Run en cours : on l'arrête proprement avant d'annuler (mêmes garanties que
    // `handleStop`), sinon l'annulation serait aussitôt défaite par l'agent.
    const run = getRun(activeSessionIdRef.current);
    if (run.cleanup) {
      run.seq++;
      run.cleanup?.();
      run.cleanup = null;
      run.task?.interrupt();
      run.task = null;
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].streaming) { next[i] = { ...next[i], streaming: false }; break; }
        }
        return next;
      });
      setPendingQuestion(null);
    }
    // `force = true` : le run vient d'être avorté, mais `isStreaming` n'est pas
    // encore retombé — on contourne la garde pour que l'annulation soit réellement
    // appliquée (sinon Undo all pendant un run ne faisait rien : instabilité).
    await handleRevertUserMessage(banner.userIndex, true);
  }, [reviewBanner, handleRevertUserMessage]);

  // ── Actions CIBLÉES par message (au survol, comme Trae) ───────────────────
  // Le bouton « Keep » d'un message utilisateur acte UNIQUEMENT les tours
  // générés depuis ce message : on fige le résumé (marqueur visuel), on purge
  // les checkpoints correspondants, et on retire tout tour suivi depuis cet
  // index. On NE touche ni au run en cours ni aux autres messages.
  const handleKeepMessage = useCallback(async (userIndex: number) => {
    const turnIds = collectTurnIdsFrom(userIndex);
    let files: TurnFileDelta[] = [];
    for (const turnId of turnIds) {
      const summary = await keepTurnCheckpoint(turnId).catch(() => [] as TurnFileDelta[]);
      if (summary.length > 0) files = summary;
    }
    // Tous les tours de ce message sont actés : on les oublie (plus d'Undo ciblé).
    turnIdsByUserIndexRef.current = keepFrom(turnIdsByUserIndexRef.current, userIndex);
    if (reviewBanner && reviewBanner.userIndex >= userIndex) setReviewBanner(null);
    setRevertableIndexes(prev => revertableIndexesAfterKeep(prev, userIndex));
    setKeptReviews(prev => ({ ...prev, [userIndex]: files }));
    showToast("Changes kept", "success");
  }, [collectTurnIdsFrom, reviewBanner, showToast]);

  // Bouton « Undo » ciblé d'un message : même sémantique que « Revert » (annule
  // fichiers + historique depuis ce message), exposé au survol pour coller au
  // geste Trae (Undo/Keep côte à côte par message).
  const handleUndoMessage = useCallback((userIndex: number) => {
    void handleRevertUserMessage(userIndex);
  }, [handleRevertUserMessage]);

  // État d'action d'un message utilisateur : « kept » (fichiers actés),
  // « revertable » (des checkpoints existent → Undo/Keep disponibles), ou aucun.
  // On s'appuie sur l'état local (marqueurs + tours suivis) : c'est réactif et
  // suffisant pour piloter l'affichage des boutons.
  const messageReviewState = useCallback((userIndex: number): { kept: boolean; revertable: boolean; files: TurnFileDelta[] } => {
    const keptFiles = keptReviews[userIndex];
    const hasTurns = revertableIndexes.includes(userIndex);
    return { kept: keptFiles !== undefined, revertable: hasTurns, files: keptFiles ?? [] };
  }, [keptReviews, revertableIndexes]);

  // Ouvre le diff relatif au tour : « avant » (backup du checkpoint) vs état
  // courant. Réutilise l'onglet diff de l'IA en mode lecture seule (approve et
  // reject sont des no-op — la bannière Undo/Keep reste la seule action).
  const handleOpenCheckpointDiff = useCallback(async (file: TurnFileDelta) => {
    const banner = reviewBanner;
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
  }, [reviewBanner, onOpenDiffTab, getFileContents, showToast]);

  // ── Surface agent (mode Agent) : alimente DiffView / DocView ──────────────
  //
  // Trae garde ces panneaux synchronisés avec la tâche courante sans qu'ils
  // détiennent d'état : on fait pareil en poussant au parent l'état dérivé de la
  // conversation (fichiers en revue + dernier document). Le parent ne fait que
  // déléguer l'affichage — aucune duplication de logique.
  //
  // `docMarkdown` = dernier texte assistant SUBSTANTIEL (on ignore les bulles
  // vides / purement outillage). C'est le meilleur candidat au rôle « document »
  // (réponse, PRD, note de solution), celui que Trae affiche dans DocView.
  const docMarkdown = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const text = (m.parts ?? [])
        .filter((p): p is { type: "text"; content: string } => p.type === "text")
        .map(p => p.content)
        .join("\n\n")
        .trim() || m.content.trim();
      if (text.length >= 40) return text;
    }
    return "";
  }, [messages]);

  const pendingPlan = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i].parts ?? [];
      for (const p of parts) {
        if (p.type === "plan-card" && p.status === "pending") return p.plan;
      }
    }
    return null;
  }, [messages]);

  // Tool-calls `running`, par ordre chronologique — alimente le Flow. On ne
  // retient que le nom : le parent décide de l'onglet, il n'a pas besoin du reste.
  const runningTools = useMemo(() => {
    const out: { toolName: string }[] = [];
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool-call" && p.tc.status === "running") out.push({ toolName: p.tc.toolName });
      }
    }
    return out;
  }, [messages]);

  // Surface poussée au parent (AgentModeView) : on mémorise la dernière clé de
  // contenu envoyée pour NE PAS repousser un objet identique. Sans ce garde-fou,
  // chaque rendu recréait un objet neuf (`[]` pour reviewFiles, etc.), l'effet
  // dépendant de `reviewBanner`/`runningTools` se relançait, le parent faisait
  // `setSurface(newObj)` → re-rendu → effet → … : boucle infinie
  // « Maximum update depth exceeded ».
  const lastSurfaceKeyRef = useRef<string>("");

  useEffect(() => {
    if (!onAgentSurface) return;
    // Clé de contenu : ne dépend que des valeurs réellement affichées. Les
    // callbacks (identité stable via useCallback) sont volontairement exclus.
    const key = JSON.stringify({
      files: (reviewBanner?.files ?? []).map(f => `${f.path}:${f.added}:${f.removed}:${f.created ? 1 : 0}`),
      doc: docMarkdown,
      plan: pendingPlan,
      running: runningTools.map(t => t.toolName),
      isRunning: isStreaming,
    });
    if (key === lastSurfaceKeyRef.current) return;
    lastSurfaceKeyRef.current = key;
    onAgentSurface({
      reviewFiles: reviewBanner?.files ?? [],
      undoAll: reviewBanner ? handleUndoAll : undefined,
      keepAll: reviewBanner ? handleKeepAll : undefined,
      openDiff: onOpenDiffTab ? handleOpenCheckpointDiff : undefined,
      docMarkdown,
      plan: pendingPlan,
      runningTools,
      isRunning: isStreaming,
    });
  }, [onAgentSurface, reviewBanner, handleUndoAll, handleKeepAll, handleOpenCheckpointDiff, onOpenDiffTab, docMarkdown, pendingPlan, runningTools, isStreaming]);

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
      setSessionAppMode(null);
      localStorage.removeItem(activeSessionKey(fp));
      onActiveSessionChangeRef.current?.(null);
    }
    deleteSession(sessionId).catch(err => console.error("[AiPanel] Failed to delete session:", err));
    // La todo list suit la conversation : on la purge avec elle.
    clearTodos(sessionId);
    // Le résumé de compaction est attaché à la session : on le supprime aussi
    // pour ne pas laisser d'entrée orpheline dans le stockage local.
    clearCompactionSummary(sessionId);
  }, [setActiveSessionId, setSessionAppMode]);

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
    <div className="flex shrink-0 h-full">

      {/* ── Chat section ── */}
      <div
        className="relative flex flex-col shrink-0 overflow-hidden"
        style={{
          width,
          backgroundColor: "var(--origin-bg-sidebar)",
          // Le chat est à GAUCHE en mode agent (bordure à droite) et à DROITE
          // en mode classique (bordure à gauche) : dans les deux cas il se
          // détache franchement de la surface voisine.
          borderRight: isAgent ? "1px solid var(--origin-border-strong)" : undefined,
          borderLeft: isAgent ? undefined : "1px solid var(--origin-border-strong)",
        }}
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
            {chatView === "chat" && messages.length > 0 && (
              <Tooltip content="Copy conversation as plain text" side="left">
                <HeaderBtn label="Copy conversation" onClick={handleCopyConversation}>
                  {conversationCopied ? <Icon icon="lucide:check" width={14} /> : <Icon icon="lucide:copy" width={14} />}
                </HeaderBtn>
              </Tooltip>
            )}
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
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", gap: "18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <img src={logoCode} alt="Mira" style={{ width: 32, height: 32, flexShrink: 0 }} />
                <span style={{ fontSize: "26px", fontWeight: 700, color: "var(--origin-fg-default)" }}>Agent</span>
              </div>
              <div style={{ fontSize: "13px", color: "var(--origin-fg-muted)", textAlign: "center" }}>
                Deep understanding of complex tasks
              </div>
              {!signedIn && (
                // Non connecté : on remplace la liste de fonctionnalités par une
                // invitation claire à se connecter. Les capacités de l'agent
                // n'ont pas de sens tant qu'aucun modèle n'est disponible.
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", marginTop: "8px", maxWidth: 360 }}>
                  <span style={{ fontSize: "13px", color: "var(--origin-fg-muted)", textAlign: "center", lineHeight: 1.5 }}>
                    Sign in to Mira to start a conversation. Your plans and models are tied to your account.
                  </span>
                  <button
                    onClick={() => requestSignIn()}
                    className="flex items-center gap-2 rounded"
                    style={{
                      padding: "7px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
                      color: "#fff", backgroundColor: "var(--origin-accent-blue)",
                      border: "none",
                    }}
                  >
                    <Icon icon="lucide:log-in" width={14} />
                    Sign in
                  </button>
                </div>
              )}
              {signedIn && (
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
              )}
            </div>
            {pendingQuestion && (
              <div style={{ padding: "0 12px" }}>
                <QuestionPrompt
                  question={pendingQuestion.question}
                  options={pendingQuestion.options}
                  onAnswer={pendingQuestion.answer}
                />
              </div>
            )}
            <ChatBox onSend={handleSend} getEditorContext={getEditorContext} forcedContext={forcedContext} onForcedContextConsumed={onForcedContextConsumed} isStreaming={isStreaming} onStop={handleStop} handleRef={chatBoxRef} queued={queuedMessage} onQueue={handleQueue} onRemoveQueued={handleRemoveQueued} onEditQueued={handleEditQueued} skills={sessionExtensions?.skills} commands={sessionExtensions?.commands} onSelectFolder={onOpenFolder} getUserHistory={getUserHistory} onOptimizeError={(m) => showToast(m, "error")} />
          </div>
        )}

        {/* Active chat view */}
        {chatView === "chat" && (
          <>
            <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div ref={scrollContainerRef} onScroll={handleThreadScroll} onCopy={handleThreadCopy} style={{ flex: 1, overflowY: "auto", padding: "16px 14px 8px", display: "flex", flexDirection: "column" }}>
                {messages.map((msg, i) => (
                  <div key={i} ref={el => { if (el) messageRefsMap.current.set(i, el); else messageRefsMap.current.delete(i); }}>
                    <MessageBubble
                      message={msg}
                      onPin={handleStartPin}
                      onPlanApprove={handlePlanApprove}
                      onPlanReject={handlePlanReject}
                      onRegenerate={() => handleRegenerate(i)}
                      onEditUserMessage={() => handleEditUserMessage(i)}
                      onDeleteUserMessage={() => handleDeleteUserMessage(i)}
                      onUndoUserMessage={() => handleUndoMessage(i)}
                      onKeepUserMessage={() => handleKeepMessage(i)}
                      reviewState={msg.role === "user" ? messageReviewState(i) : undefined}
                      onInsert={() => handleInsertMessage(msg.content)}
                      onOpenFile={handleOpenFile}
                      onOpenPath={handleOpenPath}
                      onRunCommand={onRunCommand}
                      onInsertTerminal={onInsertTerminal}
                      canRegenerate={!isStreaming && i === messages.length - 1}
                      onActionCopy={handleMessageAction}
                      vote={feedbackByIndex[i] ?? null}
                      onVote={v => handleVoteMessage(i, v)}
                      /* L'anneau de contexte n'apparaît que sur le dernier message :
                         il reflète l'état courant, pas un historique par message. */
                      contextUsed={i === messages.length - 1 ? contextTokens : undefined}
                      contextBudget={i === messages.length - 1 ? DEFAULT_TOKEN_BUDGET : undefined}
                      /* La compaction manuelle n'est offerte que sur le dernier
                         message (menu de la jauge) et jamais pendant une génération. */
                      onCompact={i === messages.length - 1 && !isStreaming ? handleManualCompact : undefined}
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
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                  style={{
                    position: "absolute", bottom: "10px", left: "50%", transform: "translateX(-50%)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: "26px", height: "26px", padding: 0, borderRadius: "50%",
                    border: "1px solid var(--origin-border-default)",
                    backgroundColor: "var(--origin-bg-active)",
                    color: "var(--origin-fg-default)", cursor: "pointer",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.25)", zIndex: 5,
                  }}
                >
                  <Icon icon="lucide:arrow-down" width={14} />
                </button>
              )}
            </div>
            {activeSessionId && <PinnedTodoList sessionId={activeSessionId} />}
            {pendingQuestion && (
              <div style={{ padding: "0 12px 6px" }}>
                <QuestionPrompt
                  question={pendingQuestion.question}
                  options={pendingQuestion.options}
                  onAnswer={pendingQuestion.answer}
                />
              </div>
            )}
            {reviewBanner && (
              <div style={{ padding: "0 12px 6px" }}>
                <TurnReviewCard
                  docked
                  defaultExpanded
                  files={reviewBanner.files}
                  undo={handleUndoAll}
                  keep={handleKeepAll}
                  onOpenDiff={onOpenDiffTab ? handleOpenCheckpointDiff : undefined}
                />
              </div>
            )}
            <ChatBox onSend={handleSend} getEditorContext={getEditorContext} forcedContext={forcedContext} onForcedContextConsumed={onForcedContextConsumed} isStreaming={isStreaming} onStop={handleStop} handleRef={chatBoxRef} queued={queuedMessage} onQueue={handleQueue} onRemoveQueued={handleRemoveQueued} onEditQueued={handleEditQueued} skills={sessionExtensions?.skills} commands={sessionExtensions?.commands} onSelectFolder={onOpenFolder} getUserHistory={getUserHistory} onOptimizeError={(m) => showToast(m, "error")} />
          </>
        )}

        {/* History view */}
        {chatView === "history" && (
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            {folderPath && (
              <div style={{ padding: "12px 14px 8px", fontSize: "11px", color: "var(--origin-fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {folderPath.split(/[/\\]/).pop()}
              </div>
            )}
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
          style={{ width: contextWidth, backgroundColor: "var(--origin-bg-sidebar)", borderLeft: "1px solid var(--origin-border-strong)" }}
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
                          <MarkdownMessage content={pin.content} isStreaming={false} onOpenPath={handleOpenPath} />
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
    {revertConfirm && (
      <RevertConfirmDialog
        plan={revertConfirm.plan}
        onConfirm={handleConfirmRevert}
        onCancel={handleCancelRevert}
      />
    )}
    </>
  );
}
