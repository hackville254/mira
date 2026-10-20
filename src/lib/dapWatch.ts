import type { DapSourceBreakpoint } from './dap';

// ── Breakpoints : conversion des entrées UI → payload DAP ─────────────────────

/**
 * Entrée de breakpoint telle que stockée côté UI (miroir de BreakpointEntry
 * mais sans dépendance au contexte React, pour rester testable isolément).
 */
export interface BreakpointLike {
  line: number;
  verified: boolean;
  adapterBpId?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * Construit le payload `setBreakpoints` envoyé à l'adaptateur.
 * On n'inclut que les champs réellement définis : envoyer `condition: ''` ou
 * `logMessage: ''` est interprété différemment selon les adaptateurs (certains
 * traitent la chaîne vide comme une condition toujours vraie / un log vide).
 */
export function toSourceBreakpoints(entries: BreakpointLike[]): DapSourceBreakpoint[] {
  return entries.map(e => {
    const bp: DapSourceBreakpoint = { line: e.line };
    if (e.condition && e.condition.trim()) bp.condition = e.condition.trim();
    if (e.hitCondition && e.hitCondition.trim()) bp.hitCondition = e.hitCondition.trim();
    if (e.logMessage && e.logMessage.trim()) bp.logMessage = e.logMessage.trim();
    return bp;
  });
}

/** Un breakpoint est « log point » s'il porte un message de log. */
export function isLogPoint(e: BreakpointLike): boolean {
  return !!(e.logMessage && e.logMessage.trim());
}

/** Un breakpoint est « conditionnel » s'il porte une condition ou un hit count. */
export function isConditional(e: BreakpointLike): boolean {
  return !!((e.condition && e.condition.trim()) || (e.hitCondition && e.hitCondition.trim()));
}

// ── Watch / Debug Console : formatage des résultats d'évaluation ──────────────

export interface EvaluateResult {
  result: string;
  type?: string;
  variablesReference: number; // > 0 → résultat structuré, dépliable
}

export interface WatchEntry {
  /** Expression saisie par l'utilisateur. */
  expression: string;
  /** Dernier résultat connu (undefined tant que non évalué). */
  value?: string;
  type?: string;
  variablesReference?: number;
  /** Erreur d'évaluation (expression invalide au point d'arrêt courant). */
  error?: string;
}

/** Normalise une réponse `evaluate` DAP en entrée de watch exploitable. */
export function fromEvaluate(
  expression: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- réponse DAP non typée par commande
  res: any,
): WatchEntry {
  if (!res || typeof res !== 'object') {
    return { expression, error: 'no result' };
  }
  if (res.success === false) {
    return { expression, error: res.message ?? 'evaluation failed' };
  }
  return {
    expression,
    value: String(res.result ?? ''),
    type: typeof res.type === 'string' ? res.type : undefined,
    variablesReference: typeof res.variablesReference === 'number' ? res.variablesReference : 0,
  };
}

/** Ajoute (ou remonte) une expression dans la liste de watch, sans doublon. */
export function addWatch(list: WatchEntry[], expression: string): WatchEntry[] {
  const expr = expression.trim();
  if (!expr) return list;
  const without = list.filter(w => w.expression !== expr);
  return [...without, { expression: expr }];
}

/** Retire une expression de la liste de watch. */
export function removeWatch(list: WatchEntry[], expression: string): WatchEntry[] {
  return list.filter(w => w.expression !== expression);
}
