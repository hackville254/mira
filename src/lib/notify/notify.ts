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
// Règles de bruit (anti-spam), calquées sur l'usage réel :
//   - « finish » n'émet un TOAST que si la tâche terminée n'est PAS celle qui est
//     affichée (sinon l'utilisateur voit déjà le résultat dans le fil) ; le SON,
//     lui, est réservé au même cas (pour ne pas biper à chaque tour visible) ;
//   - « question » émet TOUJOURS (l'agent est bloqué : il faut réagir) ;
//   - « error » émet TOUJOURS (c'est un échec, il doit être visible) ;
//   - « stop » n'émet qu'un son.
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
      // Une tâche terminée EN ARRIÈRE-PLAN mérite une alerte ; la tâche affichée
      // se voit déjà dans le fil (pas de bruit inutile).
      if (ctx.isDisplayed) return { playSound: null, toast: null };
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled ? { text: `${label} terminée`, type: "success" } : null,
      };

    case "question":
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled
          ? { text: ctx.isDisplayed ? "L'agent attend ta réponse" : `${label} attend ta réponse`, type: "info" }
          : null,
      };

    case "error":
      return {
        playSound: soundPart,
        toast: ctx.toastEnabled
          ? {
              text: ctx.errorMessage
                ? `${label} : ${ctx.errorMessage}`
                : `${label} a échoué`,
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
