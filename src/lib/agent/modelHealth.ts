/**
 * Santé des modèles — routage ADAPTATIF de la cascade.
 *
 * ── Pourquoi ce module ────────────────────────────────────────────────────────
 * Mesures réelles sur le provider orvyx :
 *   - `glm-5.3-flash` et `deepseek-v4-flash` renvoient `429 Model busy` (saturés) ;
 *   - `deepseek-v4.1-flash` répond (TTFT ~2 s) mais avec un DÉBIT très faible
 *     (~0,4 chunk/s : 234 s pour 89 chunks), donc un tour interminable ;
 *   - `deepseek-v4-flash-0731` s'est montré le plus rapide (TTFT ~1,4 s).
 *
 * Or `buildModelChain` ordonnait la cascade de façon STATIQUE (modèle UI en tête,
 * puis `ORVYX_ALLOWED_MODELS`). Résultat : chaque tour recommençait par un modèle
 * saturé/lent, gaspillait un aller-retour, et la cascade ne « apprenait » rien.
 *
 * Ce module ajoute une mémoire de santé PAR MODÈLE, en mémoire (aucune
 * persistance, aucun réseau) :
 *   - `429` → cooldown : le modèle est relégué en fin de chaîne pendant un temps ;
 *   - TTFT observé → un score de vivacité (moyenne glissante) qui ordonne les
 *     modèles sains du plus réactif au plus lent.
 *
 * Logique PURE et testable : l'horloge est injectable (`now`), aucun effet de
 * bord global en dehors du registre singleton `modelHealth`.
 */

/** Durée de mise à l'écart d'un modèle après un `429`, en ms. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Nombre de mesures TTFT retenues pour la moyenne glissante. */
export const TTFT_SAMPLES = 5;

/** TTFT par défaut (ms) d'un modèle jamais mesuré : neutre, ni bon ni mauvais. */
export const UNKNOWN_TTFT_MS = 4_000;

interface Entry {
  /** Horodatage (ms epoch) de fin de cooldown suite à un 429. 0 = pas en cooldown. */
  cooldownUntil: number;
  /** Derniers TTFT observés (ms), les plus récents à la fin. */
  ttftSamples: number[];
}

/**
 * Registre de santé des modèles. Singleton partagé par tout le process : la
 * cascade d'un run profite de ce qu'ont appris les runs précédents (même fenêtre).
 */
export class ModelHealth {
  private readonly entries = new Map<string, Entry>();

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { cooldownUntil: 0, ttftSamples: [] }; this.entries.set(id, e); }
    return e;
  }

  /** Marque un modèle saturé (`429`) : il est écarté jusqu'à `now + cooldownMs`. */
  noteRateLimit(id: string, now = Date.now(), cooldownMs = RATE_LIMIT_COOLDOWN_MS): void {
    if (!id) return;
    const e = this.entry(id);
    e.cooldownUntil = Math.max(e.cooldownUntil, now + cooldownMs);
  }

  /**
   * Enregistre un TTFT observé (ms) pour un modèle, s'il est plausible.
   * Un TTFT ≤ 0 (aucun chunk) ou absurde est ignoré : il ne renseigne pas la
   * vivacité du modèle (ce cas est traité ailleurs, par les gardes de flux).
   */
  noteTtft(id: string, ttftMs: number): void {
    if (!id || !Number.isFinite(ttftMs) || ttftMs <= 0) return;
    const e = this.entry(id);
    e.ttftSamples.push(ttftMs);
    if (e.ttftSamples.length > TTFT_SAMPLES) e.ttftSamples.shift();
  }

  /** Le modèle est-il actuellement écarté (cooldown `429` non expiré) ? */
  isCoolingDown(id: string, now = Date.now()): boolean {
    return this.entry(id).cooldownUntil > now;
  }

  /**
   * Score de vivacité d'un modèle (ms) : moyenne des TTFT observés, ou valeur
   * neutre si inconnu. Plus le score est BAS, plus le modèle est réactif.
   */
  ttftScore(id: string): number {
    const s = this.entry(id).ttftSamples;
    if (s.length === 0) return UNKNOWN_TTFT_MS;
    return s.reduce((a, b) => a + b, 0) / s.length;
  }
}

/** Registre partagé (une instance par process). */
export const modelHealth = new ModelHealth();

/**
 * Ordonne la chaîne de modèles selon la santé observée.
 *
 * Règles (dans l'ordre) :
 *   1. `primary` (choix UI) reste PRIORITAIRE s'il n'est pas en cooldown : on ne
 *      contredit pas un choix explicite de l'utilisateur.
 *   2. Les modèles en cooldown (`429` récent) passent EN DERNIER — mieux vaut
 *      perdre un aller-retour sur un modèle saturé après avoir tenté les sains.
 *   3. Parmi les modèles sains, on trie par TTFT observé croissant (le plus
 *      réactif d'abord) ; à score égal, l'ordre déclaré est conservé (stable).
 *
 * Si `primary` est en cooldown, il est rétrogradé avec les autres : tenter un
 * modèle qu'on SAIT saturé en premier serait un gaspillage délibéré.
 *
 * @param now horodatage injectable (tests) — défaut : horloge réelle.
 */
export function rankModelChain(
  chain: readonly string[],
  health: ModelHealth = modelHealth,
  now = Date.now(),
): string[] {
  if (chain.length <= 1) return [...chain];

  // Index d'origine pour un tri STABLE (à score/santé égaux, on garde l'ordre).
  const indexed = chain.map((id, i) => ({ id, i }));
  indexed.sort((a, b) => {
    const cdA = health.isCoolingDown(a.id, now) ? 1 : 0;
    const cdB = health.isCoolingDown(b.id, now) ? 1 : 0;
    if (cdA !== cdB) return cdA - cdB;            // sains avant cooldown
    const sa = health.ttftScore(a.id);
    const sb = health.ttftScore(b.id);
    if (sa !== sb) return sa - sb;                // plus réactif d'abord
    return a.i - b.i;                             // stabilité
  });

  // `primary` (chain[0]) prioritaire s'il n'est PAS en cooldown.
  const primary = chain[0];
  const ordered = indexed.map(x => x.id);
  if (!health.isCoolingDown(primary, now)) {
    const without = ordered.filter(id => id !== primary);
    return [primary, ...without];
  }
  return ordered;
}
