import type { ModelMessage } from "ai";
import { estimateTokens, PRESERVE_RECENT_TOKENS } from "./tokenBudget";

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
  if (messages.length < 2) return messages;

  // Last message is the current user turn — never touch it.
  const history = messages.slice(0, -1);
  const currentUserMsg = messages[messages.length - 1];

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

  if (reads.length === 0) return messages; // no file reads at all

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
  const callIdToPath = new Map<string, string>();
  for (const r of reads) {
    callIdToPath.set(r.callId, r.path);

    // Jamais toucher un read dans la fenêtre récente.
    if (r.index >= preserveFromIndex) continue;

    const lastReadIdx = lastReadIndexPerPath.get(r.path)!;
    const isSuperseded = r.index < lastReadIdx;

    const mutationIdx = firstMutationIndex.get(r.path);
    const isMutated = mutationIdx !== undefined && mutationIdx >= r.index;

    if (isSuperseded || isMutated) superseded.add(r.callId);
  }

  if (superseded.size === 0) return messages; // nothing stale

  // Pass 3: rewrite tool messages that contain stale read results.
  const compactedHistory = history.map((msg): ModelMessage => {
    if (msg.role !== "tool") return msg;

    const content = msg.content as ToolResultPart[];
    let changed = false;
    const newContent = content.map((part): ToolResultPart => {
      if (part.toolName !== "read_file" || !superseded.has(part.toolCallId)) return part;
      const path = callIdToPath.get(part.toolCallId) ?? "unknown";
      const wasMutated = firstMutationIndex.has(path);
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
