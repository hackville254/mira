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
import {
  resolvePreviewPanel,
  listPreviewTabs,
  openPreviewTab,
  closePreviewTabById,
  activatePreviewTabById,
} from "../ai/previewTabs";
import { requestPreviewFocus } from "../ai/previewBus";

/** Nom du canal d'événements émis par Rust (cf. `sidecar.rs::EVENT_CLINE`). */
const EVENT_CLINE = "cline://event";

/**
 * Canal UI signalant qu'un agent pilote la prévisualisation (badge « Agent »
 * sur `WebPreviewPane`). Un COMPTEUR module-level évite qu'un run qui se
 * termine éteigne le badge alors qu'un autre run a encore la main : on
 * n'émet `active:true` qu'au passage 0→1 et `active:false` qu'au retour 1→0.
 */
const EVENT_BROWSER_AGENT = "browser-agent-active";
let browserAgentRuns = 0;
function setBrowserAgentActive(active: boolean): void {
  const before = browserAgentRuns;
  browserAgentRuns = Math.max(0, browserAgentRuns + (active ? 1 : -1));
  const nowActive = browserAgentRuns > 0;
  const wasActive = before > 0;
  if (nowActive === wasActive) return;
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(EVENT_BROWSER_AGENT, { active: nowActive }))
    .catch(() => {});
}

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
  extraTools?: ClineExtraToolSpecAny[];
  /**
   * Liste d'autorisation des serveurs MCP pour cette session (dotation d'un
   * agent personnalisé). `undefined` = tous les serveurs configurés sont
   * autorisés (comportement par défaut) ; un tableau VIDE = aucun.
   */
  enabledMcpServers?: string[];
}

/** Spécification déclarative d'un outil custom attendu par le sidecar. */
export interface ClineExtraToolSpec {
  kind: "todo";
  /** Id de session UI, pour attribuer les todos côté front. */
  sessionId: string;
}

/**
 * Spécification d'un outil custom. Aujourd'hui : la todo list (`todo`), le
 * navigateur piloté (`browser`), la recherche dans l'index de codebase
 * (`code_index`), la compréhension du projet (`project`), le contrôle qualité
 * (`quality`) et la demande d'escalade d'équipe (`team_escalate`). On ne
 * transporte qu'un `kind` fermé — jamais de code exécutable (voir le sidecar).
 */
export type ClineExtraToolSpecAny =
  | ClineExtraToolSpec
  | { kind: "browser"; sessionId: string; panelId: string }
  | { kind: "code_index"; sessionId: string }
  | { kind: "project"; sessionId: string }
  | { kind: "quality"; sessionId: string }
  | { kind: "team_escalate"; sessionId: string };

/** Effet d'un outil custom, relayé par le sidecar (`kind:"tool_event"`). */
export interface ClineToolEvent {
  tool: string;
  sessionId: string;
  todos?: { id: string; content: string; status: "pending" | "in_progress" | "done" | "cancelled" }[];
  /** Justification d'une demande d'escalade (`tool: "team_escalate"`). */
  reason?: string;
}

/**
 * Extension NON fatale remontée par le sidecar (`extensionIssues`). Une skill
 * illisible ou un serveur MCP en échec n'empêche PAS le run : on les affiche
 * pour que l'utilisateur sache que sa surface d'extension est incomplète.
 */
export interface ClineExtensionIssue {
  scope: "skills" | "plugins" | "mcp" | "hooks";
  message: string;
}

/** Skill réellement découverte par le sidecar (nom + description). */
export interface ClineSkillInfo {
  name: string;
  description: string;
}

/**
 * Commande runtime exposée par le service d'instructions Cline (`/skill`,
 * `/workflow`). Miroir de `AvailableRuntimeCommand` du SDK : on ne transporte
 * que des champs sérialisables et sûrs — le front les propose dans la palette
 * d'input. `instructions` (le corps de la skill) n'est JAMAIS transporté : le
 * modèle le charge via l'outil `skills`, pas via l'UI.
 */
export interface ClineRuntimeCommand {
  /** Identifiant interne du SDK. */
  id: string;
  /** Nom de la commande sans le `/` initial (ex. `hello`). */
  name: string;
  /** Description courte, si le SDK en fournit une. */
  description?: string;
  /** Nature de l'instruction : `skill` ou `workflow`. */
  kind: "skill" | "workflow";
}

/** Surface d'extension résolue au démarrage d'une session (par le sidecar). */
export interface ClineSessionExtensions {
  /** Skills réellement découvertes et opérationnelles. */
  skills: ClineSkillInfo[];
  /** Slash-commands runtime (`/skill`, `/workflow`) proposables dans l'input. */
  commands: ClineRuntimeCommand[];
  /** Problèmes NON fatals (skills illisibles, plugins/MCP en échec). */
  issues: ClineExtensionIssue[];
}

/** Handle d'un run actif : permet d'envoyer les messages suivants et d'annuler. */
export interface ClineRunHandle {
  /** Session SDK attribuée par le sidecar (résolue après l'acquittement de `start`). */
  sessionId: string;
  /** Envoie un message utilisateur dans la session courante. */
  send(prompt: string, mode?: string): Promise<void>;
  /** Annule le tour en cours (best-effort : l'erreur est journalisée, jamais jetée). */
  abort(): Promise<void>;
  /**
   * Extensions RÉELLEMENT résolues au `start` (skills/commands/plugins/MCP).
   * Présent seulement sur une session NEUVE (un `start`) : sur une reprise, les
   * extensions existent déjà côté SDK et le sidecar ne les re-scanne pas.
   */
  extensions?: ClineSessionExtensions;
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
  let browserTouched = false; // ce run a-t-il déjà sollicité la prévisualisation ?
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
      // Un `tool_invoke` = l'agent pilote activement la prévisualisation : on
      // allume le badge « Agent » (une seule fois par run).
      if (control.kind === "tool_invoke" && !browserTouched) {
        browserTouched = true;
        setBrowserAgentActive(true);
      }
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
    // Badge « Agent » : si ce run pilotait la prévisualisation, on rend la main.
    if (browserTouched) {
      browserTouched = false;
      setBrowserAgentActive(false);
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
  // CONTINUITÉ — REPRISE PAR RE-SEED (et non par réutilisation d'id)
  // ----------------------------------------------------------------
  // Le SDK Cline ne garde ses sessions qu'en MÉMOIRE vive (`core.sessions`) :
  // `send`/`updateSessionModel` font `getSessionOrThrow` et jettent
  // `session_not_found` si la session n'est plus résidente (sidecar redémarré,
  // session évincée). Réutiliser le même `sessionId` échouait donc en silence.
  //
  // Le chemin OFFICIEL du SDK (`StartSessionInput.initialMessages`, documenté
  // « used by resume, fork, and compaction ») est de re-seeder une session neuve
  // avec l'historique persisté. On lit donc l'historique via la commande
  // `messages` (`readMessages`) et on le réinjecte au `start`. La continuité ne
  // dépend plus de la survie du process ; le nouvel id est remonté à l'appelant
  // (qui le repersiste), donc rien à remapper ici.
  let initialMessages: unknown[] | undefined;
  let sessionId: string;
  let extensions: ClineSessionExtensions | undefined;
  if (params.resumeSessionId) {
    try {
      const res = await invoke<{ messages?: unknown[] }>("cline_sidecar_send", {
        command: { type: "messages", sessionId: params.resumeSessionId },
      });
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      if (messages.length > 0) {
        initialMessages = messages;
        log.info("agent/clineClient", `reprise: ${messages.length} message(s) re-seedés`);
      } else {
        // Historique vide/introuvable (session inconnue) : on repart proprement
        // sur une session neuve plutôt que d'échouer.
        log.warn("agent/clineClient", `reprise: aucun message pour ${params.resumeSessionId}, session neuve`);
      }
    } catch (error) {
      log.warn("agent/clineClient", `reprise: lecture de l'historique ignorée: ${describeError(error)}`);
    }
  }

  {
    const tHandshake = performance.now();
    const result = await invoke<{
      sessionId: string;
      skills?: ClineSkillInfo[];
      commands?: ClineRuntimeCommand[];
      extensionIssues?: ClineExtensionIssue[];
    }>("cline_sidecar_send", {
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
        ...(initialMessages ? { initialMessages } : {}),
        ...(typeof params.maxIterations === "number" ? { maxIterations: params.maxIterations } : {}),
        ...(params.extraTools && params.extraTools.length > 0 ? { extraTools: params.extraTools } : {}),
        ...(params.enabledMcpServers ? { enabledMcpServers: params.enabledMcpServers } : {}),
      },
    });
    const newId = result?.sessionId;
    if (!newId) {
      dispose();
      log.warn("agent/clineClient", "le sidecar n'a pas renvoyé de sessionId");
      return null;
    }
    sessionId = newId;
    // Extensions résolues côté sidecar (skills, slash-commands, diagnostics).
    // On les NORMALISE défensivement : une réponse partielle/ancienne ne doit
    // jamais faire tomber l'UI (tableaux vides = surface absente, pas une erreur).
    const resolved = normalizeExtensions(result);
    extensions = resolved;
    if (resolved.skills.length > 0 || resolved.commands.length > 0) {
      log.info(
        "agent/clineClient",
        `extensions: ${resolved.skills.length} skill(s), ${resolved.commands.length} commande(s)` +
        (resolved.issues.length > 0 ? `, ${resolved.issues.length} problème(s)` : ""),
      );
    }
    for (const issue of resolved.issues) {
      log.warn("agent/clineClient", `extension [${issue.scope}] ${issue.message}`);
    }
    // Latence d'établissement de session : c'est le coût fixe payé AVANT tout
    // appel modèle. Un chiffre élevé ici n'est PAS imputable au modèle.
    log.info(
      "agent/clineClient",
      `session établie @+${Math.round(performance.now() - tHandshake)}ms sessionId=${sessionId}` +
      (initialMessages ? ` (reprise de ${params.resumeSessionId})` : ""),
    );
  }

  return {
    sessionId,
    ...(extensions ? { extensions } : {}),
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
 * Nom de l'événement `window` signalant que la surface d'extension (skills,
 * commands) a changé sur disque (création/édition/suppression depuis les
 * Settings). L'UI qui affiche ces extensions (input de l'agent) s'y réabonne
 * pour relancer `listExtensions` sans attendre un nouveau run. Un `CustomEvent`
 * natif suffit : aucun état partagé, aucun couplage entre les modules.
 */
export const EXTENSIONS_CHANGED_EVENT = "mira:extensions-changed";

/** Émet le signal de rafraîchissement des extensions (best-effort). */
export function notifyExtensionsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT));
  } catch {
    /* environnement sans `window` (tests) : sans effet */
  }
}

/**
 * Résout la surface d'extension (skills, slash-commands) SANS démarrer de session.
 *
 * POURQUOI : une session n'est établie qu'au premier `send`. Si on attendait ce
 * moment pour découvrir les skills, l'UI afficherait « aucun skill » tant que
 * l'utilisateur n'a rien envoyé — l'auto-complétion `#`/`/` serait morte au
 * repos. On interroge donc le sidecar à la demande, dès qu'un workspace est
 * connu, en réutilisant le MÊME normaliseur que `start` (source unique de
 * vérité sur la forme). Non fatal : une erreur renvoie une surface vide.
 */
export async function listExtensions(cwd: string): Promise<ClineSessionExtensions> {
  try {
    const result = await invoke<unknown>("cline_sidecar_send", {
      command: { type: "listExtensions", cwd },
    });
    return normalizeExtensions(result);
  } catch (error) {
    // `SIDECAR_NOT_RUNNING` est un état ATTENDU (sidecar pas encore spawné au
    // montage de l'UI, ou aperçu navigateur sans backend Tauri) : le repli
    // « surface vide » est le comportement nominal, pas une anomalie. On le
    // journalise en `debug` pour ne pas polluer la console avec un faux
    // warning ; toute AUTRE erreur reste un `warn` (vraie anomalie).
    const message = describeError(error);
    if (describeErrorCode(error) === "SIDECAR_NOT_RUNNING") {
      log.debug("agent/clineClient", `listExtensions: sidecar indisponible, surface vide (${message})`);
    } else {
      log.warn("agent/clineClient", `listExtensions ignoré: ${message}`);
    }
    return { skills: [], commands: [], issues: [] };
  }
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
    } else if (control.kind === "tool_invoke") {
      await respondToInvoke(control.request);
    } else {
      await handleWriteRequest(control.request.paths, control.request.requestId, handlers, workspaceRoot);
    }
  } catch (error) {
    log.error("agent/clineClient", `échec du traitement d'une demande bloquante: ${describeError(error)}`);
  }
}

/**
 * Allowlist des commandes Tauri que le sidecar peut demander via `tool_invoke`.
 *
 * POURQUOI UNE ALLOWLIST CÔTÉ FRONT (et pas seulement côté sidecar)
 * ---------------------------------------------------------------
 * Le sidecar restreint DÉJÀ ses `browser_*` à une table fermée, mais le front
 * est le dernier maillon avant `invoke` : il doit donc revérifier. Une ligne
 * `tool_invoke` forgée (bug de sérialisation, sidecar compromis) ne doit pas
 * pouvoir déclencher une commande arbitraire (ex. `fs::delete_path`). Tout nom
 * hors liste est refusé et renvoyé au sidecar comme erreur d'outil.
 */
const INVOKE_ALLOWLIST = new Set<string>([
  "browser_navigate",
  "browser_reload",
  "browser_status",
  "browser_read_text",
  "browser_read_dom",
  "browser_query",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_screenshot",
  // Gestion des ONGLETS du navigateur intégré (outils `browser_list_tabs`,
  // `browser_open_tab`, `browser_close_tab`, `browser_activate_tab`). Ce ne sont
  // PAS des commandes Tauri : elles sont traitées localement par
  // `handleTabCommand` (store d'onglets du front), sans toucher aux webviews.
  "tabs_list",
  "tabs_open",
  "tabs_close",
  "tabs_activate",
  // Recherche dans l'index local (outil `codebase_search`). LECTURE seule :
  // renvoie une liste de chemins relatifs issus de l'index du workspace, sans
  // jamais lire le disque ni écrire quoi que ce soit.
  "search_index",
  // Compréhension du projet (outil `project_*` côté sidecar, cf. `projectTools`).
  // TOUTES en LECTURE seule : arborescence, statut git, diff, symboles, imports.
  // Aucune n'écrit sur le disque ni n'exécute de commande arbitraire.
  "get_file_tree",
  "git_status_files",
  "git_diff",
  "search_symbols",
  "get_import_edges",
  // Contrôle qualité (outil `detect_checks` côté sidecar, cf. `qualityTool`).
  // LECTURE seule : le sidecar lit des manifestes FIGÉS via `read_file`, borné
  // au workspace par le Rust (`assert_in_workspace`). Aucune exécution.
  "read_file",
]);

/**
 * Commandes de GESTION DES ONGLETS (table fermée, miroir de `TAB_COMMANDS` du
 * sidecar). Elles ne touchent aucune webview : elles pilotent le store d'onglets
 * du front. Les traiter séparément évite de leur imposer une résolution
 * `panelId`, qui n'a aucun sens pour « lister/ouvrir/fermer » un onglet.
 */
const TAB_COMMANDS = new Set(["tabs_list", "tabs_open", "tabs_close", "tabs_activate"]);

/** Vrai si la commande relève de la gestion des onglets. */
function isTabCommand(command: string): boolean {
  return TAB_COMMANDS.has(command);
}

/** Normalise une URL d'onglet : schéma http(s) imposé (miroir de Rust). */
function normalizeTabUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Exécute une commande de gestion d'onglets et renvoie le TEXTE à présenter au
 * modèle. Chaque issue produit une phrase exploitable (jamais une réussite
 * silencieuse) : l'agent doit pouvoir enchaîner sans deviner.
 *
 * SÉCURITÉ : les `tabId` fournis par le modèle sont résolus contre le store —
 * un identifiant inconnu est refusé, il ne peut donc pas viser « autre chose »
 * que ce que `browser_list_tabs` lui a montré.
 */
function handleTabCommand(command: string, args: Record<string, unknown>): string {
  switch (command) {
    case "tabs_list": {
      const rawMax = args.max;
      const max = typeof rawMax === "number" && rawMax > 0 ? Math.min(rawMax, 50) : 50;
      const tabs = listPreviewTabs();
      if (tabs.length === 0) return "No tab is open in the embedded browser.";
      const shown = tabs.slice(0, max);
      const lines = shown.map(
        (t) => `${t.active ? "*" : " "} ${t.tabId}  ${t.title}  —  ${t.url || "(empty)"}`,
      );
      const header = `${tabs.length} tab(s) open (* = active):`;
      const more = tabs.length > shown.length ? `\n… ${tabs.length - shown.length} more not shown` : "";
      return `${header}\n${lines.join("\n")}${more}`;
    }
    case "tabs_open": {
      const url = normalizeTabUrl(args.url);
      if (!url) return "error: `url` must be an absolute http(s) URL.";
      const id = openPreviewTab(url);
      requestPreviewFocus();
      return `Opened a new tab (tabId: ${id}) at ${url}. It is now the active tab.`;
    }
    case "tabs_close": {
      const tabId = typeof args.tabId === "string" ? args.tabId : "";
      if (!tabId) return "error: `tabId` is required.";
      return closePreviewTabById(tabId)
        ? `Closed tab ${tabId}.`
        : `error: unknown tabId "${tabId}". Call browser_list_tabs first.`;
    }
    case "tabs_activate": {
      const tabId = typeof args.tabId === "string" ? args.tabId : "";
      if (!tabId) return "error: `tabId` is required.";
      if (!activatePreviewTabById(tabId)) {
        return `error: unknown tabId "${tabId}". Call browser_list_tabs first.`;
      }
      requestPreviewFocus();
      return `Activated tab ${tabId}. It is now the target of the browser_* tools.`;
    }
    default:
      return `error: unsupported tab command "${command}".`;
  }
}

/**
 * Exécute une commande navigateur demandée par un outil custom et renvoie son
 * résultat au sidecar. TOUTE issue (succès, refus, exception) produit une
 * réponse `tool_invoke_response` : sans elle, l'outil resterait bloqué jusqu'à
 * son timeout et le modèle verrait un échec opaque.
 *
 * Le résultat de `BrowserResult` est aplati en texte (le modèle lit du texte) ;
 * un `ok:false` devient une ERREUR d'outil, pas une réussite silencieuse.
 */
async function respondToInvoke(request: { requestId: string; command: string; args: Record<string, unknown> }): Promise<void> {
  const reply = (payload: { output?: string; error?: string }) =>
    invoke("cline_sidecar_send", {
      command: { type: "tool_invoke_response", requestId: request.requestId, ...payload },
    });

  if (!INVOKE_ALLOWLIST.has(request.command)) {
    log.warn("agent/clineClient", `tool_invoke refusé (hors allowlist): ${request.command}`);
    await reply({ error: `command not allowed: ${request.command}` });
    return;
  }
  try {
    // `search_index` renvoie directement une liste JSON de hits (`{rel, score}`),
    // que l'outil `codebase_search` consomme telle quelle. On la sérialise en
    // texte sans la transformer : le format navigateur ne s'applique pas.
    if (request.command === "search_index") {
      const hits = await invoke<unknown>("search_index", request.args);
      await reply({ output: JSON.stringify(hits ?? []) });
      return;
    }
    // Outils de COMPRÉHENSION DU PROJET (`project_overview`, `git_status`,
    // `search_symbols`, `find_imports`). Ils consomment des structures JSON
    // (`{…}` / `[…]`) : on sérialise sans transformation, comme `search_index`.
    if (
      request.command === "get_file_tree" ||
      request.command === "git_status_files" ||
      request.command === "search_symbols" ||
      request.command === "get_import_edges"
    ) {
      const result = await invoke<unknown>(request.command, request.args);
      await reply({ output: JSON.stringify(result ?? null) });
      return;
    }
    // `git_diff` renvoie une CHAÎNE de diff (pas de JSON) : on la transmet telle
    // quelle pour ne pas l'altérer (le diff est affiché au modèle verbatim).
    if (request.command === "git_diff") {
      const diff = await invoke<string>("git_diff", request.args);
      await reply({ output: typeof diff === "string" ? diff : "" });
      return;
    }
    // `read_file` est une LECTURE CONFINÉE au workspace (`assert_in_workspace`
    // côté Rust) utilisée par le CONTRÔLE QUALITÉ : l'outil `detect_checks` lit
    // les manifestes (`package.json`, `Cargo.toml`, …) pour en déduire les
    // commandes de vérification. Renvoie une CHAÎNE brute, comme `git_diff`.
    if (request.command === "read_file") {
      const content = await invoke<string>("read_file", request.args);
      await reply({ output: typeof content === "string" ? content : "" });
      return;
    }
    // Gestion des ONGLETS (`browser_list_tabs`, `browser_open_tab`, …).
    // Ces opérations ne touchent AUCUNE webview : elles appartiennent au store
    // d'onglets (`previewTabs`), que seul le front connaît. On les traite ici,
    // hors de la table `browser_*` (qui, elle, cible une page via `panelId`).
    if (isTabCommand(request.command)) {
      await reply({ output: handleTabCommand(request.command, request.args) });
      return;
    }
    // Résolution du panneau cible : l'agent envoie un `panelId` LOGIQUE (voir
    // `PREVIEW_ACTIVE_TARGET`) et ignore l'existence des onglets. On le remappe
    // ici vers le label réel de l'onglet ACTIF. Sans onglet ouvert, la commande
    // échoue proprement (l'agent reçoit une erreur, il n'agit pas dans le vide).
    const args: Record<string, unknown> = { ...request.args };
    if (typeof args.panelId === "string") {
      const resolved = resolvePreviewPanel(args.panelId);
      if (!resolved) {
        await reply({ error: "no browser tab is open; call browser_navigate first" });
        return;
      }
      args.panelId = resolved;
    }
    const result = await invoke<{ ok?: boolean; value?: string; url?: string | null; truncated?: boolean }>(
      request.command,
      args,
    );
    if (result && result.ok === false) {
      await reply({ error: result.value || "browser command failed" });
      return;
    }
    // On concatène l'URL courante (contexte utile) et le signal de troncature,
    // pour que le modèle sache que la sortie n'est pas exhaustive.
    const parts: string[] = [];
    if (result?.value) parts.push(result.value);
    if (result?.url) parts.push(`(url: ${result.url})`);
    if (result?.truncated) parts.push("(output truncated)");
    await reply({ output: parts.join("\n") });
  } catch (error) {
    await reply({ error: describeError(error) });
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
 * Extrait le `code` d'une erreur Tauri si elle en porte un.
 *
 * Rust renvoie ses erreurs applicatives sous forme d'objet `{ code, message }`
 * (cf. `sidecar.rs::sidecar_error`). Selon le chemin IPC, cet objet arrive soit
 * tel quel, soit sérialisé en JSON dans le message. On couvre les deux formes —
 * sans jamais jeter : une erreur sans code exploitable renvoie `null`.
 */
function describeErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { code?: unknown };
      if (parsed && typeof parsed.code === "string") return parsed.code;
    } catch {
      /* message non-JSON : pas de code, on continue */
    }
  }
  return null;
}

/**
 * Normalise la surface d'extension renvoyée par `start` en `ClineSessionExtensions`.
 *
 * POURQUOI VALIDER ICI : la réponse vient du sidecar (processus distinct), donc
 * d'une frontière de confiance. On ne veut jamais qu'un champ malformé casse le
 * rendu de l'UI ni qu'un `instructions` (corps de skill, potentiellement
 * volumineux/sensible) se retrouve propagé. On filtre donc CHAMP PAR CHAMP vers
 * la forme stricte attendue, en ignorant tout le reste.
 */
function normalizeExtensions(result: unknown): ClineSessionExtensions {
  const o = (result ?? {}) as Record<string, unknown>;

  const skills: ClineSkillInfo[] = Array.isArray(o.skills)
    ? o.skills
        .filter(
          (s): s is { name: string; description?: unknown } =>
            !!s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string",
        )
        .map((s) => ({
          name: s.name,
          description: typeof s.description === "string" ? s.description : "",
        }))
    : [];

  const commands: ClineRuntimeCommand[] = Array.isArray(o.commands)
    ? o.commands
        .filter(
          (c): c is { id: string; name: string; kind: "skill" | "workflow"; description?: unknown } =>
            !!c &&
            typeof c === "object" &&
            typeof (c as { name?: unknown }).name === "string" &&
            ((c as { kind?: unknown }).kind === "skill" || (c as { kind?: unknown }).kind === "workflow"),
        )
        .map((c) => ({
          id: typeof c.id === "string" ? c.id : c.name,
          name: c.name,
          kind: c.kind,
          ...(typeof c.description === "string" ? { description: c.description } : {}),
        }))
    : [];

  const issues: ClineExtensionIssue[] = Array.isArray(o.extensionIssues)
    ? o.extensionIssues
        .filter(
          (i): i is { scope: ClineExtensionIssue["scope"]; message: string } =>
            !!i &&
            typeof i === "object" &&
            typeof (i as { message?: unknown }).message === "string" &&
            ((i as { scope?: unknown }).scope === "skills" ||
              (i as { scope?: unknown }).scope === "plugins" ||
              (i as { scope?: unknown }).scope === "mcp" ||
              (i as { scope?: unknown }).scope === "hooks"),
        )
        .map((i) => ({ scope: i.scope, message: i.message }))
    : [];

  return { skills, commands, issues };
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
  // Justification d'escalade : chaîne bornée. On tronque défensivement côté
  // front aussi (le sidecar le fait déjà) — l'UI n'affiche jamais un pavé.
  const reason =
    typeof o.reason === "string" && o.reason.trim().length > 0
      ? o.reason.slice(0, 400)
      : undefined;
  return { tool, sessionId, ...(todos ? { todos } : {}), ...(reason ? { reason } : {}) };
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
