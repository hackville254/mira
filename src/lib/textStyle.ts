// Nettoyage défensif du texte généré par le modèle pour l'UI.
//
// Le prompt système interdit les emojis et les tirets longs (cf. STYLE_GUARDRAIL
// dans lib/ai.ts), mais un modèle peut toujours en émettre malgré la consigne.
// Ce filet garantit une UI sobre sans casser le Markdown ni le code : les blocs
// de code (``` … ```) et le code inline (`…`) sont préservés intacts.

// Emojis et pictogrammes décoratifs (plages Unicode standard emoji).
const EMOJI_RE =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u20E3\u200D]/gu;

// Tiret em (—), tiret en (–) et barre horizontale (―) : remplacés par un tiret
// simple, à la manière de la ponctuation que l'utilisateur attend.
const DASH_RE = /[\u2014\u2013\u2015]/g;

function stripInProse(text: string): string {
  return text
    .replace(EMOJI_RE, "")
    // Tiret long entouré d'espaces -> « - » ; collé à un mot -> «-».
    .replace(/ +[\u2014\u2013\u2015] +/g, " - ")
    .replace(DASH_RE, "-")
    // Espaces multiples créés par le retrait (intra-ligne uniquement).
    .replace(/ {2,}/g, " ")
    // Espaces laissés en fin de ligne après retrait (avant le saut de ligne).
    .replace(/[ \t]+$/gm, "")
    // Emoji laissé seul sur sa ligne → ligne vide : on la supprime.
    .replace(/^[ \t]*\n/gm, "");
}

/**
 * Retire les emojis décoratifs et normalise les tirets longs d'un contenu
 * Markdown, en préservant le code (blocs ``` … ``` et code inline `…`) qui
 * pourrait légitimement en contenir.
 */
export function sanitizeProse(text: string): string {
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
