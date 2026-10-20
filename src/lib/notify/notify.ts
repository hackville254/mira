// ── Orchestrateur de notifications (parité Trae) ──────────────────────────────
//
// Trae notifie l'utilisateur à des moments PRÉCIS du cycle de l'agent. Chez
// Origin, l'état d'un run peut vivre en ARRIÈRE-PLAN (multitâche) : l'utilisateur
// regarde une autre tâche pendant qu'une première se termine. Sans notification,
// il ne le saurait jamais. Ce module centralise les 4 signaux utiles :
//
//   - finish   : une tâche vient de se terminer (toast + son) ;
//   - question : l'agent attend une réponse/approbation (toast + son) ;
//   - error    : un tour a échoué (toast + son) ;
//   - stop     : l'utilisateur a interrompu un run (son seul, pas de toast :
//                c'est une action VOLONTAIRE, inutile de la commenter visuellement).
//
// Règles (fidèles à Trae — « Task Status Notification ») :
//   - Trae prévient à la fois quand une tâche se TERMINE et quand elle ÉCHOUE,
//     via deux canaux indépendants : « Banner » (notre toast) et « Sound ».
//     Le son est donc joué pour TOUTE fin de tâche, qu'elle soit affichée ou
//     non (c'est exactement le réglage de Trae : on est alerté de la fin du
//     travail même en regardant ailleurs).
//   - « question » émet TOUJOURS (l'agent est bloqué : il faut réagir) ;
//   - « error » émet TOUJOURS (échec de tâche, cf. réglage Trae) ;
//   - « stop » n'émet qu'un son (action volontaire de l'utilisateur).
//
// Le module est PUR côté logique (aucune dépendance React) : la décision
// « faut-il notifier ? » est isolée dans `planNotification`, testable seule.

import type { SoundName } from "./sound";

export type NotificationKind = "finish" | "question" | "error" | "stop";

/** Préférence utilisateur : les notifications visuelles (toasts) sont-elles actives ? */
export const TOAST_PREF_KEY = "origin-notifications-toast";

/** Les toasts sont-ils activés ? (défaut : oui) */
export function isToastEnabled(): boolean {
  try {
    return localStorage.getItem(TOAST_PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Ce qu'une notification déclenche (toast et/ou son). */
export interface NotificationPlan {
  playSound: SoundName | null;
  toast: { text: string; type: "info" | "success" | "error" | "warning" } | null;
}

export interface NotificationContext {
  /** Libellé de la tâche concernée (titre humain). */
  taskLabel: string;
  /** La tâche concernée est-elle ACTUELLEMENT affichée ? */
  isDisplayed: boolean;
  /** Message d'erreur éventuel (kind = "error"). */
  errorMessage?: string;
  /** L'utilisateur a-t-il coupé les notifications visuelles ? */
  toastEnabled: boolean;
  /** L'utilisateur a-t-il coupé le son ? */
  soundEnabled: boolean;
}

/**
 * Décide CE QU'IL FAUT FAIRE pour un type de notification donné, selon le
 * contexte. Fonction pure : aucune I/O, donc directement testable.
 */
export function planNotification(
  kind: NotificationKind,
  ctx: NotificationContext,
): NotificationPlan {
  const sound: SoundName = kind;
  const soundPart = ctx.soundEnabled ? sound : null;
  const label = ctx.taskLabel || "Task";

  switch (kind) {
    case "finish":
      // Fin de tâche (cf. réglage Trae « Task Status Notification ») : on avertit
      // TOUJOURS, son + bannière, que la tâche soit affichée ou non. Le message
      // s'adapte simplement au contexte (nommée si la tâche n'est pas à l'écran).
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled
          ? { text: ctx.isDisplayed ? "Task finished" : `${label} finished`, type: "success" }
          : null,
      };

    case "question":
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled
          ? { text: ctx.isDisplayed ? "The agent is waiting for your reply" : `${label} is waiting for your reply`, type: "info" }
          : null,
      };

    case "error":
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled
          ? {
              text: ctx.errorMessage
                ? `${label} : ${ctx.errorMessage}`
                : `${label} failed`,
              type: "error",
            }
          : null,
      };

    case "stop":
      // Arrêt volontaire : son seul (aucun intérêt à commenter une action
      // explicitement demandée par l'utilisateur).
      return { playSound: soundPart, toast: null };
  }
}
