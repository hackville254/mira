/**
 * Origin — Harness Cline du mode IDE (1 agent seul).
 *
 * RÔLE
 * ----
 * Ce module branche le moteur d'agent Cline (sidecar Node piloté par Rust) sur
 * la politique de permission d'Origin (`permissions.ts`) et sur le checkpoint
 * undo/keep (`turnCheckpoint.ts`). Il ne fait AUCUN rendu : il fournit un
 * « lanceur » prêt à l'emploi que `AiPanel` appelle à la place de l'ancien
 * harness `runAgent`.
 *
 * POURQUOI UN MODULE À PART
 * -------------------------
 *   1. **Testable sans UI** : la logique d'approbation + de checkpoint est du
 *      domaine, pas du React. On peut la vérifier au terminal.
 *   2. **Uniformité IDE / IA** : le mode IDE (ce module) et le mode IA (teams
 *      Cline) partagent EXACTEMENT la même fabrique de handlers — un seul
 *      endroit décide « qui approuve quoi », donc pas de divergence de politique
 *      entre les deux modes.
 *   3. **Isolement du couplage** : `AiPanel` reste centré sur l'affichage ; il
 *      ne connaît ni `ClineApprovalHandlers` ni le détail des verdicts.
 *
 * SÉCURITÉ
 * --------
 *   - **Le verdict vient TOUJOURS de `decideApproval`** (règles déterministes,
 *     garde anti-catastrophe non désactivable). Aucune auto-approbation ici.
 *   - **Aucune clé ne transite** : ce module ne voit jamais l'apiKey (elle part
 *     directement de `AiPanel` vers `startClineRun`).
 *   - **Un verdict `block` refuse l'outil ET le signale à l'UI** (toast), jamais
 *     une exécution silencieuse.
 *   - **`ask` reste `ask`** : en l'absence de carte de confirmation branchée sur
 *     le canal Cline (lot suivant), un `ask` est **refusé** plutôt qu'auto-
 *     approuvé — le comportement le plus sûr (jamais d'écriture non confirmée).
 */

import {
  startClineRun,
  type ClineRunHandle,
  type ClineStartParams,
  type ClineExtraToolSpec,
  type ClineToolEvent,
} from "./clineClient";
import { decideApproval, loadPermissionMode } from "./permissions";
import type { AgentEvent } from "./run";
import type { PendingAction } from "./tools";

/** Verdict minimal renvoyé par un décideur d'approbation (jamais un secret). */
export interface HarnessDecision {
  approved: boolean;
  reason?: string;
}

/** Options de lancement d'un run Cline (mode IDE : un seul agent). */
export interface ClineHarnessOptions {
  /** Racine du workspace ouvert (chemin absolu). */
  workspace: string;
  /** Fournisseur OpenAI-compatible : identifiant Cline + base URL. */
  providerId: string;
  /**
   * Base URL à surcharger, ou `undefined` pour laisser le SDK appliquer son
   * défaut (providers natifs). Ne JAMAIS passer une chaîne vide.
   */
  baseUrl?: string;
  apiKey: string;
  /** Modèle choisi dans l'UI (tête de la chaîne). */
  modelId: string;
  /** Prompt système composé (Origin + contexte projet). */
  systemPrompt: string;
  /** Mode d'agent Cline (`act` par défaut). */
  mode?: string;
  /** Mode IA : active les équipes Cline. Défaut false (IDE = 1 agent seul). */
  enableTeams?: boolean;
  /** Garde-fou anti-boucle passé au SDK. */
  maxIterations?: number;
  /**
   * Session SDK existante à REPRENDRE (continuité multi-tours). Fournie par
   * `AiPanel` à partir de la colonne DB `cline_session_id` : tant qu'elle est
   * valide, on ne recrée pas de session et l'agent garde tout son historique.
   */
  resumeSessionId?: string;
  /**
   * Outils CUSTOM déclaratifs à injecter dans la session (ex. `todo_write`/
   * `todo_read`). Uniquement appliqués à la CRÉATION d'une session (un `start`) :
   * sur une reprise, les outils existent déjà côté SDK.
   */
  extraTools?: ClineExtraToolSpec[];
  /**
   * Reçoit les EFFETS d'outils custom (ex. mise à jour de la todo list) pour
   * que le front les applique dans son store réactif. Optionnel.
   */
  onToolEvent?: (event: ClineToolEvent) => void;
  /** Callback du flux d'événements traduits (même contrat que `runAgent`). */
  onEvent: (event: AgentEvent) => void;
  /**
   * Laisse l'appelant réagir au refus d'office (garde anti-catastrophe) : on ne
   * se contente pas de refuser l'outil, on l'EXPLIQUE à l'utilisateur.
   */
  onBlocked?: (action: PendingAction, reason: string) => void;
  /**
   * Snapshot undo/keep AVANT chaque écriture (chemin + racine du workspace).
   * Idempotent côté appelant (`touchTurnFile`).
   */
  onBeforeWrite?: (path: string, workspaceRoot?: string | null) => void | Promise<void>;
}

/**
 * Décideur d'approbation partagé IDE / IA.
 *
 * Applique `permissions.ts` au mode courant (localStorage, lu à l'instant T —
 * un changement de mode est donc pris en compte immédiatement, sans recréer le
 * run). Un `ask` est **refusé** faute de canal de confirmation : c'est le seul
 * comportement sûr tant que la carte UI n'est pas branchée sur ce canal.
 */
export function makeApprovalDecider(
  workspace: string,
  onBlocked?: (action: PendingAction, reason: string) => void,
): (action: PendingAction) => HarnessDecision {
  return (action: PendingAction): HarnessDecision => {
    const verdict = decideApproval(action, { mode: loadPermissionMode(), workspace });
    if (verdict.decision === "block") {
      onBlocked?.(action, verdict.reason);
      return { approved: false, reason: verdict.reason };
    }
    if (verdict.decision === "approve") return { approved: true };
    // `ask` : pas encore de carte de confirmation sur ce canal → refus sûr.
    return { approved: false, reason: "approval_required" };
  };
}

/**
 * Démarre un run Cline avec la politique d'Origin (mode IDE : un seul agent).
 *
 * @returns le handle de run, ou `null` si le sidecar n'a pas démarré.
 */
export async function startClineHarness(
  options: ClineHarnessOptions,
): Promise<ClineRunHandle | null> {
  const params: ClineStartParams = {
    cwd: options.workspace,
    providerId: options.providerId,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    modelId: options.modelId,
    systemPrompt: options.systemPrompt,
    mode: options.mode ?? "act",
    enableTeams: options.enableTeams === true,
    ...(typeof options.maxIterations === "number" ? { maxIterations: options.maxIterations } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.extraTools && options.extraTools.length > 0 ? { extraTools: options.extraTools } : {}),
  };

  const decider = makeApprovalDecider(options.workspace, options.onBlocked);

  return startClineRun(params, options.onEvent, {
    decideApproval: (action) => decider(action),
    ...(options.onBeforeWrite ? { onBeforeWrite: options.onBeforeWrite } : {}),
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
  });
}
