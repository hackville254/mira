import type { PendingAction } from "./agent/tools";
import type { ParsedPlan } from "./agent/planTypes";
import type { SubAgentStatus } from "./agent/run";
import type { EditorContext } from "../components/editor/Editor";

export interface ToolCallDisplay {
  id: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  status: "running" | "complete" | "approval-required";
  action?: PendingAction;
  approve?: () => void;
  /** Pour `ask_user`, résout le tool avec la réponse choisie / saisie. */
  reject?: (answer?: string) => void;
  /**
   * Sous-agents lancés par ce tool-call (`spawn_agent`, mode IA uniquement).
   * Le transcript complet reste côté hôte ; on n'affiche ici qu'un résumé borné.
   */
  children?: SubAgentChild[];
}

/** Vue UI d'un sous-agent rattaché à un tool-call `spawn_agent`. */
export interface SubAgentChild {
  spawnId:     string;
  role:        string;
  task:        string;
  status?:     SubAgentStatus;
  iterations:  number;
  inputTokens: number;
  outputTokens: number;
  report?:     string;
  /** Texte produit EN DIRECT par le sous-agent (suivi pendant l'exécution). */
  stream?:     string;
  /** Outils (lecture seule) exécutés par le sous-agent, pour la carte repliée. */
  tools?:      ToolCallDisplay[];
}

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool-call"; tc: ToolCallDisplay }
  | { type: "plan-card"; plan: ParsedPlan; status: "pending" | "approved" | "rejected" }
  | { type: "status"; kind: "compaction" | "retry" | "orchestration"; detail: string; savedTokens?: number };

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[];
  streaming?: boolean;
  sourceFilePath?: string;
  fileMentions?: string[];
  editorContext?: EditorContext | null;
  /**
   * Id de la ligne correspondante dans la table `messages` (si persistée).
   * Permet les actions ciblées (éditer/renvoyer, régénérer) qui doivent
   * supprimer les messages postérieurs à ce point.
   */
  dbId?: string;
  /**
   * Le tour a échoué faute de crédit côté Orvyx (402 `insufficient_credits`).
   * On ne remplace PAS l'erreur brute par du texte marketing : on l'annote, et
   * l'UI affiche en plus une carte « passer à une offre supérieure ». Persisté
   * via le statut `quota` pour survivre à un rechargement de la conversation.
   */
  quotaExhausted?: boolean;
}

/**
 * Reconnaît une erreur de quota Orvyx/SDK dans un message d'erreur brut.
 *
 * Orvyx renvoie `{"error":{"message":"Insufficient credit balance for this
 * request","code":"insufficient_credits"}}` ; le SDK rethrow la SEULE chaîne du
 * message (le `code` est perdu). On matche donc le texte, en tolérant les
 * variantes : majuscules/minuscules et libellés approchants.
 */
export function isQuotaError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("insufficient credit balance") ||
    m.includes("insufficient_credits") ||
    m.includes("insufficient quota") ||
    m.includes("exceeded your current quota")
  );
}

export interface PinnedMessage {
  id: string;
  content: string;
  pinnedAt: number;
  sessionId?: string;
  label?: string;
}

/**
 * Message saisi par l'utilisateur pendant qu'un tour est déjà en cours. Il est
 * conservé tel quel et envoyé automatiquement dès que le tour courant se
 * termine (fin normale, erreur ou stop manuel). Trae/Cursor appellent cet état
 * « Waiting to send ».
 */
export interface QueuedMessage {
  text: string;
  modelId: string;
  providerId: string;
  fileMentions: string[];
  editorContext: EditorContext | null;
  mode: "agent" | "ask" | "plan";
  /** Références de contexte `#` attachées (serialisées `kind:path`). */
  contextRefs?: string[];
}

export interface SessionMeta {
  id: string;
  title: string;
  workspace_path: string;
  updated_at: number;
}

export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    return [...parts.slice(0, -1), { type: "text", content: last.content + delta }];
  }
  return [...parts, { type: "text", content: delta }];
}

export function appendReasoning(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "reasoning") {
    return [...parts.slice(0, -1), { type: "reasoning", content: last.content + delta }];
  }
  return [...parts, { type: "reasoning", content: delta }];
}

export function updateTcInParts(parts: MessagePart[], id: string, update: Partial<ToolCallDisplay>): MessagePart[] {
  return parts.map(p =>
    p.type === "tool-call" && p.tc.id === id ? { ...p, tc: { ...p.tc, ...update } } : p
  );
}
