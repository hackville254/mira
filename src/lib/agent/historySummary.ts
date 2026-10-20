import { type ModelMessage } from "ai";

// ── Compaction SÉMANTIQUE manuelle : résumé LLM de l'historique ancien ─────────
//
// POURQUOI CE MODULE
// ------------------
// `compactHistory` (déterministe, sans LLM) ne retire que les `read_file`
// périmés. Sur une session faite surtout d'écritures, de commandes terminal ou
// de recherches, il n'a RIEN à retirer — d'où un « Aucun résultat périmé » alors
// que la jauge est pleine. La vraie compaction (Trae, Claude Code) est un
// RÉSUMÉ : on remplace tout l'historique ANCIEN par un compte rendu structuré,
// et on ne conserve verbatim que la fenêtre récente.
//
// CONTRAT
// -------
//  - L'historique renvoyé reste un `ModelMessage[]` VALIDE : les appels d'outils
//    et leurs résultats ne sont jamais coupés en deux, et la fenêtre récente
//    n'est jamais touchée (sinon le modèle redemanderait un fichier qu'il vient
//    de lire → un aller-retour perdu).
//  - Le résumé est injecté comme un couple `user` (consigne) + `assistant`
//    (résumé). C'est un échange authentique, donc sûr pour TOUS les providers,
//    y compris ceux qui refusent un `system` intercalé ou un `user` isolé.
//  - Le module ne réalise AUCUN appel réseau : l'appelant fournit `summarize`,
//    ce qui le rend testable sans provider et sans sidecar.

/**
 * Prompt système du résumé.
 *
 * Exigences : préserver l'INTENTION, les DÉCISIONS prises et les FAITS appris
 * (chemins, signatures, contraintes), mais pas le contenu brut recopiable. On
 * interdit explicitement d'inventer ou d'anticiper une suite.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  "You compress the earlier part of a coding-assistant conversation so the",
  "assistant can keep working with a much smaller context.",
  "",
  "Write a dense, structured summary of the transcript you are given. Include:",
  "1. The user's overall goal and any stated preferences or constraints.",
  "2. Decisions taken and WHY (trade-offs, rejected options).",
  "3. Concrete facts learned: file paths, function/type names, command results,",
  "   errors encountered and how they were resolved.",
  "4. What is already done vs. still pending, and the immediate next step.",
  "",
  "Rules:",
  "- Be concise but specific. No filler.",
  "- Never invent work, files, or intentions that are not in the transcript.",
  "- Do not answer the task or continue it; only summarise.",
  "- Output plain text (short bullet groups and headers are fine).",
  "- Match the language of the conversation.",
].join("\n");

/** Résultat d'un résumé : le bloc texte + le nombre de messages couverts. */
export interface HistorySummary {
  /** Compte rendu structuré de l'historique ancien. */
  summary: string;
  /** Nombre de messages de tête remplacés par ce résumé. */
  coveredCount: number;
}

/** Signature de l'appel LLM de résumé, injectée par l'appelant. */
export type SummarizeFn = (transcript: string, signal?: AbortSignal) => Promise<string | null>;

/**
 * Index du premier message de la fenêtre RÉCENTE, à partir duquel on ne résume
 * plus rien. On remonte depuis la fin et on s'arrête dès que le cumul dépasse
 * `preserveTokens`. On aligne ensuite l'index sur la FRONTIÈRE DE TOUR : un
 * « tour » commence par un message `user` ; couper au milieu séparerait un
 * appel d'outil de son résultat, ce qui produirait un historique invalide.
 *
 * Renvoie 0 ou 1 si l'historique entier tient dans la fenêtre récente (rien de
 * sûr à résumer).
 */
export function recentWindowStart(
  messages: ModelMessage[],
  preserveTokens: number,
  estimate: (msgs: ModelMessage[]) => number,
): number {
  let acc = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimate([messages[i]]);
    if (acc > preserveTokens) { cut = i + 1; break; }
  }
  // Aligne vers le DÉBUT du tour englobant : on avance jusqu'au premier message
  // `user` à partir de `cut`, pour ne jamais couper un couple
  // assistant/tool-calls ↔ tool-results.
  for (let i = Math.max(0, cut); i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return messages.length; // aucun tour sûr à préserver → on ne résume rien
}

/**
 * Rend l'historique ancien sous forme de transcript lisible par le modèle de
 * résumé. On ne cherche PAS à reproduire le protocole d'appel d'outils : un
 * rendu texte compact (rôle + contenu, résultats d'outils tronqués) suffit pour
 * résumer et évite d'envoyer au modèle de résumé des structures volumineuses.
 */
export function renderTranscript(messages: ModelMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "tool" ? "tool-result" : msg.role;
    lines.push(`### ${role}`);
    lines.push(flattenContent((msg as { content: unknown }).content));
    lines.push("");
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  // On garde le DÉBUT (objectif, décisions fondatrices) et la FIN (état courant) :
  // le milieu d'un long transcript est le plus redondant.
  const head = full.slice(0, Math.floor(maxChars * 0.6));
  const tail = full.slice(full.length - Math.floor(maxChars * 0.3));
  return `${head}\n\n... [${full.length - head.length - tail.length} chars omitted for summarization] ...\n\n${tail}`;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const raw of content as Array<{ type?: string; [k: string]: unknown }>) {
    switch (raw.type) {
      case "text":
        out.push(String(raw.text ?? ""));
        break;
      case "tool-call":
        out.push(`[tool-call] ${String(raw.toolName ?? "?")} ${safeJson(raw.input)}`);
        break;
      case "tool-result":
        out.push(`[tool-result] ${String(raw.toolName ?? "?")} ${safeJson(raw.output)}`);
        break;
      default:
        out.push(safeJson(raw));
    }
  }
  return out.join("\n");
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Produit le résumé de l'historique ANCIEN et l'historique compacté.
 *
 * `messages` est l'historique modèle complet (dernier message = tour courant).
 * Le résultat `compacted` est `[SUMMARIZED TAIL]` : la tête ancienne est
 * remplacée par le résumé lui-même fourni dans `info.summary`. L'appelant décide
 * COMMENT le porter au modèle (ici : le store de compaction l'injecte comme
 * couple `user`+`assistant`, de façon persistante). On n'ajoute donc PAS de
 * message factice ici, pour ne pas dupliquer le pont.
 *
 * Renvoie `null` s'il n'y a rien à résumer, ou si le modèle de résumé échoue /
 * renvoie un texte vide : dans ce cas l'APPELANT NE DOIT PAS réécrire le fil
 * (aucune perte de contexte pour l'utilisateur).
 */
export async function summarizeHistory(
  messages: ModelMessage[],
  preserveTokens: number,
  estimate: (msgs: ModelMessage[]) => number,
  summarize: SummarizeFn,
  maxTranscriptChars = 120_000,
  signal?: AbortSignal,
): Promise<{ compacted: ModelMessage[]; info: HistorySummary } | null> {
  const start = recentWindowStart(messages, preserveTokens, estimate);
  // Il faut au moins un tour ancien à résumer (start ≥ 1) et une queue conservée.
  if (start < 1 || start >= messages.length) return null;

  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  const transcript = renderTranscript(head, maxTranscriptChars);
  if (!transcript.trim()) return null;

  const summary = (await summarize(transcript, signal))?.trim();
  if (!summary) return null;

  return {
    compacted: tail,
    info: { summary, coveredCount: head.length },
  };
}
