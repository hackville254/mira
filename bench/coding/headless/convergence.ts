/**
 * Origin — Détection de NON-CONVERGENCE d'un run d'agent (bench headless).
 *
 * POURQUOI CE MODULE (Étape 3)
 * ----------------------------
 * Sur les campagnes réelles, plusieurs tâches consomment tout leur budget de
 * tours sans jamais produire de correction : l'agent relance indéfiniment les
 * mêmes outils (exploration) au lieu de converger vers un patch. Le côté coûteux
 * et trompeur, c'est de laisser le run épuiser `max_iterations` (40 tours,
 * ~1 M tokens d'entrée observés) pour un résultat vide.
 *
 * On veut donc un signal HONNÊTE et OBSERVABLE, calculé à partir des seuls
 * faits exposés par le SDK (nom d'outil, fin de tour, motif d'arrêt) :
 *  - répétition consécutive d'un même outil (boucle d'exploration) ;
 *  - nombre de tours élevé sans aucun appel d'un outil d'ÉCRITURE (stérilité).
 *
 * Aucune invention : ce module ne juge jamais la RÉUSSITE (c'est le rôle des
 * tests). Il qualifie uniquement la FORME du run, pour que le runner puisse
 * déclencher une reprise ciblée plutôt que d'attendre l'épuisement.
 *
 * PURETÉ
 * ------
 * Logique 100 % pure (aucune I/O, aucun accès au process) : testable sans
 * sidecar ni réseau, et réutilisable par les runners SWE-bench et LCB.
 */

/** Seuils de déclenchement, choisis pour éviter les faux positifs. */
export const CONVERGENCE = {
  /**
   * Répétitions CONSÉCUTIVES du même outil au-delà desquelles on considère
   * qu'il y a boucle. Un run normal alterne lecture/édition/commandes : une
   * série franche de 5+ appels identiques d'affilée est un signal, pas du bruit.
   */
  REPEAT_THRESHOLD: 5,
  /**
   * Nombre de tours au-delà duquel l'absence TOTALE d'appel d'écriture devient
   * suspecte (l'agent n'a rien tenté de corriger).
   */
  STALL_TURNS: 12,
} as const;

/**
 * Outils considérés comme des ÉCRITURES (l'agent modifie le dépôt). On reste
 * volontairement large sur les noms du SDK Cline : `editor` couvre
 * write/replace, et `apply_patch`/`write` les variantes connues.
 */
const WRITE_TOOLS = new Set(["editor", "write", "apply_patch", "edit_file", "create_file"]);

/** Diagnostic de forme d'un run (jamais un verdict de réussite). */
export interface ConvergenceReport {
  /** Appels d'outils par nom (ordre d'insertion = premier appel). */
  toolNameCounts: Record<string, number>;
  /** Plus longue série d'appels consécutifs du même outil. */
  maxConsecutiveSameTool: number;
  /** Nombre d'appels d'un outil d'écriture observés. */
  writeCalls: number;
  /** `true` si une boucle d'outil a été détectée (série ≥ seuil). */
  loopDetected: boolean;
  /**
   * `true` si l'agent a dépassé `STALL_TURNS` tours sans aucune écriture :
   * exploration stérile. Faux si aucun tour enregistré (rien à conclure).
   */
  stalled: boolean;
}

/**
 * Accumule les observations d'un run et produit un `ConvergenceReport`.
 * Usage : `observe(toolName)` à chaque fin d'appel d'outil, `setTurns(n)` sur
 * chaque fin de tour, puis `report()`.
 */
export class ConvergenceTracker {
  private readonly counts: Record<string, number> = {};
  private lastTool = "";
  private consecutive = 0;
  private maxConsecutive = 0;
  private writeCalls = 0;
  private turns = 0;

  /** Enregistre un appel d'outil terminé (nom du SDK). */
  observe(toolName: string): void {
    if (!toolName) return;
    this.counts[toolName] = (this.counts[toolName] ?? 0) + 1;
    this.consecutive = toolName === this.lastTool ? this.consecutive + 1 : 1;
    this.lastTool = toolName;
    if (this.consecutive > this.maxConsecutive) this.maxConsecutive = this.consecutive;
    if (WRITE_TOOLS.has(toolName)) this.writeCalls++;
  }

  /** Fixe le nombre de tours accomplis (idempotent, valeur absolue). */
  setTurns(turns: number): void {
    this.turns = turns;
  }

  /** Fige l'état courant sous forme de rapport. */
  report(): ConvergenceReport {
    return {
      toolNameCounts: { ...this.counts },
      maxConsecutiveSameTool: this.maxConsecutive,
      writeCalls: this.writeCalls,
      loopDetected: this.maxConsecutive >= CONVERGENCE.REPEAT_THRESHOLD,
      stalled: this.turns >= CONVERGENCE.STALL_TURNS && this.writeCalls === 0,
    };
  }
}

/**
 * Décide d'une reprise ciblée à partir du rapport de convergence et du motif
 * d'arrêt. On ne relance QUE si le run a épuisé son budget sans jamais écrire
 * (sinon le patch serait écrasé) OU s'il a bouclé sur un outil.
 *
 * @returns la consigne de reprise à ajouter au prochain tour, ou `null` si
 *          aucune reprise n'est justifiée (on ne gaspille pas de budget).
 */
export function resumeInstruction(
  report: ConvergenceReport,
  stopReason: string | undefined,
): string | null {
  const exhausted = stopReason === "max_iterations";
  if (!report.stalled && !report.loopDetected && !exhausted) return null;
  if (report.writeCalls > 0 && !report.loopDetected) {
    // L'agent a déjà écrit : une reprise risquerait de repartir de zéro et de
    // détruire un patch partiel. On préfère rendre la main (évaluation normale).
    return null;
  }
  return [
    "Tu as épuisé ton budget d'exploration sans appliquer de correction.",
    "STOP à l'exploration. À partir de ce que tu as DÉJÀ lu :",
    "1) énonce en 2 lignes la cause racine la plus probable ;",
    "2) applique la correction MINIMALE en éditant le fichier source concerné ;",
    "3) termine immédiatement. N'appelle plus d'outil de recherche.",
  ].join("\n");
}
