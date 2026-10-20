/**
 * Mira — Neutralisation de la marque interne.
 *
 * RÈGLE D'OR PRODUIT : le client ne doit JAMAIS voir le mot « cline » (ni savoir
 * qu'un SDK tiers est utilisé). Or plusieurs surfaces peuvent laisser filtrer ce
 * mot :
 *   - les messages d'erreur du SDK (ex. chemins de plugins, diagnostics) ;
 *   - les chemins de fichiers par défaut (`.cline/skills`, `~/Documents/Cline/…`).
 *
 * Ce module est la DÉFENSE EN PROFONDEUR : il réécrit toute chaîne qui sort du
 * sidecar vers le front. On préfère un message neutre et légèrement imprécis à une
 * fuite de marque. Aucune donnée sensible n'est concernée : ce sont des libellés.
 */

/**
 * Réécrit les occurrences visibles de la marque interne dans une chaîne.
 *
 * Ordre volontaire : d'abord les formes composées (`.clinerules`, `Documents/Cline`,
 * `cline_mcp_settings`) AVANT la règle générique, qui capte ensuite **tout** reste
 * (y compris les formes collées `@cline/core`, `ClineCore`, `clineClient`). Une
 * seule passe générique finale rend le résultat déterministe et testable.
 */
export function neutralizeBrand(input: string): string {
  return input
    // Formes composées à préserver en un seul morceau (sinon la règle générique
    // laisserait des artefacts du type « .Mira » vs « .mira »).
    .replace(/\.clinerules/gi, ".mira")
    .replace(/\.cline\b/gi, ".mira")
    .replace(/Documents[/\\]Cline/gi, "Documents/Mira")
    .replace(/cline_mcp_settings\.json/gi, "mira_mcp_settings.json")
    // Règle générique finale : TOUT « cline » restant (mot seul OU collé dans un
    // identifiant / chemin type `@cline/core`, `ClineCore`, `clineClient`).
    .replace(/cline/gi, "Mira");
}

/**
 * Neutralise une valeur quelconque destinée à l'affichage client.
 * Tolère les erreurs (converties via `String`), `undefined`, etc.
 */
export function neutralizeForClient(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  return neutralizeBrand(raw);
}
