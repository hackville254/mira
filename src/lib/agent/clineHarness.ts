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
  type ClineExtraToolSpecAny,
  type ClineToolEvent,
  type ClineSessionExtensions,
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
  /** Fournisseur : identifiant (modèle personnalisé) + base URL. */
  providerId: string;
  /**
   * `clientType` du SDK : il décide du protocole de transport
   * (`openai-compatible`, `openai`, `anthropic`). Omis = déduit du providerId.
   */
  clientType?: string;
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
  extraTools?: ClineExtraToolSpecAny[];
  /**
   * Liste d'autorisation des serveurs MCP (dotation d'un agent personnalisé).
   * `undefined` = tous les serveurs configurés ; tableau vide = aucun. Les
   * serveurs non autorisés sont masqués côté sidecar par des outils « refus ».
   */
  enabledMcpServers?: string[];
  /**
   * Reçoit les EFFETS d'outils custom (ex. mise à jour de la todo list) pour
   * que le front les applique dans son store réactif. Optionnel.
   */
  onToolEvent?: (event: ClineToolEvent) => void;
  /**
   * Reçoit les EXTENSIONS réellement résolues au démarrage d'une session NEUVE
   * (skills découvertes, slash-commands runtime, diagnostics non fatals). Sur
   * une reprise, le sidecar ne rescanne pas : le callback n'est pas appelé.
   */
  onExtensions?: (extensions: ClineSessionExtensions) => void;
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
 * run).
 *
 * TROIS ISSUES :
 *   - `block` : refus d'office (garde anti-catastrophe) — signalé, jamais exécuté.
 *   - `approve` : exécution immédiate, sans UI.
 *   - `ask` : **le run se met en PAUSE** et une carte de confirmation est émise
 *     dans le fil (`emitAsk`). La décision (Approve / Reject / Always allow)
 *     résout la promesse et débloque l'outil. C'est le canal qui manquait :
 *     auparavant un `ask` était refusé d'office, ce qui faisait échouer les
 *     commandes au lieu de demander l'accord de l'utilisateur.
 *
 * Si `emitAsk` n'est pas fourni (aucun canal UI), on retombe sur le refus sûr :
 * jamais d'exécution non confirmée en silence.
 */
export function makeApprovalDecider(
  workspace: string,
  onBlocked?: (action: PendingAction, reason: string) => void,
  emitAsk?: (action: PendingAction) => Promise<boolean>,
): (action: PendingAction) => HarnessDecision | Promise<HarnessDecision> {
  return (action: PendingAction): HarnessDecision | Promise<HarnessDecision> => {
    const verdict = decideApproval(action, { mode: loadPermissionMode(), workspace });
    if (verdict.decision === "block") {
      onBlocked?.(action, verdict.reason);
      return { approved: false, reason: verdict.reason };
    }
    if (verdict.decision === "approve") return { approved: true };
    // `ask` : on demande l'accord à l'utilisateur si un canal UI est branché.
    if (!emitAsk) return { approved: false, reason: "approval_required" };
    return emitAsk(action).then(
      (approved) => (approved ? { approved: true } : { approved: false, reason: "rejected_by_user" }),
    );
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
    ...(options.clientType ? { clientType: options.clientType } : {}),
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    modelId: options.modelId,
    systemPrompt: options.systemPrompt,
    mode: options.mode ?? "act",
    enableTeams: options.enableTeams === true,
    ...(typeof options.maxIterations === "number" ? { maxIterations: options.maxIterations } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.extraTools && options.extraTools.length > 0 ? { extraTools: options.extraTools } : {}),
    ...(options.enabledMcpServers ? { enabledMcpServers: options.enabledMcpServers } : {}),
  };

  // ── Pont d'approbation (ask → carte UI) ────────────────────────────────────
  // Le canal Cline attend une réponse via `decideApproval` (délai sidecar 120 s).
  // Pour un verdict `ask`, on émet un event `approval-required` DANS LE FIL et on
  // renvoie une promesse résolue par les boutons de la carte (Approve / Reject).
  // Un id local suffit : l'acquittement réel passe par le canal `decideApproval`,
  // pas par cet id (purement UI, pour cibler la bonne carte).
  let approvalSeq = 0;
  const emitAsk = (action: PendingAction): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = `harness-approval-${++approvalSeq}`;
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        // On fige la carte du fil (sinon elle resterait bloquée en
        // « Approval required » après un clic) PUIS on débloque l'outil.
        options.onEvent({ type: "approval-resolved", id, status: approved ? "approved" : "rejected" });
        resolve(approved);
      };
      options.onEvent({
        type: "approval-required",
        id,
        action,
        approve: () => settle(true),
        reject: () => settle(false),
      });
    });

  const decider = makeApprovalDecider(options.workspace, options.onBlocked, emitAsk);

  const handle = await startClineRun(params, options.onEvent, {
    decideApproval: (action) => decider(action),
    ...(options.onBeforeWrite ? { onBeforeWrite: options.onBeforeWrite } : {}),
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
  });

  // Remonte les extensions résolues (session neuve uniquement). On le fait ici
  // — au plus près du handshake — pour que l'UI dispose des skills/commands dès
  // l'acquittement de `start`, sans attendre le premier événement d'agent.
  if (handle?.extensions && options.onExtensions) {
    try {
      options.onExtensions(handle.extensions);
    } catch {
      // Un callback d'UI défaillant ne doit jamais faire échouer le run.
    }
  }

  return handle;
}
