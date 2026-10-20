import { useState } from "react";
import { Pin, FileCode, Check } from "lucide-react";
import MarkdownMessage from "./MarkdownMessage";
import ToolCallCard from "./ToolCallCard";
import ToolGroupCard from "./ToolGroupCard";
import SubAgentCard from "./SubAgentCard";
import PlanCard from "./PlanCard";
import StatusNotice from "./StatusNotice";
import ReasoningBlock from "./ReasoningBlock";
import MessageActionsBar, { UserMessageActions, type FeedbackVote } from "./MessageActionsBar";
import type { TurnFileDelta } from "../../lib/turnCheckpoint";
import { buildToolRenderers } from "../../lib/toolGroups";
import type { DisplayMessage } from "../../lib/aiTypes";
import type { EditorContext } from "../editor/Editor";
import logoCode from "../../assets/logo-code.svg";

function contextLabel(ctx: EditorContext): string {
  if (ctx.startLine === ctx.endLine) return `L${ctx.startLine}`;
  return `L${ctx.startLine}–${ctx.endLine}`;
}

export default function MessageBubble({
  message,
  onPin,
  onPlanApprove,
  onPlanReject,
  onRegenerate,
  onEditUserMessage,
  onDeleteUserMessage,
  onUndoUserMessage,
  onKeepUserMessage,
  reviewState,
  onInsert,
  onOpenFile,
  onOpenPath,
  canRegenerate = false,
  onActionCopy,
  vote,
  onVote,
  contextUsed,
  contextBudget,
  onCompact,
}: {
  message: DisplayMessage;
  onPin?: (content: string) => void;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  /** Rejoue le tour à partir de ce message assistant (supprime ce qui suit). */
  onRegenerate?: () => void;
  /** Place le texte de ce message utilisateur dans l'éditeur (envoi manuel). */
  onEditUserMessage?: () => void;
  /** Supprime ce message utilisateur (et tout ce qui suit). */
  onDeleteUserMessage?: () => void;
  /** Revert : annule tout ce qui a été généré pendant ce run. */
  onRevertUserMessage?: () => void;
  /** Undo ciblé (par message) : annule les écritures de ce message et des suivants. */
  onUndoUserMessage?: () => void;
  /** Keep ciblé (par message) : fige les écritures de ce message (les oublie du revert). */
  onKeepUserMessage?: () => void;
  /** État de revue de ce message : `kept` (déjà conservé) ou `revertable` (undo possible). */
  reviewState?: { kept: boolean; revertable: boolean; files: TurnFileDelta[] };
  /** Insère le texte du message dans l'éditeur actif. */
  onInsert?: () => void;
  /** Ouvre un fichier du workspace dans l'éditeur (clic sur un chemin). */
  onOpenFile?: (path: string, line?: number, col?: number) => void;
  /**
   * Ouvre un chemin cité en texte brut dans le corps du message. Le parent
   * décide : fichier → éditeur, dossier → révélé dans l'explorateur.
   */
  onOpenPath?: (path: string) => void;
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
  /** Déclenche la compaction MANUELLE du contexte (clic sur la jauge + « Compact »). */
  onCompact?: () => void;
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

  // La barre d'actions de l'Agent est visible EN PERMANENCE (comme Cursor/Trae) :
  // l'utilisateur n'a pas à survoler pour la découvrir. Seul le message
  // utilisateur garde ses actions au survol (voir plus bas).
  const showActions = !message.streaming && !isEmpty && !isUser;
  const canRegen = !isUser && !!onRegenerate && canRegenerate;

  return (
    <div
      style={{ marginBottom: "20px" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Le message utilisateur est en HAUT, aligné à droite, dans une bulle
          grise sans étiquette. La réponse de l'agent est en BAS, sans bulle,
          précédée du libellé « Agent ». */}
      {!isUser && (
        <div style={{ display: "flex", alignItems: "center", marginBottom: "5px", gap: "4px", minHeight: "18px" }}>
          <img src={logoCode} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--origin-fg-default)" }}>Agent</span>
        </div>
      )}

      {isEmpty && message.streaming ? (
        // TTFT : entre l'envoi et le premier token, la bulle est vide. On affiche
        // un indicateur d'ACTIVITÉ explicite (« Working » + points animés) plutôt
        // qu'un simple curseur de 2px : en mode IA, l'orchestration d'équipe rend
        // cette attente plus longue, et un trait minuscule laissait croire à un
        // blocage (« on ne voit rien »).
        <div style={{ display: "flex", alignItems: "center", gap: "6px", minHeight: "20px" }}>
          <span style={{ fontSize: "13px", color: "var(--origin-fg-muted)" }}>Working</span>
          <span style={{ display: "inline-flex", gap: "3px" }}>
            {[0, 1, 2].map(i => (
              <span
                key={i}
                style={{
                  width: 4, height: 4, borderRadius: "50%",
                  backgroundColor: "var(--origin-fg-muted)",
                  display: "inline-block",
                  animation: "pulse 1.2s ease-in-out infinite",
                  animationDelay: `${i * 0.2}s`,
                }}
              />
            ))}
          </span>
        </div>
      ) : isUser ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {/* La réserve de hauteur (`paddingTop`) fait partie de la zone de
              survol : les actions restent atteignables et cliquables, sans
              jamais recouvrir le texte de la bulle. */}
          <div
            style={{ position: "relative", maxWidth: "85%", paddingTop: "26px" }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            {/* Actions utilisateur : AU-DESSUS de la bulle, alignées à droite, au
                survol uniquement — jamais superposées au texte. */}
            {hovered && !message.streaming && (
              <div style={{ position: "absolute", top: "0", right: "0", zIndex: 2, height: "26px", display: "flex", alignItems: "center" }}>
                {reviewState?.kept ? (
                  <span
                    title={reviewState.files.length > 0 ? `${reviewState.files.length} file(s) kept` : "Changes kept"}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "4px",
                      fontSize: "11px", fontFamily: "var(--font-mono)",
                      color: "var(--origin-fg-subtle)",
                    }}
                  >
                    <Check size={13} strokeWidth={2}
                      style={{ color: "var(--origin-semantic-success, #22c55e)" }} />
                    {reviewState.files.length > 0 ? `${reviewState.files.length} kept` : "Kept"}
                  </span>
                ) : (
                  <UserMessageActions
                    onEdit={onEditUserMessage}
                    onDelete={onDeleteUserMessage}
                    onUndo={onUndoUserMessage}
                    onKeep={onKeepUserMessage}
                  />
                )}
              </div>
            )}
            <div style={{
              fontSize: "13px", color: "var(--origin-fg-default)", lineHeight: "1.65",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              padding: "8px 12px", borderRadius: "12px",
              backgroundColor: "var(--origin-bg-active)",
            }}>
              {message.content}
            </div>
          </div>
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
                onOpenPath={onOpenPath}
              />
            );
          })}
        </>
      ) : message.content ? (
        <MarkdownMessage
          content={message.content}
          isStreaming={message.streaming}
          onOpenPath={onOpenPath}
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
          onInsert={onInsert}
          vote={vote}
          onVote={onVote}
          onActionCopy={onActionCopy}
          contextUsed={contextUsed}
          contextBudget={contextBudget}
          onCompact={onCompact}
        />
      )}

      {/* Épingler reste hors de la barre : action secondaire propre à l'app. */}
      {showActions && !isUser && onPin && message.content && (
        <button
          onClick={() => onPin(message.content)}
          title="Pin to Pinboard"
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
