import { useState } from "react";
import { Copy, Check, CheckCheck, CornerUpRight, RefreshCw, ThumbsUp, ThumbsDown, Pencil, Trash2, Undo2 } from "lucide-react";
import ContextUsageBar from "./ContextUsageBar";

// ── Barre d'actions d'un message ─────────────────────────────────────────────
//
// Reproduction de la barre d'action « type Cursor » : cinq icônes alignées à
// gauche (copier, partager/insérer, régénérer, approuver, désapprouver) et
// l'anneau d'usage du contexte à droite, le tout sur une seule ligne collée sous
// le message. Les pouces ont un état local : ils signalent un retour utilisateur
// et sont mutuellement exclusifs au sein d'un même message.

export type FeedbackVote = "up" | "down";

export interface MessageActionsBarProps {
  /** Contenu textuel du message, cible de « copier ». */
  content: string;
  /** Le message est-il de l'utilisateur (affichage de « éditer ») ? */
  isUser: boolean;
  /** Cible utilisée par « copier » (par défaut, `content`). */
  rawText: string;
  /** Régénère le tour à partir de ce message (assistant uniquement). */
  onRegenerate?: () => void;
  /** Replace le texte dans l'éditeur pour renvoi (utilisateur uniquement). */
  onEdit?: () => void;
  /** Insère le texte du message dans l'éditeur actif. */
  onInsert?: () => void;
  /** État de vote courant, remonté au parent (persistance optionnelle). */
  vote?: FeedbackVote | null;
  /** Notifie le parent d'un changement de vote. */
  onVote?: (vote: FeedbackVote) => void;
  /** Signale l'usage de « copier » (bannière de checkpoint). */
  onActionCopy?: () => void;
  /** Tokens consommés par l'historique (anneau de droite). */
  contextUsed?: number;
  /** Budget de contexte total (anneau de droite). */
  contextBudget?: number;
}

// Style commun des icônes : carré 26 px, icône 15 px, gris discret.
export const ACTION_BTN_SIZE = 26;
export const ACTION_ICON_SIZE = 15;

export function actionBtnStyle(disabled = false): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: `${ACTION_BTN_SIZE}px`, height: `${ACTION_BTN_SIZE}px`,
    background: "none", border: "none", padding: 0, borderRadius: "5px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
    color: "var(--origin-fg-subtle)",
    transition: "color .12s, background-color .12s",
  };
}

export const actionHover = {
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.currentTarget.disabled) return;
    e.currentTarget.style.color = "var(--origin-fg-default)";
    e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
  },
  onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.color = "var(--origin-fg-subtle)";
    e.currentTarget.style.backgroundColor = "transparent";
  },
};

const ICON = { size: ACTION_ICON_SIZE, strokeWidth: 1.75 } as const;

export default function MessageActionsBar({
  content,
  isUser,
  rawText,
  onRegenerate,
  onEdit,
  onInsert,
  vote,
  onVote,
  onActionCopy,
  contextUsed,
  contextBudget,
}: MessageActionsBarProps) {
  const [copied, setCopied] = useState(false);
  const shownVote = vote ?? null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rawText || content);
      setCopied(true);
      onActionCopy?.();
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard indisponible — on ignore */ }
  };

  // Le parent est source de vérité du vote (il gère la bascule/annulation).
  const toggleVote = (v: FeedbackVote) => onVote?.(v);

  const showRegen = !isUser && !!onRegenerate;
  const showEdit = isUser && !!onEdit;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1px", marginTop: "6px" }}>
      {/* Copier */}
      <button onClick={copy} title="Copier" style={actionBtnStyle()} {...actionHover}>
        {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
      </button>

      {/* Insérer dans l'éditeur actif (fourni par le parent). */}
      {onInsert && (
        <button onClick={onInsert} title="Insérer dans l'éditeur" style={actionBtnStyle()} {...actionHover}>
          <CornerUpRight {...ICON} />
        </button>
      )}

      {/* Régénérer (assistant) / Éditer (utilisateur) — même emplacement. */}
      {showRegen && (
        <button onClick={onRegenerate} title="Régénérer" style={actionBtnStyle()} {...actionHover}>
          <RefreshCw {...ICON} />
        </button>
      )}
      {showEdit && (
        <button onClick={onEdit} title="Éditer et renvoyer" style={actionBtnStyle()} {...actionHover}>
          <Pencil {...ICON} />
        </button>
      )}

      {/* Vote positif */}
      <button
        onClick={() => toggleVote("up")}
        title="Bonne réponse"
        style={{
          ...actionBtnStyle(),
          color: shownVote === "up" ? "var(--origin-accent-blue)" : "var(--origin-fg-subtle)",
        }}
        {...actionHover}
      >
        <ThumbsUp {...ICON} fill={shownVote === "up" ? "currentColor" : "none"} />
      </button>

      {/* Vote négatif */}
      <button
        onClick={() => toggleVote("down")}
        title="Réponse à améliorer"
        style={{
          ...actionBtnStyle(),
          color: shownVote === "down" ? "var(--origin-semantic-error, #ef4444)" : "var(--origin-fg-subtle)",
        }}
        {...actionHover}
      >
        <ThumbsDown {...ICON} fill={shownVote === "down" ? "currentColor" : "none"} />
      </button>

      {/* L'anneau de contexte est poussé à droite, exactement comme sur la photo. */}
      {contextUsed !== undefined && contextBudget !== undefined && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <ContextUsageBar used={contextUsed} budget={contextBudget} />
        </div>
      )}
    </div>
  );
}

// ── Actions du message utilisateur ───────────────────────────────────────────
//
// Un message de l'utilisateur n'expose que trois actions, affichées EN HAUT À
// DROITE du texte (au survol) : éditer, supprimer, revert (annuler tout ce qui a
// été généré pendant ce run). Volontairement séparé de `MessageActionsBar` pour
// ne pas mêler les deux jeux d'actions (aucun vote ni anneau côté utilisateur).

export interface UserMessageActionsProps {
  /** Replace le texte dans l'éditeur pour renvoi. */
  onEdit?: () => void;
  /** Supprime ce message (et tout ce qui suit). */
  onDelete?: () => void;
  /** Annule tout ce qui a été généré pendant ce run (revert des fichiers + historique). */
  onRevert?: () => void;
  /** Undo ciblé : annule les écritures de ce message et des suivants. */
  onUndo?: () => void;
  /** Keep ciblé : valide les écritures de ce message (elles ne seront plus annulées). */
  onKeep?: () => void;
}

export function UserMessageActions({ onEdit, onDelete, onRevert, onUndo, onKeep }: UserMessageActionsProps) {
  const undo = onUndo ?? onRevert;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "1px" }}>
      {onEdit && (
        <button onClick={onEdit} title="Éditer et renvoyer" style={actionBtnStyle()} {...actionHover}>
          <Pencil {...ICON} />
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} title="Supprimer ce message" style={actionBtnStyle()} {...actionHover}>
          <Trash2 {...ICON} />
        </button>
      )}
      {undo && (
        <button
          onClick={undo}
          title="Annuler les modifications de ce message et des suivants"
          style={actionBtnStyle()}
          {...actionHover}
        >
          <Undo2 {...ICON} />
        </button>
      )}
      {onKeep && (
        <button
          onClick={onKeep}
          title="Conserver les modifications de ce message"
          style={actionBtnStyle()}
          {...actionHover}
        >
          <CheckCheck {...ICON} />
        </button>
      )}
    </div>
  );
}
