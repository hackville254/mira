/**
 * Origin — CLASSIFICATION de la fin d'un run d'agent (bench headless).
 *
 * POURQUOI CE MODULE (Étape 4)
 * ----------------------------
 * Sur les campagnes réelles, plusieurs instances SWE-bench se terminaient avec
 * un `stopReason`/message d'erreur GÉNÉRIQUE (« erreur agent ») ou après un
 * seul tour, alors que la MÊME instance, relancée, produisait 38 tours et un
 * vrai patch. Ces runs ne mesurent donc PAS la capacité de programmation du
 * modèle : ils mesurent une défaillance TRANSITOIRE (réseau, quota, réponse
 * tronquée, limite de sortie du fournisseur). Les compter comme « non résolu »
 * pollue le score et masque les progrès réels.
 *
 * Ce module transforme les seuls FAITS exposés par le moteur (motif d'arrêt
 * `done.reason`, `notice` de type `stop`/`recovery` avec `reason`, message
 * d'erreur, nombre de tours, texte produit) en une classe de terminaison
 * EXPLICITE et vérifiable, sans jamais inventer :
 *
 *   - `completed`      : l'agent a fini normalement (il a rendu la main).
 *   - `max_iterations` : budget de tours épuisé (limite du harnais, pas un bug).
 *   - `mistake_limit`  : le moteur a coupé sur une limite d'erreurs de l'agent.
 *   - `aborted`        : arrêt demandé (timeout du runner) — non concluant.
 *   - `truncated`      : réponse coupée en cours (fin de streaming, limite de
 *                        sortie du fournisseur) — le code peut être INCOMPLET.
 *   - `provider-error` : erreur du fournisseur/réseau (transitoire) — ne mesure
 *                        pas le modèle.
 *   - `failed`         : erreur d'agent non classable (à inspecter), rare.
 *
 * Un run `provider-error` ou `truncated` NE DOIT PAS être compté comme un échec
 * de résolution : le runner le marque comme tentative non concluante et le
 * rejoue, conformément à la règle « ne jamais confondre une erreur du
 * fournisseur avec une erreur de programmation du modèle ».
 *
 * PURETÉ
 * ------
 * Logique 100 % pure (aucune I/O) : testable sans sidecar ni réseau.
 */

/** Classes de terminaison observables d'un run. */
export type TerminationClass =
  | "completed"
  | "max_iterations"
  | "mistake_limit"
  | "aborted"
  | "truncated"
  | "provider-error"
  | "failed";

/** Faits bruts d'un run, tels que collectés par le client headless. */
export interface TerminationFacts {
  /** Motif de fin du moteur (`done.reason`), si émis. */
  stopReason?: string;
  /** Message d'erreur terminal (déjà nettoyé/jamais un secret). */
  error?: string;
  /** Dernier `notice` de type `stop`/`recovery` : motif fourni par le SDK. */
  noticeReason?: string;
  /** Message du dernier `notice` de type `stop`/`recovery`. */
  noticeMessage?: string;
  /** Vrai si le SDK a marqué l'erreur comme récupérable (transitoire). */
  recoverable?: boolean;
  /** Nombre de tours accomplis (0 = l'agent n'a jamais démarré). */
  turns: number;
}

/**
 * Motifs textuels qui trahissent un problème TRANSITOIRE ou d'infrastructure
 * (et non une incapacité du modèle). Volontairement larges mais explicites :
 * on préfère SUR-classer en `provider-error` plutôt que de fausser un score.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /truncat/i,
  /length/i,                 // finish_reason: "length" (limite de sortie)
  /max[_ -]?tokens/i,
  /context[_ -]?length/i,
  /rate[_ -]?limit/i,
  /too many requests/i,
  /429/,
  /timeout/i,
  /timed out/i,
  /econn(reset|refused|aborted)/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /5\d\d\b/,                 // 500/502/503/504 (passerelle/serveur)
  /overloaded/i,
  /unavailable/i,
  /quota/i,
  /insufficient/i,
  /stream/i,                 // fin de streaming anormale
  /aborted by (upstream|provider)/i,
];

/** Vrai si un texte d'erreur correspond à une défaillance transitoire. */
export function looksTransient(text: string | undefined): boolean {
  if (!text) return false;
  return TRANSIENT_PATTERNS.some(re => re.test(text));
}

/**
 * Classe la terminaison d'un run. Ordre de priorité : ce que le moteur a dit
 * (`done.reason`) prime ; sinon on s'appuie sur les `notice` et le message
 * d'erreur, en distinguant explicitement le transitoire du reste.
 */
export function classifyTermination(f: TerminationFacts): TerminationClass {
  const reason = f.stopReason;
  if (reason === "completed") return "completed";
  if (reason === "max_iterations") return "max_iterations";
  if (reason === "mistake_limit") return "mistake_limit";
  if (reason === "aborted") return "aborted";

  // `notice` explicite : le SDK signale une coupure (récupération/arrêt).
  if (f.noticeReason && /length|truncat|max[_ -]?tokens|context/i.test(f.noticeReason)) {
    return "truncated";
  }
  if (looksTransient(f.noticeMessage) || looksTransient(f.noticeReason)) {
    return "provider-error";
  }

  // Erreur terminale : transitoire → fournisseur, sinon échec d'agent.
  if (f.error) {
    // Une fin de streaming / limite de sortie est une TRONCATURE (le code peut
    // être incomplet), distincte d'une erreur réseau pure.
    if (/length|truncat|max[_ -]?tokens|context/i.test(f.error)) return "truncated";
    if (looksTransient(f.error)) return "provider-error";
    if (f.recoverable) return "provider-error";
    // Un run qui n'a produit AUCUN tour n'est jamais « l'agent a échoué à
    // résoudre » : c'est une défaillance d'infrastructure (le modèle n'a pas
    // répondu). On l'isole pour ne pas polluer le taux de résolution.
    if (f.turns === 0) return "provider-error";
    return "failed";
  }

  // Aucun motif ni erreur : si aucun tour n'a eu lieu, rien ne prouve que le
  // modèle a été évalué → non concluant, pas un échec de résolution.
  if (f.turns === 0) return "provider-error";
  // Un `done` sans `reason` exploitable : on reste factuel (`completed`) —
  // le moteur a rendu la main et c'est le TESTS qui tranchent.
  return "completed";
}

/**
 * Vrai si la classe de terminaison INVALIDE la mesure (le run ne dit rien sur
 * la capacité du modèle) : erreur fournisseur, réponse tronquée, ou aucune
 * activité observée. Ces tentatives doivent être rejouées, pas comptées.
 */
export function isInconclusive(cls: TerminationClass): boolean {
  return cls === "provider-error" || cls === "truncated";
}

/**
 * Vrai si le run s'est arrêté pour une raison qui relève du HARNAIS (budget de
 * tours, arrêt demandé) et non du modèle : utile pour l'analyse, mais le run
 * reste compté (l'agent a bien eu sa chance).
 */
export function isHarnessCapped(cls: TerminationClass): boolean {
  return cls === "max_iterations" || cls === "aborted";
}
