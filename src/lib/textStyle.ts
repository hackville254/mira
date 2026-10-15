// Nettoyage défensif du texte généré par le modèle pour l'UI.
//
// Le prompt système interdit les emojis (cf. STYLE_GUARDRAIL dans lib/ai.ts),
// mais un modèle peut toujours en émettre malgré la consigne. Ce filet garantit
// une UI sobre sans casser le Markdown ni le code : les blocs de code (``` … ```)
// et le code inline (`…`) sont préservés intacts.

// Emojis et pictogrammes décoratifs (plages Unicode standard emoji).
const EMOJI_RE =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u20E3\u200D]/gu;

function stripInProse(text: string): string {
  return text
    .replace(EMOJI_RE, "")
    // Espaces multiples créés par le retrait (intra-ligne uniquement).
    .replace(/ {2,}/g, " ")
    // Emoji laissé seul sur sa ligne → ligne vide : on la supprime.
    .replace(/^[ \t]*\n/gm, "");
}

/**
 * Retire les emojis décoratifs d'un contenu Markdown, en préservant le code
 * (blocs ``` … ``` et code inline `…`) qui pourrait légitimement en contenir.
 */
export function stripDecorativeEmojis(text: string): string {
  if (!text) return text;

  // On découpe le markdown en segments « code » (fences + inline) et « prose »,
  // et on ne nettoie que la prose.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map(seg => {
      if (seg.startsWith("```") || (seg.startsWith("`") && seg.endsWith("`"))) return seg;
      return stripInProse(seg);
    })
    .join("");
}
