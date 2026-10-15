/**
 * Plafonnement des sorties d'outils (port de Cline : `output-limits.ts`).
 *
 * ── Pourquoi ce fichier ────────────────────────────────────────────────────────
 * Chaque octet renvoyé par un outil est RÉ-ENVOYÉ au modèle à chaque tour suivant
 * du même tour d'agent. Un `read_file` de 2000 lignes (~60-100 KB) est donc repayé
 * en entrée à chaque itération, ce qui fait exploser le TTFT et le coût. Cline l'a
 * formalisé : « oversized outputs cost quadratically over the remaining run ».
 *
 * On applique donc la MÊME stratégie qu'eux : élision MÉDIANE (on garde la tête
 * ET la queue, on coupe le milieu) — les notices de récupération vivant dans les
 * parties conservées, elles survivent toujours à la coupe.
 *
 * Ces plafonds s'appliquent AU MOMENT où l'outil produit son résultat (donc avant
 * que le résultat n'entre dans l'historique), pas à l'envoi. On ne tronque jamais
 * une réponse déjà en contexte : on empêche seulement un nouvel octet de trop
 * d'y entrer.
 */

/** Sortie de commande (bash) : plafond large, une commande peut légitimement cracher beaucoup. */
export const MAX_COMMAND_OUTPUT_CHARS = 48_000;
/** Résultat de recherche (grep/glob) : plafond aligné sur Cline. */
export const MAX_SEARCH_OUTPUT_CHARS = 48_000;
/** Résultat de lecture de fichier : plafond aligné sur Cline. */
export const MAX_READ_OUTPUT_CHARS = 48_000;
/** Plafond PRINCIPAL : ce que le tour suivant rejoue. C'est le levier de TTFT. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Élision médiane. Garde la tête (moitié) et la queue (moitié), élide le milieu.
 *
 * Différence avec `emergencyTruncateText` (tokenBudget) : ici la notice de
 * récupération est placée DANS les zones conservées, jamais dans la partie
 * coupée — sinon un coupe ultérieure l'effacerait et le modèle perdrait
 * l'instruction pour récupérer le contenu manquant.
 *
 * `hint` décrit comment récupérer la partie élidée (propre à l'outil).
 */
export function truncateMiddle(text: string, maxChars: number, hint: string): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;

  // La notice est courte devant maxChars (cas réaliste : plafonds de milliers de
  // caractères). On réserve sa place pour ne jamais dépasser `maxChars` au total.
  const notice = `\n\n... [${text.length - maxChars} characters elided. ${hint}] ...\n\n`;
  const budget = Math.max(2, maxChars - notice.length);
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);

  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const removed = text.length - headLen - tailLen;

  return `${head}\n\n... [${removed} characters elided. ${hint}] ...\n\n${tail}`;
}

/**
 * Sérialise un résultat d'outil en texte borné. Objet → JSON, chaîne → telle
 * quelle. C'est le point d'étranglement unique par lequel TOUT résultat d'outil
 * passe avant d'être émis en `tool-result`.
 */
export function clampToolResult(result: unknown, maxChars = MAX_TOOL_RESULT_CHARS): unknown {
  if (result == null) return result;

  if (typeof result === "string") {
    return truncateMiddle(result, maxChars, "Re-run the tool with a narrower scope to see the rest.");
  }

  // Objet : on ne tronque JAMAIS la structure (le modèle doit pouvoir lire les
  // champs), on tronque uniquement les champs texte les plus volumineux.
  if (typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    for (const key of Object.keys(out)) {
      const val = out[key];
      if (typeof val === "string" && val.length > maxChars) {
        out[key] = truncateMiddle(val, maxChars, "Narrow the request (start_line/end_line, folder, pattern) to read the rest.");
      }
    }
    return out;
  }

  // Tableau (ex. `{ results: [...] }` est un objet, mais un tableau nu reste possible).
  if (Array.isArray(result)) {
    const json = JSON.stringify(result);
    if (json.length <= maxChars) return result;
    return truncateMiddle(json, maxChars, "Narrow the search (folder, pattern) to reduce the result set.");
  }

  return result;
}
