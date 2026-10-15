import { useState } from "react";
import { Pin, FileCode } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ToolCallCard from "./ToolCallCard";
import ToolGroupCard from "./ToolGroupCard";
import SubAgentCard from "./SubAgentCard";
import PlanCard from "./PlanCard";
import StatusNotice from "./StatusNotice";
import ReasoningBlock from "./ReasoningBlock";
import MessageActionsBar, { type FeedbackVote } from "./MessageActionsBar";
import { buildToolRenderers } from "../../lib/toolGroups";
import type { DisplayMessage } from "../../lib/aiTypes";
import type { EditorContext } from "../editor/Editor";
import { resolveTargetPath } from "../../lib/resolveTargetPath";

function contextLabel(ctx: EditorContext): string {
  if (ctx.startLine === ctx.endLine) return `L${ctx.startLine}`;
  return `L${ctx.startLine}–${ctx.endLine}`;
}

export default function MessageBubble({
  message,
  folderPath,
  onApplyCode,
  getOpenTabPaths,
  onResolveFail: _onResolveFail,
  onPin,
  onPlanApprove,
  onPlanReject,
  onRegenerate,
  onEditUserMessage,
  onInsert,
  onOpenFile,
  canRegenerate = false,
  onActionCopy,
  vote,
  onVote,
  contextUsed,
  contextBudget,
}: {
  message: DisplayMessage;
  folderPath?: string | null;
  onApplyCode?: (code: string, filePath?: string, ctx?: EditorContext) => void;
  getOpenTabPaths?: () => string[];
  onResolveFail?: () => void;
  onPin?: (content: string) => void;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  /** Rejoue le tour à partir de ce message assistant (supprime ce qui suit). */
  onRegenerate?: () => void;
  /** Place le texte de ce message utilisateur dans l'éditeur (envoi manuel). */
  onEditUserMessage?: () => void;
  /** Insère le texte du message dans l'éditeur actif. */
  onInsert?: () => void;
  /** Ouvre un fichier du workspace dans l'éditeur (clic sur un chemin). */
  onOpenFile?: (path: string, line?: number, col?: number) => void;
  /** Faux si un autre tour est en cours : on désactive « régénérer ». */
  canRegenerate?: boolean;
  /** Signale l'usage de « copier » (pour la bannière de checkpoint). */
  onActionCopy?: () => void;
  /** Vote utilisateur sur ce message (piloté par le parent). */
  vote?: FeedbackVote | null;
  onVote?: (vote: FeedbackVote) => void;
  /** Tokens consommés par l'historique (anneau de la barre d'actions). */
  contextUsed?: number;
  /** Budget de contexte total (anneau de la barre d'actions). */
  contextBudget?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const isUser = message.role === "user";
  const parts = message.parts;
  const hasVisibleContent = isUser
    ? !!message.content
    : parts
      ? parts.some(p => p.type === "tool-call" || p.type === "plan-card" || p.type === "status" || p.type === "reasoning" || (p.type === "text" && p.content.trim()))
      : !!message.content;
  const isEmpty = !hasVisibleContent;
  const hasAttachments = isUser && (
    (message.fileMentions && message.fileMentions.length > 0) || message.editorContext
  );

  const badgeStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: "4px",
    padding: "2px 6px", borderRadius: "4px", fontSize: "11px",
    fontFamily: "var(--font-mono)",
    background: "var(--origin-bg-active)", border: "1px solid var(--origin-border-default)",
    color: "var(--origin-fg-default)", whiteSpace: "nowrap",
  };

  const makeApplyCode = (code: string, _lang: string, filePath?: string) => {
    if (!onApplyCode) return;
    const resolved = resolveTargetPath(
      filePath, message.fileMentions, message.sourceFilePath,
      folderPath ?? "", getOpenTabPaths?.() ?? [],
    );
    // Fall back to active file rather than failing silently — handleApplyCode
    // uses activeTabRef.current when filePath is undefined.
    onApplyCode(code, resolved ?? undefined, message.editorContext ?? undefined);
  };

  // La barre d'actions apparaît au survol, message terminé. Elle reste visible
  // tant que le survol est actif (comme Cursor), pour éviter qu'elle disparaisse
  // pendant qu'on vise un bouton.
  const showActions = hovered && !message.streaming && !isEmpty;
  const canRegen = !isUser && !!onRegenerate && canRegenerate;

  return (
    <div
      style={{ marginBottom: "20px" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: "5px", gap: "4px", minHeight: "18px" }}>
        <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--origin-fg-subtle)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
          {isUser ? "You" : "Assistant"}
        </span>
      </div>

      {isEmpty && message.streaming ? (
        <span style={{ display: "inline-block", width: "2px", height: "13px", backgroundColor: "var(--origin-fg-muted)", verticalAlign: "text-bottom", animation: "blink 1s step-end infinite" }} />
      ) : isUser ? (
        <div style={{ fontSize: "13px", color: "var(--origin-fg-default)", lineHeight: "1.65", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {message.content}
        </div>
      ) : parts && parts.length > 0 ? (
        <>
          {buildToolRenderers(parts).map((r, i) => {
            if (r.kind === "plan-card") {
              return (
                <PlanCard
                  key={i}
                  plan={r.part.plan}
                  status={r.part.status}
                  onApprove={r.part.status === "pending" ? (onPlanApprove ?? (() => {})) : undefined}
                  onReject={r.part.status === "pending" ? (onPlanReject ?? (() => {})) : undefined}
                />
              );
            }
            if (r.kind === "single") {
              return <ToolCallCard key={r.tc.id} tc={r.tc} onOpenFile={onOpenFile} />;
            }
            if (r.kind === "group") {
              // Un groupe peut contenir (en pratique jamais, car `spawn_agent`
              // n'est pas regroupable) des tool-calls à enfants : on rend les
              // cartes de sous-agent à part pour ne pas les perdre.
              return (
                <div key={`g-${r.tools[0]?.id ?? i}`}>
                  <ToolGroupCard label={r.label} tools={r.tools} onOpenFile={onOpenFile} />
                  {r.tools.flatMap(tc => (tc.children ?? []).map(child => (
                    <SubAgentCard key={child.spawnId} child={child} />
                  )))}
                </div>
              );
            }
            if (r.kind === "status") {
              return (
                <StatusNotice
                  key={i}
                  kind={r.part.kind}
                  detail={r.part.detail}
                  savedTokens={r.part.savedTokens}
                />
              );
            }
            if (r.kind === "reasoning") {
              // Le raisonnement en cours de streaming est la dernière part visible.
              const streaming = !!message.streaming && i === parts.length - 1;
              return <ReasoningBlock key={i} content={r.content} streaming={streaming} />;
            }
            if (!r.content) return null;
            const isLastPart = i === parts.length - 1;
            return (
              <MarkdownMessage
                key={i}
                content={r.content}
                isStreaming={isLastPart && message.streaming}
                onApplyCode={onApplyCode ? makeApplyCode : undefined}
              />
            );
          })}
        </>
      ) : message.content ? (
        <MarkdownMessage
          content={message.content}
          isStreaming={message.streaming}
          onApplyCode={onApplyCode ? makeApplyCode : undefined}
        />
      ) : null}

      {hasAttachments && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "8px" }}>
          {message.editorContext && (
            <span style={badgeStyle}>
              <FileCode size={11} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
              <span>{message.editorContext.filename}</span>
              <span style={{ padding: "0 4px", borderRadius: "3px", fontSize: "10px", background: "var(--origin-bg-hover)", color: "var(--origin-fg-muted)" }}>
                {contextLabel(message.editorContext)}
              </span>
            </span>
          )}
          {message.fileMentions?.map(fp => {
            const fname = fp.split(/[/\\]/).pop() ?? fp;
            return (
              <span key={fp} style={badgeStyle}>
                <FileCode size={11} style={{ flexShrink: 0, color: "var(--origin-fg-muted)" }} />
                {fname}
              </span>
            );
          })}
        </div>
      )}

      {showActions && (
        <MessageActionsBar
          content={message.content}
          rawText={message.content}
          isUser={isUser}
          onRegenerate={canRegen ? onRegenerate : undefined}
          onEdit={isUser ? onEditUserMessage : undefined}
          onInsert={onInsert}
          vote={vote}
          onVote={onVote}
          onActionCopy={onActionCopy}
          contextUsed={contextUsed}
          contextBudget={contextBudget}
        />
      )}

      {/* Épingler reste hors de la barre : action secondaire propre à l'app. */}
      {showActions && !isUser && onPin && message.content && (
        <button
          onClick={() => onPin(message.content)}
          title="Épingler au Pinboard"
          style={{
            display: "inline-flex", alignItems: "center", gap: "4px", marginTop: "2px",
            background: "none", border: "none", padding: "2px 4px", borderRadius: "4px",
            cursor: "pointer", color: "var(--origin-fg-subtle)", fontSize: "10px",
          }}
        >
          <Pin size={11} /> Épingler
        </button>
      )}
    </div>
  );
}
