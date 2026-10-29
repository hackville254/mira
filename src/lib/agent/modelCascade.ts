/**
 * Cascade de modèles — bascule automatique quand un modèle est saturé.
 *
 * ── Pourquoi ce module ────────────────────────────────────────────────────────
 * Mesures réelles sur le provider orvyx : `deepseek-v4-flash` donnait un TTFT de
 * 9–13 s et renvoyait `429 Model busy` (sans header `Retry-After`). Le retry
 * existant ne réessaie le même modèle qu'après un backoff, et n'insiste pas sur
 * un rate-limit sans `Retry-After` — donc le tour échouait.
 *
 * La parade : plusieurs modèles autorisés, essayés en cascade. Si le premier est
 * saturé, on passe au suivant immédiatement (pas d'attente), ce qui réduit aussi
 * le TTFT moyen puisqu'un modèle rapide prend le relais.
 *
 * Regroupe aussi la lecture de `ORVYX_ALLOWED_MODELS` (fallback `.env`) et la
 * liste par défaut. Logique PURE : aucune dépendance réseau ni React.
 */

/** Charge utile minimale d'un modèle candidat (le vrai objet vient de providers). */
export interface ModelCandidate<T = string> {
  id: string;
  value: T;
}

/**
 * Parse `ORVYX_ALLOWED_MODELS` : liste d'ids séparés par des virgules.
 * - trim chaque entrée, ignore les vides ;
 * - déduplique en gardant l'ORDRE de priorité (le premier = principal) ;
 * - une seule entrée (ou aucune) → pas de cascade.
 */
export function parseAllowedModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Construit la liste ordonnée des modèles à essayer.
 *
 * `primary` (le modèle choisi dans l'UI) passe TOUJOURS en premier : l'utilisateur
 * garde la main. Les modèles de `allowed` viennent ensuite comme filets, dans leur
 * ordre déclaré, sans doublon avec `primary`. Si `allowed` est vide, la cascade
 * se réduit au modèle principal (comportement d'origine, aucune régression).
 *
 * Cas où `primary` n'est pas dans `allowed` : on le garde quand même en tête —
 * forcer la liste blanche écraserait un choix explicite de l'utilisateur.
 */
export function buildModelChain(primary: string, allowed: readonly string[]): string[] {
  const chain: string[] = [];
  const push = (id: string) => {
    const v = id.trim();
    if (v && !chain.includes(v)) chain.push(v);
  };
  push(primary);
  for (const id of allowed) push(id);
  return chain;
}

/**
 * Index du prochain modèle à essayer après un échec, ou `null` si la cascade est
 * épuisée. On avance STRICTEMENT (jamais de retour en arrière) : une cascade qui
 * reboucle sur un modèle déjà saturé ne ferait que perdre du temps.
 */
export function nextModelIndex(current: number, total: number): number | null {
  const next = current + 1;
  return next < total ? next : null;
}

/**
 * Décide si un échec doit déclencher la bascule vers le modèle suivant.
 *
 * On bascule sur `rate-limited` et `transient` (saturation / surcharge), jamais
 * sur `permanent` (401, quota, requête invalide) : changer de modèle ne
 * corrigerait pas une clé invalide et masquerait l'erreur réelle.
 *
 * Sécurité anti-duplication : si le tour a DÉJÀ produit du contenu visible
 * (tokens, raisonnement, outil), on ne bascule PAS sur un autre modèle — il
 * rejouerait des éditions. On laisse la continuation en place.
 */
export function shouldFallback(
  kind: "permanent" | "rate-limited" | "transient",
  producedOutput: boolean,
): boolean {
  if (producedOutput) return false;
  return kind === "rate-limited" || kind === "transient";
}

/**
 * Décide si un PREMIER chunk trop tardif doit déclencher une bascule.
 *
 * ── Pourquoi ──────────────────────────────────────────────────────────────────
 * Mesures réelles : `deepseek-v4-flash` n'échoue pas toujours — il *répond*, mais
 * avec un TTFT de 9–13 s (provider surchargé). La cascade classique (sur erreur)
 * ne le couvre pas : il n'y a pas d'erreur à classer. Or c'est exactement le
 * symptôme « c'est super lent ». On bascule donc aussi sur TTFT excessif.
 *
 * Garde-fous :
 *   - `ttftMs < 0` (aucun chunk reçu) → NON : ce cas est traité par le garde
 *     anti-flux-muet / la classification d'erreur, pas ici.
 *   - seuil ≤ 0 → garde désactivée (comportement d'origine).
 *   - contenu déjà produit → NON : basculer rejouerait des éditions.
 *   - cascade épuisée → NON : rien vers quoi basculer.
 */
export function shouldFallbackOnSlowTtft(
  ttftMs: number,
  ttftBudgetMs: number,
  producedOutput: boolean,
  hasNextModel: boolean,
): boolean {
  if (producedOutput || !hasNextModel) return false;
  if (ttftBudgetMs <= 0) return false;
  if (ttftMs < 0) return false; // aucun chunk : cas « flux muet », pas « lent »
  return ttftMs > ttftBudgetMs;
}
