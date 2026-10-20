// ── Gate de TERMINAISON (Lot D) ──────────────────────────────────────────────
//
// PROBLÈME (agents réels) : un modèle a une tendance forte à déclarer une tâche
// « terminée » alors qu'il n'a RIEN vérifié — il décrit le succès attendu au
// lieu de l'observer. Sur un petit projet, ça passe ; sur un projet de plusieurs
// millions de lignes, ça produit des régressions silencieuses.
//
// RÉPONSE : à la fin d'un tour d'agent qui a MODIFIÉ le workspace, si le modèle
// clôt sur une affirmation de succès (« done », « terminé », « I've completed »…)
// SANS avoir affiché la moindre preuve de vérification (une commande de contrôle
// exécutée ou une demande de validation), on ne laisse pas passer : on RELANCE
// un tour de vérification. Le modèle doit alors lancer un check réel — typiquement
// via `run_commands` — puis conclure sur preuve.
//
// RÈGLE ANTI-BIAIS : ce module ne juge QUE des faits OBSERVABLES (a-t-on écrit ?
// a-t-on exécuté un check ?). Il ne présume rien de l'intention du modèle et ne
// récompense aucune formulation. Une seule relance est autorisée (`guardFired`)
// pour ne jamais boucler. Si la vérification est IMPOSSIBLE (aucune commande de
// contrôle active), on ne bloque pas : un gate qui bloque sans échappatoire
// serait un piège, pas une garantie.

/**
 * Motifs (en minuscules) d'une commande shell qui constituent une VÉRIFICATION
 * réelle du code. Volontairement large : l'objectif est de détecter « le modèle
 * a exécuté quelque chose qui prouve son travail », pas de whitelister un runner.
 *
 * On distingue deux familles :
 *   - typecheck/utils de test/lint/formatters : chaque outil énuméré ;
 *   - gestionnaires de paquets avec un script connu (`npm test`, `cargo check`…)
 *     via `… (test|check|build|lint|typecheck|fmt) …`.
 */
const VERIFICATION_PATTERNS: readonly RegExp[] = [
  // JS/TS
  /\btsc\b/, /\bvitest\b/, /\bjest\b/, /\bplaywright\b/, /\bmocha\b/, /\beslint\b/,
  /\bprettier\b/, /\bbiome\b/, /\bnode\s+--test\b/,
  // Rust
  /\bcargo\s+(check|test|build|clippy|fmt)\b/,
  // Python
  /\bpytest\b/, /\bmypy\b/, /\bruff\b/, /\bflake8\b/, /\bpython\s+-m\s+(pytest|compileall|mypy)\b/,
  // Go
  /\bgo\s+(build|test|vet)\b/,
  // Gestionnaires de paquets avec un script de contrôle explicite
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|build|lint|typecheck|type-check|fmt|format)\b/,
  /\bmake\s+(test|check|build|lint)\b/,
  /\bmvn\s+\S*(test|verify)\b/,
  /\bgradle\w*\s+\S*(test|check|build)\b/,
];

/** Vrai si `command` est une commande de VÉRIFICATION (preuve d'auto-contrôle). */
export function isVerificationCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const c = command.trim().toLowerCase();
  if (!c) return false;
  return VERIFICATION_PATTERNS.some(re => re.test(c));
}

/**
 * Motifs (en minuscules) d'une AFFIRMATION DE SUCCÈS dans le texte final du
 * modèle. On cherche une conclusion POSITIVE (« c'est fait », « terminé »,
 * « le build passe maintenant »), pas une simple description d'action.
 *
 * Le test est ancré sur des mots entiers pour éviter les faux positifs
 * (`done` dans `undone`, `fix` dans `prefix`).
 */
const SUCCESS_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bdone\b/, /\bcompleted?\b/, /\bfinished\b/, /\bimplemented\b/, /\bfixed\b/,
  /\bit works\b/, /\bnow works\b/, /\bworks now\b/, /\bpasses\b/, /\bpassing\b/,
  /\ball tests pass\b/, /\bsuccessfully\b/, /\btermin[ée]/i, /\bc'est fait\b/,
  /✅/,
];

/** Vrai si le texte final prétend que la tâche est RÉUSSIE. */
export function claimsSuccess(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const t = text.toLowerCase();
  // On écarte d'abord les NÉGATIONS : « not done », « can't », « couldn't »,
  // « didn't », « unable », « pas encore », « non vérifié »… Un aveu d'échec
  // n'est PAS une revendication de succès, et le gate ne doit pas le viser.
  const negated = /\b(not|no|never|can't|cannot|couldn't|didn't|won't|isn't|aren't|unable|without|fail(?:ed|s)?|pas|non|jamais|impossible|aucun)\b/;
  return SUCCESS_CLAIM_PATTERNS.some(re => {
    const m = re.exec(t);
    if (!m) return false;
    // Fenêtre de 24 caractères AVANT le match : porte la polarité de la phrase.
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    return !negated.test(before);
  });
}

/** Faits observés pendant le tour, nécessaires à la décision du gate. */
export interface TurnFacts {
  /** Le tour a-t-il MODIFIÉ le workspace (au moins une écriture réussie) ? */
  wroteWorkspace: boolean;
  /** Le tour a-t-il EXÉCUTÉ au moins une commande de vérification (`run_commands`) ? */
  ranVerification: boolean;
  /** Le tour a-t-il demandé une validation à l'utilisateur (question posée) ? */
  askedUser: boolean;
  /**
   * Un contrôle de qualité est-il ACTIF (famille `detect_checks` branchée) ?
   * Faux → pas de mechanisme de vérification disponible : le gate s'abstient.
   */
  qualityToolsAvailable: boolean;
  /** Le gate a-t-il DÉJÀ été déclenché pour cette tâche ? (au plus une relance) */
  guardFired: boolean;
}

/** Décision du gate de terminaison. */
export type GateDecision =
  | { action: "allow" }
  /** REFUSER la clôture : injecter une consigne de vérification et relancer. */
  | { action: "verify"; reminder: string; reason: string };

/**
 * Rappel injecté au modèle quand il tente de clore sans preuve de vérification.
 * Impératif et actionnable : lancer un contrôle RÉEL, puis conclure sur le
 * résidu éventuel. Formulé pour ne pas « inventer » de succès.
 */
export const VERIFY_BEFORE_FINISH_REMINDER = [
  "STOP — do not report success yet.",
  "You changed the workspace this turn but never ran a check that PROVES the change works.",
  "Do this now, do not describe it: run the project's own verification command",
  "(use `detect_checks` if you don't already know it, then `run_commands`) — typecheck, build, or the relevant tests.",
  "Then read the REAL output. Report success ONLY if it passed; otherwise fix the failure, or state plainly what is unverified and why.",
].join(" ");

/**
 * Décide si la clôture du tour doit être ACCEPTÉE ou REFUSÉE faute de preuve.
 *
 * Ne refuse QUE dans un cas précis et vérifiable :
 *   écriture réelle + aucune vérification + aucune question posée + succès
 *   revendiqué + outillage de contrôle disponible + relance pas déjà tentée.
 *
 * @param finalText   Texte final du modèle (dernier message du tour).
 * @param facts       Faits observés pendant le tour (cf. `TurnFacts`).
 */
export function shouldBlockForVerification(finalText: string, facts: TurnFacts): GateDecision {
  const qualifies =
    facts.wroteWorkspace
    && !facts.ranVerification
    && !facts.askedUser
    && facts.qualityToolsAvailable
    && !facts.guardFired
    && claimsSuccess(finalText);

  if (!qualifies) return { action: "allow" };

  return {
    action: "verify",
    reminder: VERIFY_BEFORE_FINISH_REMINDER,
    reason: "success claimed with no verification after writing to the workspace",
  };
}
