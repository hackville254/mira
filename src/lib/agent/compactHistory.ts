import type { ModelMessage } from "ai";
import { estimateTokens, PRESERVE_RECENT_TOKENS } from "./tokenBudget";
import type { DisplayMessage } from "../aiTypes";

// ── Types mirroring what buildModelHistory emits ───────────────────────────────

type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

type ToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
};

// ── Stale-read rewriting (port de Cline `message-builder.ts`) ──────────────────
//
// Removes redundant or stale read_file results from the message history before
// sending to the model. A read result is dropped when it is no longer
// authoritative:
//
//   1. Superseded reads — the same path was read again later; only the most
//      recent read of an un-mutated file carries the current state.
//   2. Mutation-invalidated reads — the agent wrote to or edited the path
//      AFTER (or at) this read. A write makes ALL prior reads of that path
//      stale, even if the file was read only once.
//
// In both cases the tool-result content is swapped for a one-line placeholder.
// Assistant messages (the model's reasoning and tool calls) are always kept
// intact, so the chain of reasoning is preserved, and the most-recent
// authoritative read is preserved verbatim.
//
// ── Pourquoi ce n'est PLUS gaté sur un budget ─────────────────────────────────
// Avant, on ne compactait qu'au-delà de 80 % du budget : un vieux read_file
// périmé restait donc dans le contexte pendant toute la phase « confortable »,
// et chaque octet conservé était repayé en entrée à CHAQUE tour suivant (coût
// quadratique, cf. Cline). Le remplacement d'une lecture périmée par un
// marqueur d'une ligne est O(n), déterministe, sans appel LLM, et strictement
// bénéfique : on l'exécute donc à CHAQUE tour. C'est exactement le comportement
// de Cline (« stale-read rewriting »), qui n'attend pas la pression mémoire.

export function compactHistory(messages: ModelMessage[]): ModelMessage[] {
  const stale = findStaleReads(messages);
  if (stale.size === 0) return messages;
  return applyStaleReads(messages, stale);
}

/**
 * Identifie les `read_file` PÉRIMÉS sans rien réécrire.
 *
 * POURQUOI SÉPARÉ
 * ---------------
 * La compaction doit pouvoir s'appliquer à DEUX représentations différentes du
 * même fil :
 *   - l'historique MODÈLE (`ModelMessage[]`, ce que `compactHistory` réécrit) ;
 *   - le fil AFFICHÉ (`DisplayMessage[]`, lu par la jauge de contexte).
 * Si l'on ne réécrivait que le premier, une compaction MANUELLE déclenchée par
 * l'utilisateur semblerait sans effet : la jauge (calculée sur le fil affiché)
 * ne bougerait pas. On expose donc l'ENSEMBLE des `toolCallId` périmés, que
 * chaque appelant applique à sa propre représentation — une seule décision
 * « qu'est-ce qui est périmé », deux applications cohérentes.
 *
 * Renvoie l'ensemble vide si rien n'est périmé (aucun read, ou tout récent).
 */
export function findStaleReads(messages: ModelMessage[]): Set<string> {
  const empty = new Set<string>();
  if (messages.length < 2) return empty;

  // Last message is the current user turn — never touch it.
  const history = messages.slice(0, -1);

  // Pass 1: walk assistant messages in order, recording for each tool call:
  //   - read_file calls: { callId, path, index }
  //   - write_file / edit calls: path → earliest mutation index
  // `index` is the position in `history` so we can compare ordering.
  const reads: { callId: string; path: string; index: number }[] = [];
  const firstMutationIndex = new Map<string, number>(); // path → first write/edit index

  for (let index = 0; index < history.length; index++) {
    const msg = history[index];
    if (msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? (msg.content as AssistantPart[]) : [];
    for (const part of content) {
      if (part.type !== "tool-call") continue;

      if (part.toolName === "read_file") {
        const path = (part.input as { path?: string })?.path ?? "";
        reads.push({ callId: part.toolCallId, path, index });
      } else if (part.toolName === "write_file" || part.toolName === "edit") {
        const path = (part.input as { path?: string })?.path ?? "";
        if (path && !firstMutationIndex.has(path)) {
          firstMutationIndex.set(path, index);
        }
      }
    }
  }

  if (reads.length === 0) return empty; // no file reads at all

  // Fenêtre de préservation : on ne remplace JAMAIS un read des derniers
  // ~20 000 tokens (porté de Cline `DEFAULT_PRESERVE_RECENT_TOKENS`). Le fil
  // immédiat doit rester verbatim — le résumer forcerait le modèle à redemander
  // le fichier, ce qui coûte un aller-retour entier.
  // Index du premier message de la fenêtre récente (parcours depuis la fin).
  let preserveFromIndex = 0;
  {
    let acc = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      acc += estimateTokens([history[i]]);
      if (acc > PRESERVE_RECENT_TOKENS) { preserveFromIndex = i + 1; break; }
    }
  }

  // Pass 2: determine which read call IDs are stale.
  //
  //   - Superseded: a later read of the same path exists (higher index).
  //   - Mutation-invalidated: a write/edit to the same path occurred at or
  //     after this read's index. A write at the same step reflects newer
  //     intent, so we treat it as invalidating.
  const lastReadIndexPerPath = new Map<string, number>();
  for (const r of reads) {
    const prev = lastReadIndexPerPath.get(r.path);
    if (prev === undefined || r.index > prev) lastReadIndexPerPath.set(r.path, r.index);
  }

  const superseded = new Set<string>();
  for (const r of reads) {
    // Jamais toucher un read dans la fenêtre récente.
    if (r.index >= preserveFromIndex) continue;

    const lastReadIdx = lastReadIndexPerPath.get(r.path)!;
    const isSuperseded = r.index < lastReadIdx;

    const mutationIdx = firstMutationIndex.get(r.path);
    const isMutated = mutationIdx !== undefined && mutationIdx >= r.index;

    if (isSuperseded || isMutated) superseded.add(r.callId);
  }

  if (superseded.size === 0) return empty; // nothing stale
  return superseded;
}

/**
 * Réécrit l'historique MODÈLE : chaque `read_file` périmé (voir
 * `findStaleReads`) voit son résultat remplacé par un marqueur d'une ligne.
 * Les messages assistant (raisonnement + appels d'outils) sont toujours
 * conservés intacts — seule la CHARGE d'un résultat périmé disparaît.
 */
export function applyStaleReads(messages: ModelMessage[], stale: Set<string>): ModelMessage[] {
  if (stale.size === 0 || messages.length < 2) return messages;
  const history = messages.slice(0, -1);
  const currentUserMsg = messages[messages.length - 1];

  // Les chemins cités dans les marqueurs sont dérivés des appels `read_file`
  // périmés encore présents dans l'historique : on retrouve, pour chaque id,
  // le chemin concerné (nécessaire au libellé « superseded » vs « invalidated »).
  const stalePathById = new Map<string, string>();
  const mutatedPaths = new Set<string>();
  for (const msg of history) {
    if (msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? (msg.content as AssistantPart[]) : [];
    for (const part of content) {
      if (part.type !== "tool-call") continue;
      const path = (part.input as { path?: string })?.path ?? "";
      if (part.toolName === "read_file" && stale.has(part.toolCallId)) {
        stalePathById.set(part.toolCallId, path);
      } else if (part.toolName === "write_file" || part.toolName === "edit") {
        if (path) mutatedPaths.add(path);
      }
    }
  }

  // Pass 3: rewrite tool messages that contain stale read results.
  const compactedHistory = history.map((msg): ModelMessage => {
    if (msg.role !== "tool") return msg;

    const content = msg.content as ToolResultPart[];
    let changed = false;
    const newContent = content.map((part): ToolResultPart => {
      if (part.toolName !== "read_file" || !stale.has(part.toolCallId)) return part;
      const path = stalePathById.get(part.toolCallId) ?? "unknown";
      const wasMutated = mutatedPaths.has(path);
      changed = true;
      return {
        ...part,
        output: {
          type: "text",
          value: wasMutated
            ? `[File contents omitted — invalidated by a later write/edit of ${path}]`
            : `[File contents omitted — superseded by a later read of ${path}]`,
        },
      };
    });

    return changed ? ({ ...msg, content: newContent } as ModelMessage) : msg;
  });

  return [...compactedHistory, currentUserMsg];
}

/**
 * Applique la compaction au fil AFFICHÉ (`DisplayMessage[]`).
 *
 * POURQUOI
 * --------
 * `compactHistory` ne réécrit que l'historique MODÈLE : le fil affiché garde
 * les résultats complets, donc la jauge de contexte (calculée sur ce fil) ne
 * bouge pas. Quand l'utilisateur déclenche une compaction MANUELLE, il doit voir
 * l'effet : on remplace donc, dans les bulles, le résultat des tool-calls
 * `read_file` périmés par le MÊME marqueur d'une ligne.
 *
 * Les deux représentations partagent la décision de péremption : on la calcule
 * une fois sur l'historique modèle (`findStaleReads`), puis on l'applique ici
 * aux `ToolCallDisplay`. `mutationPaths` (chemins écrits/édités) sert à choisir
 * le libellé « superseded » vs « invalidated », comme pour l'historique modèle.
 *
 * NON DESTRUCTIF : renvoie un NOUVEAU tableau ; les messages non concernés et
 * les messages assistant (raisonnement, appels d'outils) restent intacts.
 * Renvoie `messages` inchangé si rien n'est périmé.
 */
export function compactDisplayMessages(
  messages: DisplayMessage[],
  stale: Set<string>,
  mutatedPaths: Set<string>,
): DisplayMessage[] {
  if (stale.size === 0) return messages;
  let anyChanged = false;
  const compacted = messages.map((msg): DisplayMessage => {
    if (!msg.parts || msg.parts.length === 0) return msg;
    let localChanged = false;
    const parts = msg.parts.map((part) => {
      if (part.type !== "tool-call") return part;
      const tc = part.tc;
      if (tc.toolName !== "read_file" || !stale.has(tc.id)) return part;
      const path = (tc.args as { path?: string })?.path ?? "unknown";
      localChanged = true;
      anyChanged = true;
      return {
        ...part,
        tc: {
          ...tc,
          result: mutatedPaths.has(path)
            ? `[File contents omitted — invalidated by a later write/edit of ${path}]`
            : `[File contents omitted — superseded by a later read of ${path}]`,
        },
      };
    });
    return localChanged ? { ...msg, parts } : msg;
  });
  return anyChanged ? compacted : messages;
}

/**
 * Chemins ÉCRITS ou ÉDITÉS dans le fil affiché.
 *
 * Nécessaire au libellé du marqueur de compaction (un read invalidé par une
 * écriture ne se raconte pas comme un read simplement remplacé par une lecture
 * plus récente). Calculé sur les tool-calls `write_file`/`edit` du fil affiché.
 */
export function mutatedPathsOf(messages: DisplayMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "tool-call") continue;
      const name = part.tc.toolName;
      if (name !== "write_file" && name !== "edit") continue;
      const path = (part.tc.args as { path?: string })?.path ?? "";
      if (path) paths.add(path);
    }
  }
  return paths;
}
