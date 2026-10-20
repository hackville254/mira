import type { ModelMessage } from "ai";

// ── Budget de contexte + troncature d'urgence ──────────────────────────────────
//
// Porté des constantes de jcode (`jcode-compaction-core`) :
//   - CHARS_PER_TOKEN          : heuristique 1 token ≈ 4 chars
//   - SYSTEM_OVERHEAD_TOKENS   : surcoût fixe du prompt système + définitions d'outils
//   - IMAGE_TOKEN_COST         : coût forfaitaire par image inline (le base64 brut
//                                fausse l'estimation ×100)
//   - COMPACTION_THRESHOLD     : 90 % — déclenche une compaction (ici sémantique).
//                                Porté de Cline (`COMPACTION_TRIGGER_RATIO = 0.9`) :
//                                compacter tôt fait payer une compaction inutile ET
//                                casse le cache de préfixe fournisseur (chaque
//                                réécriture invalide le cache depuis le bloc réécrit).
//   - CRITICAL_THRESHOLD       : 95 % — troncature d'urgence pour ne pas dépasser
//   - EMERGENCY_TOOL_RESULT_MAX_CHARS : taille max d'un tool result après troncature
//   - PRESERVE_RECENT_TOKENS   : ~20 000 tokens récents jamais compactés (Cline
//                                `DEFAULT_PRESERVE_RECENT_TOKENS`), pour garder le
//                                fil immédiat sans le résumer.
//
// NOTE : ces valeurs sont des heuristiques d'estimation, pas un comptage exact de
// tokens. Elles servent uniquement à décider QUAND compacter, jamais à tronquer
// une réponse utilisateur en plein vol (le cas échéant la décision reste locale).

export const CHARS_PER_TOKEN = 4;
export const SYSTEM_OVERHEAD_TOKENS = 18_000;
export const IMAGE_TOKEN_COST = 1_600;
export const COMPACTION_THRESHOLD = 0.90;
export const CRITICAL_THRESHOLD = 0.95;
export const EMERGENCY_TOOL_RESULT_MAX_CHARS = 4_000;
export const PRESERVE_RECENT_TOKENS = 20_000;
export const DEFAULT_TOKEN_BUDGET = 200_000;

type AnyPart = { type: string; [k: string]: unknown };

function contentCharCount(content: unknown): number {
  // Message à contenu textuel simple.
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const raw of content as AnyPart[]) {
    switch (raw.type) {
      case "text":
        chars += String(raw.text ?? "").length;
        break;
      case "tool-result":
      case "tool-call":
        chars += JSON.stringify(raw.output ?? raw.input ?? "").length;
        break;
      case "image":
        // Coût forfaitaire, indépendant de la taille base64.
        chars += IMAGE_TOKEN_COST * CHARS_PER_TOKEN;
        break;
      default:
        chars += JSON.stringify(raw).length;
    }
  }
  return chars;
}

/** Estimation du nombre de tokens d'un historique (heuristique chars/4). */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) chars += contentCharCount((msg as { content: unknown }).content);
  return chars / CHARS_PER_TOKEN;
}

/** Estimation incluant le surcoût système (prompt + outils). */
export function estimateTokensWithOverhead(messages: ModelMessage[], budget = DEFAULT_TOKEN_BUDGET): number {
  const base = estimateTokens(messages);
  // Le surcoût fixe n'est ajouté que pour un budget réaliste (cf. jcode).
  return budget >= DEFAULT_TOKEN_BUDGET / 2 ? base + SYSTEM_OVERHEAD_TOKENS : base;
}

export type BudgetLevel = "ok" | "compact" | "critical";

/** Niveau de pression mémoire : ok / à compacter (80 %) / critique (95 %). */
export function budgetLevel(messages: ModelMessage[], budget = DEFAULT_TOKEN_BUDGET): BudgetLevel {
  const usage = estimateTokensWithOverhead(messages, budget) / budget;
  if (usage >= CRITICAL_THRESHOLD) return "critical";
  if (usage >= COMPACTION_THRESHOLD) return "compact";
  return "ok";
}

/**
 * Pré-compaction réactive de fin de tour.
 *
 * En fin de tour, l'historique vient d'être figé : il n'y a plus de raison
 * d'attendre l'entrée du prochain tour pour compacter. On vérifie l'usage
 * *projeté* — l'historique courant augmenté d'une marge pour le tour suivant
 * (réponse + tool results) — et on signale qu'il faut compacter dès que ce
 * total franchit le seuil de pression (80 %). La compaction effective reste
 * faite par `runAgent` au début du tour suivant (une seule implémentation).
 */
export function projectedUsage(
  messages: ModelMessage[],
  marginTokens: number,
  budget = DEFAULT_TOKEN_BUDGET,
): number {
  return (estimateTokensWithOverhead(messages, budget) + marginTokens) / budget;
}

/** Doit-on pré-compacter en fin de tour ? (usage projeté ≥ 80 %). */
export function shouldPreCompact(
  messages: ModelMessage[],
  marginTokens: number,
  budget = DEFAULT_TOKEN_BUDGET,
): boolean {
  return projectedUsage(messages, marginTokens, budget) >= COMPACTION_THRESHOLD;
}

/**
 * Bloc « état du contexte » injecté dans le prompt système du root (mode IA).
 *
 * Objectif : rendre la délégation AUTO-ÉVIDENTE. Un modèle qui ne connaît pas
 * son budget ne ressent aucune pression et garde tout pour lui. En lui donnant
 * son budget réel, sa consommation courante et le fait qu'un sous-agent
 * n'entre PAS dans son contexte, la décision de déléguer devient un calcul que
 * le modèle fait lui-même — aucune règle chiffrée n'est imposée ici.
 *
 * Renvoie une chaîne vide si le budget n'est pas réaliste (< moitié du budget
 * de référence), pour ne jamais mentir sur une capacité de contexte.
 */
export function contextStatusPrompt(messages: ModelMessage[], budget = DEFAULT_TOKEN_BUDGET): string {
  if (budget < DEFAULT_TOKEN_BUDGET / 2) return "";
  const used = Math.round(estimateTokensWithOverhead(messages, budget));
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const level = budgetLevel(messages, budget);
  const pressure =
    level === "critical"
      ? "critically full - delegate anything broad and compact before your next deep dive"
      : level === "compact"
        ? "getting full - prefer delegating broad investigations instead of filling it further"
        : "comfortable";
  // À contexte CONFORTABLE, on n'incline PAS vers la délégation : c'est là que le
  // modèle spawnait des coéquipiers par réflexe pour du travail qu'il finissait
  // plus vite seul. La pression à déléguer n'apparaît qu'au moment où elle est
  // réellement justifiée (contexte qui se remplit).
  const delegationHint = level === "ok"
    ? "You have plenty of room: handle the work directly unless an investigation is genuinely broad."
    : "A sub-agent's exploration never counts against this budget - only its bounded report does. " +
      "Use that: keep your context for reasoning and edits, and push broad read-only investigation to sub-agents.";
  return (
    `Your context budget: ~${budget.toLocaleString()} tokens, currently ~${used.toLocaleString()} used (${pct}%, ${pressure}).\n` +
    delegationHint
  );
}

// ── Troncature d'urgence ───────────────────────────────────────────────────────
//
// Garde la tête (max/2) et la queue (max/4) d'un tool result trop volumineux,
// avec un marqueur du nombre de caractères supprimés (formule reprise de jcode).

function emergencyTruncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars / 2));
  const tail = text.slice(text.length - Math.floor(maxChars / 4));
  const removed = text.length - head.length - tail.length;
  return `${head}\n\n... [${removed} chars truncated for context recovery] ...\n\n${tail}`;
}

/**
 * Tronque les tool results les plus volumineux d'un historique par un placeholder
 * compact. Dernier rempart avant un dépassement de contexte : on ne touche jamais
 * au dernier message (tour courant) et on préserve l'ordre/format des messages.
 */
export function emergencyTruncateToolResults(
  messages: ModelMessage[],
  maxChars = EMERGENCY_TOOL_RESULT_MAX_CHARS,
): ModelMessage[] {
  if (messages.length < 2) return messages;
  const lastIdx = messages.length - 1;

  return messages.map((msg, idx) => {
    if (idx === lastIdx || msg.role !== "tool") return msg;
    const content = msg.content as AnyPart[] | undefined;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const next = content.map((part): AnyPart => {
      if (part.type !== "tool-result") return part;
      const output = part.output as { type?: string; value?: unknown } | undefined;
      if (output && output.type === "text" && typeof output.value === "string") {
        if (output.value.length > maxChars) {
          changed = true;
          return { ...part, output: { ...output, value: emergencyTruncateText(output.value, maxChars) } };
        }
      }
      return part;
    });

    return changed ? ({ ...msg, content: next } as ModelMessage) : msg;
  });
}
