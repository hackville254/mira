/**
 * Copie « propre » d'une conversation.
 *
 * Problème corrigé : lorsqu'on sélectionne du texte à la souris dans le fil de
 * messages et qu'on fait Cmd/Ctrl+C, le navigateur embarque le HTML RENDU du
 * markdown (balises `<p>`, `<strong>`, styles inline des composants). Coller
 * ailleurs reproduit alors une mise en forme parasite. On veut du **texte brut
 * propre** : c'est le comportement attendu d'un chat (comme Trae/VS Code).
 *
 * Deux chemins, tous deux centralisés ici pour rester testables :
 *  1. `plainTextFromSelection` ─ extrait un texte brut lisible d'une sélection
 *     DOM (blocs séparés par un saut de ligne, pas de balises).
 *  2. `handleMessageAreaCopy` ─ handler `onCopy` : si la sélection courante est
 *     non vide ET contenue dans la zone des messages, on réécrit le presse-papier
 *     en texte brut et on empêche la copie HTML par défaut.
 *
 * Sécurité : on n'interprète jamais le contenu comme du HTML (jamais
 * `innerHTML`) ; on ne fait que lire du texte et le réécrire tel quel. Pas
 * d'exécution, pas d'injection possible.
 */

/**
 * Sérialise une sélection DOM en texte brut lisible.
 *
 * On parcourt les fragments de la sélection ; chaque bloc (paragraphe, item de
 * liste, ligne de code, cellules…) est terminé par un saut de ligne, afin que
 * le collage garde une structure de lignes sans aucun balisage.
 */
export function plainTextFromSelection(selection: Selection | null): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const container = document.createElement("div");
  container.appendChild(fragment);
  return extractBlockText(container).trim();
}

/** Balises de niveau bloc : chacune clôt une ligne dans le texte produit. */
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TR", "TABLE",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

/**
 * Parcourt un nœud et produit du texte brut : le contenu textuel est conservé
 * verbatim, et toute balise de bloc provoque un saut de ligne. Les `<br>` et
 * séparateurs de code deviennent aussi des sauts de ligne.
 */
export function extractBlockText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      out += "\n";
      continue;
    }
    const inner = extractBlockText(el);
    out += inner;
    if (BLOCK_TAGS.has(tag)) out += "\n";
    else if (tag === "CODE") out += inner && inner.includes("\n") ? "\n" : "";
  }
  // Compacte les lignes vides multiples sans supprimer les sauts utiles.
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * Handler `onCopy` à poser sur la zone des messages.
 *
 * Renvoie `true` si l'on a pris la main (copie texte brut écrite), `false` si
 * l'on laisse le comportement natif (sélection vide ou hors de la zone).
 * Le presse-papier est écrit via l'événement `clipboardData` (synchrone,
 * autorisé dans un handler `copy`) — pas d'API asynchrone, donc pas de course.
 */
export function handleMessageAreaCopy(e: React.ClipboardEvent, container: HTMLElement | null): boolean {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  // La sélection doit être entièrement dans la zone des messages : sinon on
  // laisse la copie native (ex. sélection dans l'éditeur).
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return false;
  const text = plainTextFromSelection(selection);
  if (!text) return false;
  e.preventDefault();
  e.clipboardData.setData("text/plain", text);
  return true;
}
