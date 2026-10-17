/**
 * Mira — Neutralisation de la marque interne (côté RENDU).
 *
 * RÈGLE D'OR PRODUIT : le client ne doit JAMAIS voir le mot « cline » ni savoir
 * qu'un SDK tiers est utilisé. Le sidecar neutralise déjà ses propres messages,
 * MAIS le front est la dernière barrière avant l'écran : on y applique la même
 * garantie en défense en profondeur (robuste à une régression du sidecar ou à un
 * message provenant d'une autre source, ex. erreur réseau, sortie d'outil).
 *
 * Volontairement sans dépendance : ce module reste trivial à auditer.
 */

/**
 * Réécrit les occurrences visibles de la marque interne dans une chaîne.
 *
 * Ordre volontaire : formes composées d'abord (pour éviter les artefacts
 * `.Mira` / `.mira`), puis une passe générique finale qui capte tout le reste
 * (`@cline/core`, `ClineCore`, `clineClient`…).
 */
export function neutralizeBrand(input: string): string {
  return input
    .replace(/\.clinerules/gi, ".mira")
    .replace(/\.cline\b/gi, ".mira")
    .replace(/Documents[/\\]Cline/gi, "Documents/Mira")
    .replace(/cline_mcp_settings\.json/gi, "mira_mcp_settings.json")
    .replace(/cline/gi, "Mira");
}

/** Neutralise une valeur destinée à l'affichage (string, Error, objet…). */
export function neutralizeForClient(value: unknown): string {
  if (value === null || value === undefined) return "";
  return neutralizeBrand(typeof value === "string" ? value : String(value));
}
