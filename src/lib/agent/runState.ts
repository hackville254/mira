import type { DisplayMessage, MessagePart } from "../aiTypes";

// ── État de run par session (multitasking, parité Trae) ────────────────────────
//
// PROBLÈME RÉSOLU : dans `AiPanel`, l'état d'un run vivait dans des refs
// MONO-RUN (`streamCleanupRef`, `pendingContentRef`, `pendingPartsRef`,
// `pendingAssistantDbIdRef`, `runSeqRef`). Comme il n'y avait qu'un seul jeu de
// refs, démarrer ou afficher une autre tâche écrasait le run en cours — au mieux
// on l'interrompait, au pire on corrompait son contenu partiel.
//
// Ici, chaque SESSION possède son propre `RunState`. Un run peut donc continuer
// à produire ses événements pendant que l'UI affiche une autre tâche : le
// composant ne fait que LIRE l'état de la session affichée, il ne le détient pas.
//
// Le module est volontairement SANS React : il ne tient que des données, ce qui
// le rend testable sans DOM ni sidecar. `AiPanel` l'appelle via `getRun(sessionId)`.

/** Contenu ancré d'un run (contenu texte + parts) avant flush en DB. */
export interface RunBuffers {
  /** Contenu texte accumulé du message assistant en cours. */
  content: string;
  /** Parts structurées accumulées (tool-calls, status, sous-agents…). */
  parts: MessagePart[];
}

/** État complet d'un run, propre à UNE session. */
export interface RunState {
  /**
   * Coupe le run : abort SDK + détache l'écouteur d'événements. `null` quand
   * aucun run n'est vivant. C'est le remplacement de `streamCleanupRef`.
   */
  cleanup: (() => void) | null;
  /**
   * Numéro de génération du run. Incrémenté à chaque envoi ET à chaque stop.
   * Les événements d'un run périmé (seq différent) sont ignorés par le handler,
   * ce qui garantit qu'un stream annulé n'écrit plus dans le fil.
   */
  seq: number;
  /** Id DB du message assistant en cours (placeholder), `null` si non persisté. */
  pendingAssistantDbId: string | null;
  /** Contenu texte accumulé du message assistant en cours. */
  pendingContent: string;
  /** Parts structurées accumulées (tool-calls, status, sous-agents…). */
  pendingParts: MessagePart[];
  /** Timer de flush débouncé du contenu vers l'UI/DB. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Vrai dès qu'un outil a écrit pendant ce run (déclenche la bannière de revue). */
  dirty: boolean;
  /** Nombre de sous-agents lancés pendant ce run (trace d'orchestration). */
  spawned: number;
  /**
   * Vrai dès qu'un tour de CE run a exécuté une commande de VÉRIFICATION
   * (`run_commands` avec une commande de contrôle : tests, typecheck, lint,
   * build). Preuve que le modèle a vérifié son travail — cf. `terminationGate`.
   */
  ranVerification: boolean;
  /**
   * Vrai dès que le modèle a posé une QUESTION à l'utilisateur (`ask_question`).
   * Un tour qui se termine sur une question n'est pas une clôture « succès » :
   * le gate de terminaison ne doit pas le viser (décision non prise).
   */
  askedUser: boolean;
  /**
   * Vrai si le GATE de terminaison a déjà REFUSÉ une clôture non prouvée sur ce
   * run. COLLANT : on n'accorde qu'UNE relance de vérification par run, jamais
   * une boucle (un gate qui boucle bloquerait l'utilisateur).
   */
  verificationGuardFired: boolean;
  /**
   * Vrai dès qu'un tour de cette session a activé l'outillage d'équipe Cline.
   * COLLANT : une fois les équipes ouvertes dans une conversation, on ne
   * rebascule pas sur un runtime allégé en plein travail (sinon on rouvrirait
   * une session sans les outils d'équipe alors qu'un coéquipier peut être actif).
   * L'escalade est pilotée par le modèle : il appelle `escalate_to_team` en plein
   * tour léger, le front bascule ce flag et relance avec les équipes.
   */
  teamsEnabled: boolean;
  /**
   * Messages MIROIR du run tels qu'ils doivent s'afficher quand cette session est
   * visible. Permet à une tâche en arrière-plan de rejouer son fil à la reprise.
   * `null` tant que la session n'a jamais été le siège d'un run dans ce process.
   */
  messages: DisplayMessage[] | null;
  /**
   * Handle d'enregistrement du STATUT du run dans le registre `taskRuntime`
   * (multitasking). Typé structurellement pour éviter une dépendance circulaire
   * entre `runState` et `taskRuntime`. `null` hors run.
   */
  task: { setAbort: (abort: (() => void) | null) => void; complete: () => void; interrupt: () => void } | null;
}

const runs = new Map<string, RunState>();

function fresh(): RunState {
  return {
    cleanup: null,
    seq: 0,
    pendingAssistantDbId: null,
    pendingContent: "",
    pendingParts: [],
    flushTimer: null,
    dirty: false,
    spawned: 0,
    ranVerification: false,
    askedUser: false,
    verificationGuardFired: false,
    teamsEnabled: false,
    messages: null,
    task: null,
  };
}

/**
 * Récupère (ou crée) l'état de run d'une session. Toujours non-null : un run
 * « vierge » est renvoyé pour une session inconnue, ce qui évite toute garde
 * `?.` dans le composant.
 */
export function getRun(sessionId: string | null | undefined): RunState {
  const key = sessionId ?? "";
  let st = runs.get(key);
  if (!st) { st = fresh(); runs.set(key, st); }
  return st;
}

/** Remet un run à zéro (nouvelle génération) — sans toucher aux autres sessions. */
export function resetRun(sessionId: string | null | undefined): RunState {
  const st = fresh();
  runs.set(sessionId ?? "", st);
  return st;
}

/**
 * Purge l'état d'un run terminé : coupe le moteur s'il vit encore, libère le
 * timer, et supprime l'entrée. À appeler à la fermeture / suppression d'une
 * tâche pour ne pas laisser fuiter des runs morts.
 */
export function forgetRun(sessionId: string): void {
  const st = runs.get(sessionId);
  if (!st) return;
  st.cleanup?.();
  if (st.flushTimer) clearTimeout(st.flushTimer);
  runs.delete(sessionId);
}

/** Liste les sessions ayant un run VIVANT (cleanup non nul). */
export function listLiveRuns(): string[] {
  const out: string[] = [];
  for (const [id, st] of runs) if (st.cleanup) out.push(id);
  return out;
}

/**
 * Miroir du fil d'une session : mémorise les messages à réafficher à la reprise.
 * Appelé par `AiPanel` à chaque changement de messages d'une session qui tourne
 * en arrière-plan (celle qui n'est PAS affichée).
 */
export function setRunMessages(sessionId: string, messages: DisplayMessage[]): void {
  getRun(sessionId).messages = messages;
}

/** Miroir du fil d'une session, ou `null` si aucun run n'y a tourné. */
export function getRunMessages(sessionId: string): DisplayMessage[] | null {
  return runs.get(sessionId)?.messages ?? null;
}

/** Petit logger utile aux diagnostics (aucun effet de bord). */
export function runDebugSnapshot(sessionId: string): {
  seq: number; alive: boolean; dirty: boolean; spawned: number;
} {
  const st = getRun(sessionId);
  return { seq: st.seq, alive: st.cleanup !== null, dirty: st.dirty, spawned: st.spawned };
}
