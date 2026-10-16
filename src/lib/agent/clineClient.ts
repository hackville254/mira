/**
 * Origin — Client front du sidecar Cline (pilotage + traduction).
 *
 * RÔLE
 * ----
 * Ce module est la **courroie de transmission** entre l'UI et le moteur
 * d'agent Cline qui tourne dans le sidecar Node (lancé par Rust). Il :
 *   1. écoute le canal Tauri `cline://event` (une ligne NDJSON brute par event) ;
 *   2. traduit chaque ligne via `translateClineLine` (voir `clineBridge.ts`) ;
 *   3. route les `AgentEvent` résultants vers un callback fourni par l'appelant.
 *
 * Il expose aussi l'**envoi** des commandes (`start` / `send` / `abort`) en
 * passant par les commandes Tauri `cline_sidecar_*`, qui ajoutent l'`id` de
 * corrélation et encodent la ligne.
 *
 * POURQUOI CE N'EST PAS DANS AiPanel
 * ----------------------------------
 * Tout le cycle de vie du sidecar (démarrer, écouter, traduire, annuler) est
 * sans rapport avec le rendu de la conversation. L'isoler ici permet de le
 * tester sans monter React, et de garder `AiPanel` centré sur l'UI.
 *
 * APPROBATIONS (aux côtés du flux d'agent)
 * ----------------------------------------
 * Le sidecar émet deux familles de lignes : le flux d'agent (`kind:"event"`) et
 * des **demandes bloquantes** (`kind:"tool_approval"`, `kind:"tool_write"`). Ces
 * dernières n'aboutissent qu'à une réponse : si personne ne répond, l'outil est
 * refusé au bout de 120 s (côté sidecar). C'est donc ici, au plus près du canal,
 * qu'on route la décision — via `handlers` fournis par l'appelant :
 *   - `decideApproval(action, request)` → verdict pour `tool_approval` ;
 *   - `onBeforeWrite(path, workspaceRoot)` → snapshot de checkpoint par chemin,
 *     puis acquittement de `tool_write`.
 *
 * SÉCURITÉ
 * --------
 *   - **La clé d'API ne fait que transiter** vers Rust→sidecar : elle n'est ni
 *     journalisée, ni stockée ici, ni ré-émise.
 *   - **Aucune décision d'autorisation par défaut** : sans handlers fournis, les
 *     approbations sont REFUSÉES et les écritures acquittées sans snapshot. On ne
 *     laisse donc jamais une écriture non confirmée s'exécuter en silence.
 *   - **Canal privé** : on ne parle qu'aux commandes Tauri ; aucun port réseau
 *     n'est ouvert ni contacté par ce module.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  translateClineLine,
  translateClineControlLine,
  createClineRunState,
  type ClineRunState,
} from "./clineBridge";
import { toPendingAction } from "./clineApproval";
import type { AgentEvent } from "./run";
import type { PendingAction } from "./tools";
import { log } from "../logger";

/** Nom du canal d'événements émis par Rust (cf. `sidecar.rs::EVENT_CLINE`). */
const EVENT_CLINE = "cline://event";

/** Statut renvoyé par `cline_sidecar_start`/`cline_sidecar_status`. */
export interface ClineSidecarStatus {
  running: boolean;
  pid?: number | null;
  dataDir?: string | null;
  nodeVersion?: string | null;
}

/** Paramètres d'un run Cline (un `start` = une nouvelle session côté SDK). */
export interface ClineStartParams {
  /** Racine du workspace ouvert (chemin absolu). */
  cwd: string;
  /** Fournisseur OpenAI-compatible : identifiant Cline + base URL. */
  providerId: string;
  /**
   * Base URL à surcharger. Omise (`undefined`) → le SDK Cline applique SA base
   * par défaut, ce qui est le comportement voulu pour les providers natifs
   * (Anthropic, Gemini). Ne JAMAIS passer une chaîne vide.
   */
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  /** Prompt système (le SDK applique le sien si vide). */
  systemPrompt?: string;
  /** Mode d'agent : `act` par défaut. */
  mode?: string;
  /** Mode IA : active les équipes d'agents (sous-agents). Défaut false. */
  enableTeams?: boolean;
  /** Garde-fou anti-boucle. */
  maxIterations?: number;
  /**
   * Session SDK EXISTANTE à REPRENDRE au lieu d'en créer une neuve.
   *
   * POURQUOI : pour la continuité conversationnelle (le `send` multi-tours du
   * SDK porte l'historique), on ne doit PAS refaire un `start` à chaque message
   * — cela créerait une session à chaque tour et l'agent perdrait tout le
   * contexte. Si ce champ est fourni, `startClineRun` se contente de rattacher
   * le flux d'événements à la session existante et de rejouer la config du tour
   * (mode, modèle) sans redémarrer la session.
   */
  resumeSessionId?: string;
  /**
   * Outils CUSTOM déclaratifs à injecter (ex. `todo_write`/`todo_read`). On ne
   * transporte qu'un `kind` fermé — jamais de code exécutable (voir le sidecar).
   */
  extraTools?: ClineExtraToolSpec[];
}

/** Spécification déclarative d'un outil custom attendu par le sidecar. */
export interface ClineExtraToolSpec {
  kind: "todo";
  /** Id de session UI, pour attribuer les todos côté front. */
  sessionId: string;
}

/** Effet d'un outil custom, relayé par le sidecar (`kind:"tool_event"`). */
export interface ClineToolEvent {
  tool: string;
  sessionId: string;
  todos?: { id: string; content: string; status: "pending" | "in_progress" | "done" | "cancelled" }[];
}

/** Handle d'un run actif : permet d'envoyer les messages suivants et d'annuler. */
export interface ClineRunHandle {
  /** Session SDK attribuée par le sidecar (résolue après l'acquittement de `start`). */
  sessionId: string;
  /** Envoie un message utilisateur dans la session courante. */
  send(prompt: string, mode?: string): Promise<void>;
  /** Annule le tour en cours (best-effort : l'erreur est journalisée, jamais jetée). */
  abort(): Promise<void>;
  /** Détache l'écouteur d'événements (obligatoire en fin de run). */
  dispose(): void;
}

/**
 * Handler des EFFETS d'outils custom (voir `kind:"tool_event"` émis par le
 * sidecar). Aujourd'hui : la todo list (`todo_write`/`todo_read`). Le front
 * applique l'effet dans son `todoStore` réactif.
 */
export interface ClineToolEventHandlers {
  onToolEvent?(event: ClineToolEvent): void;
}

/** Motif d'un verdict d'approbation, transmis au sidecar (jamais un secret). */
export interface ClineApprovalOutcome {
  approved: boolean;
  reason?: string;
}

/**
 * Handlers des demandes bloquantes du sidecar. **Optionnels** : s'ils sont
 * absents, `clineClient` refuse l'approbation et acquitte l'écriture sans
 * snapshot — jamais l'inverse (on ne devine jamais un « oui »).
 */
export interface ClineApprovalHandlers {
  /**
   * Décide du sort d'un outil. Reçoit la `PendingAction` normalisée (voir
   * `clineApproval.ts`) : l'appelant applique `permissions.ts` et renvoie le
   * verdict. Un rejet (`approved: false`) fait échouer l'outil côté SDK.
   */
  decideApproval(action: PendingAction): ClineApprovalOutcome | Promise<ClineApprovalOutcome>;
  /**
   * Appelé AVANT chaque écriture sur disque, pour capturer l'état d'origine
   * (undo/keep). Reçoit le chemin et la racine du workspace. Idempotent côté
   * appelant (`touchTurnFile` l'est déjà).
   */
  onBeforeWrite?(path: string, workspaceRoot?: string | null): void | Promise<void>;
  /**
   * Reçoit les EFFETS d'outils custom émis par le sidecar (`kind:"tool_event"`).
   * Aujourd'hui : la todo list. Optionnel — sans handler, l'effet est ignoré
   * côté UI (le moteur l'a bien exécuté, seul l'affichage manquerait).
   */
  onToolEvent?(event: ClineToolEvent): void;
}

/**
 * Démarre une session Cline et branche le flux d'événements sur `onEvent`.
 *
 * La session est créée **sans** premier tour (le prompt n'est pas passé à
 * `start`) : c'est `send` qui déclenche la génération et le streaming, ce qui
 * rend l'acquittement de `start` immédiat même si un tour dure des minutes.
 *
 * @param handlers décision d'approbation + hook d'écriture (voir ci-dessus).
 * @returns un handle pour envoyer/annuler — `null` si le sidecar refuse.
 */
export async function startClineRun(
  params: ClineStartParams,
  onEvent: (event: AgentEvent) => void,
  handlers?: ClineApprovalHandlers,
): Promise<ClineRunHandle | null> {
  // L'état du run (TTFT, usage cumulé) est créé AVANT le premier événement :
  // le premier `content_start` posera `firstContentAt`, base du calcul de TTFT.
  const state: ClineRunState = createClineRunState(params.modelId);

  // ── Instrumentation de latence (niveau « round-trips sidecar ») ────────────
  // Ces compteurs sont LOCAUX au run : ils servent au diagnostic terminal
  // (demande explicite) sans polluer le flux d'UI. `EVENT_CLINE` transporte une
  // ligne NDJSON par événement ; on mesure donc : volume reçu, écart maximal
  // entre deux lignes (révèle un stall du modèle), et distribution
  // ligne→traduction. Aucun de ces nombres ne sort de ce module.
  const t0 = performance.now();
  let lineCount = 0;         // lignes brutes reçues (tous kinds confondus)
  let agentLineCount = 0;    // lignes `kind:"event"` (flux d'agent uniquement)
  let controlCount = 0;      // demandes bloquantes (approbation / écriture)
  let lastLineAt = t0;       // horodatage de la dernière ligne (tous kinds)
  let maxGapMs = 0;          // plus grand silence entre deux lignes consécutives
  let firstLineAt = 0;       // horodatage de la 1re ligne reçue du sidecar
  let firstEventAt = 0;      // horodatage du 1er événement d'UI émis
  log.info("agent/clineClient", `start → model=${params.modelId} provider=${params.providerId} teams=${params.enableTeams === true}`);

  // L'écouteur est posé AVANT l'envoi de `start` : aucun événement du premier
  // tour ne doit pouvoir arriver avant qu'on écoute (sinon perte silencieuse).
  let unlisten: UnlistenFn | null = null;
  unlisten = await listen<string>(EVENT_CLINE, (evt) => {
    const now = performance.now();
    lineCount++;
    if (firstLineAt === 0) firstLineAt = now;
    const gap = now - lastLineAt;
    lastLineAt = now;
    if (gap > maxGapMs) maxGapMs = gap;

    // 1) Demandes BLOQUANTES (approbation, écriture) : elles attendent une
    //    réponse — on les traite en priorité et en asynchrone (la réponse part
    //    par un `invoke`, donc hors du callback synchrone de `listen`).
    const control = translateClineControlLine(evt.payload);
    if (control) {
      controlCount++;
      const waited = Math.round(now - t0);
      // La latence « bloquante » = temps écoulé depuis le start jusqu'à la
      // demande ; un écart anormal trahit un goulot côté outil/politique.
      log.debug("agent/clineClient", `← contrôle #${controlCount} kind=${control.kind} @+${waited}ms`);
      void handleControlLine(control, handlers, params.cwd);
      return;
    }
    // 2) EFFETS d'outils custom (`kind:"tool_event"`, ex. todo list) : ils ne
    //    sont pas des `AgentEvent` (pas de rendu de message) mais un état à
    //    appliquer (todoStore). On les route AVANT la traduction d'agent.
    const toolEvent = extractToolEvent(evt.payload);
    if (toolEvent) {
      try {
        handlers?.onToolEvent?.(toolEvent);
      } catch (error) {
        log.warn("agent/clineClient", `tool_event ignoré: ${describeError(error)}`);
      }
      return;
    }
    // 3) Flux d'agent : traduction pure → événements d'UI.
    agentLineCount++;
    const events = translateClineLine(evt.payload, state);
    if (events.length > 0 && firstEventAt === 0) {
      firstEventAt = now;
      log.info(
        "agent/clineClient",
        `1er événement d'UI @+${Math.round(now - t0)}ms (TTFT côté canal) type=${events[0].type}`,
      );
    }
    // Trace par étape : chaque événement traduit est horodaté depuis le start,
    // avec le silence qui l'a précédé. C'est la vue qui permet de repérer OÙ un
    // run ralentit (longs silences = appel modèle ou outil lent), sans avoir à
    // suivre chaque ligne brute. En debug pour ne pas noyer le reste.
    for (const e of events) {
      log.debug(
        "agent/clineClient",
        `evt ${e.type} @+${Math.round(now - t0)}ms (gap ${Math.round(gap)}ms)`,
      );
      onEvent(e);
    }
  });

  const dispose = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    // Bilan de latence du run : émis à la fermeture, il résume ce qui s'est
    // passé sur le canal sans exiger de suivre chaque ligne en direct.
    log.info(
      "agent/clineClient",
      `dispose ← lignes=${lineCount} (agent=${agentLineCount} contrôles=${controlCount}) ` +
      `1re ligne=${firstLineAt ? Math.round(firstLineAt - t0) : -1}ms ` +
      `1er evt=${firstEventAt ? Math.round(firstEventAt - t0) : -1}ms ` +
      `silence max=${Math.round(maxGapMs)}ms`,
    );
  };

  try {
    const tStart = performance.now();
    const status = await invoke<ClineSidecarStatus>("cline_sidecar_start");
    if (!status?.running) {
      dispose();
      log.warn("agent/clineClient", "le sidecar n'a pas démarré");
      return null;
    }
    log.info(
      "agent/clineClient",
      `sidecar prêt @+${Math.round(performance.now() - tStart)}ms pid=${status.pid ?? "-"} node=${status.nodeVersion ?? "-"}`,
    );
  } catch (error) {
    dispose();
    log.error("agent/clineClient", `échec du démarrage du sidecar: ${describeError(error)}`);
    throw error;
  }

  // Aucun `prompt` : la session est créée sans tour (voir `sidecar/src/index.ts`).
  //
  // CONTINUITÉ : si `resumeSessionId` est fourni, on NE recrée PAS de session —
  // on réutilise celle-ci (l'historique conversationnel est dans le SDK, pas
  // côté front). C'est le cœur de la continuité multi-tours.
  let sessionId: string;
  if (params.resumeSessionId) {
    sessionId = params.resumeSessionId;
    // Le modèle peut avoir changé entre deux tours : on resynchronise la session
    // vivante sur le modèle courant (no-op si identique côté SDK).
    try {
      await invoke("cline_sidecar_send", {
        command: { type: "updateModel", sessionId, modelId: params.modelId },
      });
    } catch (error) {
      log.warn("agent/clineClient", `resume: updateModel ignoré: ${describeError(error)}`);
    }
    log.info("agent/clineClient", `reprise de session sessionId=${sessionId}`);
  } else {
    const tHandshake = performance.now();
    const result = await invoke<{ sessionId: string }>("cline_sidecar_send", {
      command: {
        type: "start",
        cwd: params.cwd,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
        modelId: params.modelId,
        providerId: params.providerId,
        systemPrompt: params.systemPrompt ?? "",
        mode: params.mode ?? "act",
        enableTeams: params.enableTeams === true,
        ...(typeof params.maxIterations === "number" ? { maxIterations: params.maxIterations } : {}),
        ...(params.extraTools && params.extraTools.length > 0 ? { extraTools: params.extraTools } : {}),
      },
    });
    const newId = result?.sessionId;
    if (!newId) {
      dispose();
      log.warn("agent/clineClient", "le sidecar n'a pas renvoyé de sessionId");
      return null;
    }
    sessionId = newId;
    // Latence d'établissement de session : c'est le coût fixe payé AVANT tout
    // appel modèle. Un chiffre élevé ici n'est PAS imputable au modèle.
    log.info(
      "agent/clineClient",
      `session établie @+${Math.round(performance.now() - tHandshake)}ms sessionId=${sessionId}`,
    );
  }

  return {
    sessionId,
    async send(prompt: string, mode?: string): Promise<void> {
      const tSend = performance.now();
      await invoke("cline_sidecar_send", {
        command: { type: "send", sessionId, prompt, ...(mode ? { mode } : {}) },
      });
      // Temps d'aller-retour de la commande `send` (Rust↔Node). Il doit rester
      // quasi nul : le streaming arrive par le canal `cline://event`, pas ici.
      log.debug(
        "agent/clineClient",
        `send ${prompt.length} car. ack @+${Math.round(performance.now() - tSend)}ms`,
      );
    },
    async abort(): Promise<void> {
      try {
        await invoke("cline_sidecar_send", {
          command: { type: "abort", sessionId },
        });
      } catch (error) {
        log.warn("agent/clineClient", `abort ignoré: ${describeError(error)}`);
      }
    },
    dispose,
  };
}

/**
 * Traite une demande bloquante du sidecar et envoie la réponse attendue.
 *
 * Toute erreur est journalisée mais JAMAIS jetée : une exception remonterait
 * dans le callback de `listen` (hors promesse) et laisserait le sidecar bloqué
 * jusqu'à son timeout. On garantit donc qu'une réponse part **toujours**.
 */
async function handleControlLine(
  control: ReturnType<typeof translateClineControlLine>,
  handlers: ClineApprovalHandlers | undefined,
  workspaceRoot: string,
): Promise<void> {
  if (!control) return;
  try {
    if (control.kind === "tool_approval") {
      await respondToApproval(control.request, handlers, workspaceRoot);
    } else {
      await handleWriteRequest(control.request.paths, control.request.requestId, handlers, workspaceRoot);
    }
  } catch (error) {
    log.error("agent/clineClient", `échec du traitement d'une demande bloquante: ${describeError(error)}`);
  }
}

/** Répond à une demande d'approbation : normalise, décide, puis acquitte. */
async function respondToApproval(
  request: { requestId: string; toolName: string; input: unknown },
  handlers: ClineApprovalHandlers | undefined,
  workspaceRoot: string,
): Promise<void> {
  let approved: boolean;
  let reason: string | undefined;

  // Normalisation de l'outil Cline en `PendingAction` d'Origin. `null` = lecture
  // pure : rien à confirmer, mais le sidecar attend une réponse → on approuve
  // explicitement (la lecture ne modifie rien sur le disque).
  const action = toPendingAction(request.toolName, request.input);

  if (!action) {
    approved = true;
  } else if (!handlers) {
    // Aucun handler : on refuse. Un outil sensible sans politique connue ne
    // s'exécute jamais en silence (sûr par construction).
    approved = false;
    reason = "no_approval_handler";
  } else {
    void workspaceRoot; // la politique d'Origin porte le workspace qu'elle veut
    const outcome = await handlers.decideApproval(action);
    approved = outcome.approved === true;
    reason = outcome.reason;
  }

  await invoke("cline_sidecar_send", {
    command: { type: "tool_approval_response", requestId: request.requestId, approved, reason },
  });
}

/**
 * Accuse réception d'une écriture imminente : on capture l'état d'origine de
 * chaque chemin (checkpoint undo/keep) puis on répond au sidecar pour qu'il
 * laisse l'outil écrire. L'écriture n'est jamais bloquée par un échec de
 * snapshot : le pire cas est un « Undo all » incomplet, jamais un run figé.
 */
async function handleWriteRequest(
  paths: string[],
  requestId: string,
  handlers: ClineApprovalHandlers | undefined,
  workspaceRoot: string,
): Promise<void> {
  if (handlers?.onBeforeWrite) {
    for (const path of paths) {
      try {
        await handlers.onBeforeWrite(path, workspaceRoot);
      } catch (error) {
        log.warn("agent/clineClient", `snapshot d'écriture ignoré pour ${path}: ${describeError(error)}`);
      }
    }
  }
  await invoke("cline_sidecar_send", {
    command: { type: "tool_write_response", requestId },
  });
}

/** Extrait un message lisible d'une erreur Tauri (string ou Error). */
function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reconnaît une ligne `{ kind: "tool_event", tool, sessionId, ... }` émise par
 * le sidecar (effet d'un outil custom). Renvoie `null` pour toute autre ligne.
 *
 * On valide STRICTEMENT la forme : un `tool_event` malformé est ignoré plutôt
 * que propagé (le front ne doit jamais appliquer un état partiel/incohérent).
 */
function extractToolEvent(raw: unknown): ClineToolEvent | null {
  const obj = typeof raw === "string" ? tryJson(raw) : raw;
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.kind !== "tool_event") return null;
  const tool = typeof o.tool === "string" ? o.tool : "";
  const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
  if (!tool || !sessionId) return null;
  const todos = Array.isArray(o.todos)
    ? o.todos
        .filter(
          (t): t is { id: string; content: string; status: "pending" | "in_progress" | "done" | "cancelled" } =>
            !!t &&
            typeof t === "object" &&
            typeof (t as { id?: unknown }).id === "string" &&
            typeof (t as { content?: unknown }).content === "string" &&
            ((t as { status?: unknown }).status === "pending" ||
              (t as { status?: unknown }).status === "in_progress" ||
              (t as { status?: unknown }).status === "done" ||
              (t as { status?: unknown }).status === "cancelled"),
        )
        .map((t) => ({ id: t.id, content: t.content, status: t.status }))
    : undefined;
  return { tool, sessionId, ...(todos ? { todos } : {}) };
}

/** Parse JSON tolérant (renvoie `null` au lieu de jeter). */
function tryJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
