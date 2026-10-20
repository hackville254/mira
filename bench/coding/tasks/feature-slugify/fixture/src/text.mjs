// Module texte — la fonction slugify() reste à implémenter (tâche feature-slugify).

/**
 * Renvoie un titre mis en forme pour l'affichage.
 * (Fonction existante, à NE PAS casser.)
 */
export function titleCase(s) {
  return String(s)
    .split(" ")
    .map(w => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}
