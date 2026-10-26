/**
 * Origin — Sidecar d'agent (Cline SDK).
 *
 * RÔLE
 * ----
 * Ce processus est le **moteur d'agent** d'Origin. Il est lancé par Rust
 * (`src-tauri/src/sidecar.rs`) avec le Node **déjà présent** sur le PC, et parle
 * un protocole **NDJSON** sur `stdin`/`stdout` :
 *
 *   Rust → sidecar  (une ligne JSON par commande, champ `id` pour corréler)
 *     { id, type: "ping" }
 *     { id, type: "start", cwd, prompt?, apiKey, baseUrl, modelId, providerId?,
 *       systemPrompt?, mode?, enableTeams?, yolo?, maxIterations?, extraTools? }
 *     { id, type: "send", sessionId, prompt, mode? }
 *     { id, type: "abort", sessionId }
 *     { id, type: "stop", sessionId }
 *     { id, type: "list" }
 *     { id, type: "get", sessionId }
 *     { id, type: "messages", sessionId }
 *     { id, type: "displayMessages", sessionId }
 *     { id, type: "update", sessionId, title?, metadata?, prompt? }
 *     { id, type: "updateModel", sessionId, modelId }
 *     { id, type: "restore", sessionId, checkpointRunCount, start?, cwd?, restore? }
 *     { id, type: "delete", sessionId }
 *     { id, type: "dispose" }
 *     { id, type: "shutdown" }
 *
 *   sidecar → Rust
 *     { kind: "ready", pid, dataDir, node }          // canal prêt (1 fois)
 *     { kind: "event", event: CoreSessionEvent }     // flux de session
 *     { kind: "tool_event", tool, sessionId, ... }   // effet d'un outil custom
 *     { kind: "tool_invoke", requestId, command, args }  // appel commande Tauri (bloquant)
 *     { id, ok: true,  result }                      // réponse de commande
 *     { id, ok: false, error: { code, message } }    // échec de commande
 *
 * POURQUOI NDJSON SUR STDIO
 * -------------------------
 *   1. **Aucun port réseau ouvert** : rien à découvrir, rien à attaquer depuis
 *      une autre application locale. Le canal est privé au couple Rust↔Node.
 *   2. **Cycle de vie lié au parent** : quand Origin se ferme, le pipe se
 *      ferme, le sidecar s'arrête (`stdin` en `end`). Pas de processus orphelin.
 *   3. **Corrélation explicite** par `id` : les commandes peuvent être
 *      concurrentes sans mélange de réponses.
 *
 * SÉCURITÉ
 * --------
 *   - **Les secrets ne transitent que dans ce sens Rust→sidecar**, jamais
 *     l'inverse : on ne ré-émet jamais `apiKey` dans un événement ou une erreur.
 *   - **`backendMode: "local"`** force l'exécution in-process et le stockage
 *     SQLite local : aucune connexion au hub Cline, aucune donnée n'échappe au
 *     `CLINE_DIR` (que Rust pointe vers le dossier app-data d'Origin).
 *   - **Télémétrie neutralisée** : on ne fournit aucun service de télémétrie,
 *     donc le SDK reste sur son no-op par défaut (rien ne sort).
 *   - **Sortie toujours sérialisable** : un `Error` ou un objet vivant ne doit
 *     jamais atteindre `JSON.stringify` (sinon la ligne est perdue et Rust
 *     attend indéfiniment). Voir `serializeError`.
 */

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { ClineCore } from "@cline/core";
import type { CoreSessionEvent } from "@cline/core";
import type { SkillConfig } from "@cline/core";
import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import { buildToolExecutors, type ApprovalTransport } from "./approval";
import { buildTodoTools } from "./todoTool";
import { buildTeamEscalateTool } from "./teamEscalateTool";
import { buildBrowserTools, type BrowserInvokeRequest } from "./browserTool";
import { buildTabTools, type TabInvokeRequest } from "./tabTool";
import { buildCodeIndexTool } from "./codeIndexTool";
import { buildProjectTools } from "./projectTools";
import { buildQualityTools } from "./qualityTool";
import { resolveSessionExtensions, type SessionExtensions } from "./instructions";
import { buildBlockedTools } from "./blockedTool";
import { neutralizeForClient } from "./brand";

// ── Types du protocole (miroir de `src-tauri/src/sidecar.rs`) ────────────────

/**
 * Plafond par défaut de tokens de SORTIE par appel modèle.
 *
 * POURQUOI CETTE VALEUR
 * ---------------------
 * Doit être : (1) assez large pour qu'un tour d'agent complet passe (raisonnement
 * + un gros appel d'outil) ; (2) assez basse pour que la réservation de crédit
 * d'Orvyx (`prompt + max_tokens`) reste sous un petit budget — le pré-contrôle
 * refuse sinon un plan gratuit à 1 USD. 8192 couvre confortablement une réponse
 * d'agent tout en restant loin du défaut démesuré d'Orvyx qui déclenchait le 402.
 */
const DEFAULT_MAX_TOKENS_PER_TURN = 8192;

interface StartCommand {
  type: "start";
  /** Racine du workspace ouvert dans Origin (chemin absolu). */
  cwd: string;
  /** Premier message utilisateur ; absent = session créée sans tour. */
  prompt?: string;
  /** Clé d'API du provider (jamais loguée, jamais ré-émise). */
  apiKey: string;
  /** Base URL OpenAI-compatible (ex. `https://api.orvyx-ai.com/v1`). */
  baseUrl: string;
  modelId: string;
  /** Identifiant de provider Cline (défaut `openai-compatible`). */
  providerId?: string;
  /**
   * Type de client du SDK : il choisit le PROTOCOLE de transport
   * (`openai-compatible` = Chat Completions, `openai` = module natif qui sert
   * aussi le protocole Responses, `anthropic` = Messages). Pour un endpoint
   * personnalisé, c'est ce champ — et non le libellé de l'UI — qui décide du
   * format d'API. Omis = déduit du `providerId` par le SDK.
   */
  clientType?: string;
  /** Prompt système optionnel ; sinon le SDK applique son prompt par défaut. */
  systemPrompt?: string;
  /** Mode d'agent (`act` | `plan`). Défaut `act`. */
  mode?: string;
  /** Mode IA : active les équipes d'agents (sous-agents). Défaut `false`. */
  enableTeams?: boolean;
  /**
   * Outils CUSTOM injectés dans la session (voir `./todoTool`).
   *
   * POURQUOI PAR `start` ET NON PAR `ClineCore.create`
   * ------------------------------------------------
   * `extraTools` est une option **démarrage de runtime local**
   * (`localRuntime.extraTools`, cf. `runtime-host.d.ts`), donc par session.
   * Le front construit les outils côté Node (ils s'exécutent ICI, dans le
   * moteur) mais leurs EFFETS remontent à l'UI : chaque mise à jour d'outil est
   * ré-émise via `emitUpdate`/`emitEvent` (voir `AgentToolContext` du SDK), que
   * l'on relaie sur le canal `type: "tool_event"`.
   *
   * On ne transporte JAMAIS de code exécutable : chaque descripteur est une
   * spécification DÉCLARATIVE (`kind`), résolue vers une implémentation connue
   * CODÉE EN DUR (`buildExtraTools`). Un front compromis ne peut donc pas faire
   * exécuter du code arbitraire dans le sidecar.
   */
  extraTools?: ExtraToolSpec[];
  /**
   * Historique conversationnel à RÉINJECTER au démarrage (reprise de session).
   *
   * POURQUOI : le SDK ne garde les sessions qu'en MÉMOIRE vive
   * (`core.sessions`). Si le sidecar a redémarré — ou si la session n'est plus
   * résidente — une reprise par `send` échoue (`session_not_found`). Le chemin
   * OFFICIEL de reprise du SDK est de **re-seeder** une session neuve avec
   * `initialMessages` (cf. `StartSessionInput.initialMessages`, doc. SDK :
   * « used by resume, fork, and compaction »). Le front lit donc l'historique
   * persisté (`messages`) et le renvoie ici : la continuité ne dépend plus de la
   * survie du process.
   *
   * Type volontairement `unknown[]` : le sidecar ne fait que TRANSPORTER ce que
   * le SDK a lui-même produit (`readMessages`) — il ne le construit ni ne
   * l'interprète, donc aucun risque de désalignement de schéma.
   */
  initialMessages?: unknown[];
  /**
   * Serveurs MCP AUTORISÉS pour cette session (agent personnalisé). Absent =
   * tous les serveurs configurés. Les outils des serveurs NON listés sont
   * remplacés par des outils « refus » (voir `./blockedTool`) : la dotation de
   * l'agent est ainsi respectée sans modifier le fichier de réglages global.
   */
  enabledMcpServers?: string[];
  /** Garde-fou anti-boucle. */
  maxIterations?: number;
  /**
   * Plafond de tokens de SORTIE par appel modèle (transmis au SDK via
   * `CoreModelConfig.maxTokensPerTurn`, converti en `max_tokens`).
   *
   * POURQUOI CE CHAMP DOIT EXISTER
   * ------------------------------
   * Un modèle custom (routé par `routingProviderId`) n'a pas de `ModelInfo`
   * native : sans plafond explicite, le SDK n'envoie AUCUN `max_tokens`. Orvyx
   * applique alors un défaut énorme dans son pré-contrôle de crédit → HTTP 402
   * même sur un prompt trivial. Absent = on applique la valeur par défaut sûre
   * du sidecar (`DEFAULT_MAX_TOKENS_PER_TURN`).
   */
  maxTokensPerTurn?: number;
}

/** Spécification déclarative d'un outil custom (pas de code exécutable). */
interface ExtraToolSpec {
  kind: "todo" | "browser" | "code_index" | "team_escalate" | "project" | "quality";
  /** Id de session UI, pour attribuer les todos côté front. */
  sessionId: string;
  /**
   * Nom du panel navigateur pilotable (ex. `origin-web-preview`).
   *
   * Requis pour `kind:"browser"` : le sidecar ne peut pas deviner QUEL webview
   * l'UI expose à l'agent (plusieurs panels peuvent coexister). Le front, qui
   * connaît le label réel, le déclare ici.
   */
  panelId?: string;
}

interface SendCommand {
  type: "send";
  sessionId: string;
  prompt: string;
  mode?: string;
}

interface SessionRefCommand {
  type: "abort" | "stop" | "get" | "messages" | "delete";
  sessionId: string;
}

/** Lecture du transcript présentable (projection UI, cf. `readDisplayMessages`). */
interface DisplayMessagesCommand {
  type: "displayMessages";
  sessionId: string;
}

/** Mise à jour des métadonnées de session (titre, metadata, prompt système). */
interface UpdateCommand {
  type: "update";
  sessionId: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  prompt?: string | null;
}

/** Changement de modèle d'une session vivante (continuité). */
interface UpdateModelCommand {
  type: "updateModel";
  sessionId: string;
  modelId: string;
}

/**
 * Restaure/fork une session à un checkpoint donné (undo/keep avancés).
 * Cf. `RestoreInput` de `@cline/core` : `start` permet de fournir la config
 * complète du fork (provider, modèle, cwd) quand on veut repartir proprement.
 */
interface RestoreCommand {
  type: "restore";
  sessionId: string;
  checkpointRunCount: number;
  cwd?: string;
  start?: StartCommand;
  restore?: {
    messages?: boolean;
    workspace?: boolean;
    omitCheckpointMessageFromSession?: boolean;
  };
}

interface SimpleCommand {
  type: "ping" | "list" | "dispose" | "shutdown";
}

/**
 * Liste les extensions (skills/commands) SANS démarrer de session.
 *
 * POURQUOI
 * --------
 * Les extensions ne sont résolues qu'au `start` d'une session. Avant le premier
 * envoi, l'UI (menu `#` / `+`) restait donc vide — « No skills found » — alors
 * que des skills existent sur le disque. Cette commande permet au front de
 * peupler la liste **dès qu'un workspace est connu**, sans attendre un run, et
 * de la rafraîchir après création/édition d'un skill.
 */
interface ListExtensionsCommand {
  type: "listExtensions";
  cwd: string;
}

/**
 * Réponses du front aux demandes bloquantes émises par le sidecar.
 *
 * Le sidecar ne peut pas décider seul si l'agent a le droit d'écrire ou
 * d'exécuter : c'est la politique d'Origin (`permissions.ts`) qui tranche, côté
 * front. Ces commandes portent donc le verdict, corrélé par `requestId`.
 */
interface ApprovalResponseCommand {
  type: "tool_approval_response";
  requestId: string;
  approved: boolean;
  reason?: string;
}

interface WriteResponseCommand {
  type: "tool_write_response";
  requestId: string;
}

/**
 * Réponse du front à un `tool_invoke` (outil navigateur). Porte le RÉSULTAT de
 * la commande Tauri — une chaîne (texte/DOM/statut/data-URL), jamais un objet
 * vivant, pour rester sérialisable sur le canal NDJSON.
 */
interface InvokeResponseCommand {
  type: "tool_invoke_response";
  requestId: string;
  /** Résultat de la commande (déjà sérialisé en texte par Rust). */
  output?: string;
  /** Message d'erreur, si la commande a échoué. */
  error?: string;
}

type IncomingCommand = { id: string | number } & (
  | StartCommand
  | SendCommand
  | SessionRefCommand
  | DisplayMessagesCommand
  | UpdateCommand
  | UpdateModelCommand
  | RestoreCommand
  | SimpleCommand
  | ListExtensionsCommand
  | ApprovalResponseCommand
  | WriteResponseCommand
  | InvokeResponseCommand
);

// ── Écriture NDJSON bornée ───────────────────────────────────────────────────

/**
 * Toute la sortie passe par ici. Un événement non sérialisable ne doit jamais
 * faire tomber le sidecar (il serait alors muet, et Rust attendrait à vie) : on
 * dégrade l'événement en une ligne d'erreur explicite à la place.
 */
function emit(payload: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // `JSON.stringify` a échoué (cycle, BigInt, objet vivant) : on émet un
    // substitut minimal et sûr plutôt que de perdre la corrélation.
    process.stdout.write(
      `${JSON.stringify({ kind: "protocol_error", message: "unserializable_payload" })}\n`,
    );
  }
}

/** Normalise une erreur inconnue en `{ code, message }` toujours sérialisable. */
function serializeError(error: unknown): { code: string; message: string } {
  // TOUT message d'erreur qui remonte au front passe ici : c'est le point unique
  // où l'on neutralise la marque interne (« cline ») — règle produit.
  if (error instanceof Error) {
    const code =
      typeof (error as unknown as { code?: unknown }).code === "string"
        ? (error as unknown as { code: string }).code
        : error.name || "SIDECAR_ERROR";
    return { code, message: neutralizeForClient(error.message) };
  }
  if (typeof error === "string") {
    return { code: "SIDECAR_ERROR", message: neutralizeForClient(error) };
  }
  try {
    return { code: "SIDECAR_ERROR", message: neutralizeForClient(JSON.stringify(error)) };
  } catch {
    return { code: "SIDECAR_ERROR", message: "erreur non sérialisable" };
  }
}

// ── Confinement du stockage ──────────────────────────────────────────────────

/**
 * Le dossier de données Cline est **imposé par Rust** via `CLINE_DIR` (pointé
 * sur le dossier app-data d'Origin). Si la variable manque — lancement manuel
 * pour déboguer — on retombe sur `~/.cline`, le défaut du SDK, pour ne jamais
 * écrire dans un chemin arbitraire déduit d'une entrée.
 */
function resolveDataDir(): string {
  const fromEnv = process.env.CLINE_DIR || process.env.CLINE_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    const dir = fromEnv.trim();
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const fallback = join(homedir(), ".cline");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

// ── État du processus ────────────────────────────────────────────────────────

let core: ClineCore | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Extensions Cline résolues POUR la session courante (skills/rules/workflows,
 * chemins de plugins, outils MCP). Résolues au `start` (elles dépendent du
 * `cwd` du workspace) et conservées ici jusqu'au `dispose` : le gestionnaire MCP
 * doit être fermé explicitement, sinon les serveurs stdio restent attachés.
 *
 * `null` tant qu'aucune session n'a démarré.
 */
let sessionExtensions: SessionExtensions | null = null;

// ── Demandes bloquantes (approbations d'outils, écritures) ────────────────────
//
// Le moteur Cline, au moment d'exécuter un outil sensible, appelle une fonction
// qui doit RÉPONDRE (approbation) ou au moins prendre acte (écriture imminente).
// Comme la décision appartient au front (politique d'Origin), on émet une ligne
// NDJSON sur stdout et on attend la réponse sur stdin.
//
// Deux tables séparées portent les résolveurs, indexées par `requestId` : un
// outil d'écriture peut être en vol pendant qu'une approbation d'un autre outil
// attend — les corrélations ne doivent pas se mélanger.

type PendingResolver<T> = (value: T) => void;

const pendingApprovals = new Map<string, PendingResolver<ToolApprovalResult>>();
const pendingWrites = new Map<string, PendingResolver<void>>();
/**
 * Appels de commandes Tauri demandés par un outil custom (navigateur piloté).
 *
 * POURQUOI UNE TABLE DÉDIÉE
 * -------------------------
 * Les outils `browser_*` s'exécutent ICI (dans le moteur Node) mais leur effet
 * réel — piloter une webview — n'existe que côté Rust. Le sidecar émet donc un
 * `tool_invoke` vers le front, qui appelle la commande Tauri et renvoie le
 * résultat sous forme de chaîne. Un résolveur par `requestId` évite que deux
 * appels concurrents ne mélangent leurs réponses.
 */
const pendingInvokes = new Map<string, PendingResolver<string>>();

let requestSeq = 0;
/** Identifiant unique de demande, préfixé pour rester lisible dans les logs. */
function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

/**
 * Transport utilisé par `approval.ts`. Il écrit la demande sur stdout et
 * renvoie une promesse résolue par la réponse du front (`handle` ci-dessous).
 *
 * Un délai de sécurité évite de bloquer l'agent indéfiniment si le front ne
 * répond jamais (crash, fermeture) : au-delà, on REFUSE l'outil (choix
 * conservateur — on ne laisse jamais une écriture non confirmée s'exécuter).
 */
const APPROVAL_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), APPROVAL_TIMEOUT_MS);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const transport: ApprovalTransport = {
  requestToolApproval(req: ToolApprovalRequest): Promise<ToolApprovalResult> {
    const requestId = nextRequestId("appr");
    const promise = new Promise<ToolApprovalResult>((resolve) => {
      pendingApprovals.set(requestId, resolve);
    });
    emit({
      kind: "tool_approval",
      requestId,
      toolName: req.toolName,
      toolCallId: req.toolCallId,
      input: req.input,
      policy: req.policy,
    });
    // Refus par défaut en cas d'absence de réponse : sûr par construction.
    return withTimeout(promise, { approved: false, reason: "approval_timeout" });
  },

  notifyWrite(paths: string[]): Promise<void> {
    const requestId = nextRequestId("write");
    const promise = new Promise<void>((resolve) => {
      pendingWrites.set(requestId, resolve);
    });
    emit({ kind: "tool_write", requestId, paths });
    // Une écriture imminente ne doit pas bloquer l'agent : on borne l'attente.
    return withTimeout(promise, undefined);
  },
};

/**
 * Pont d'INVOKE pour les outils navigateur (`browserTool.ts`).
 *
 * Émet `{ kind: "tool_invoke", requestId, command, args }` : le front appelle la
 * commande Tauri correspondante (le côté Rust qui, LUI SEUL, touche à la
 * webview) puis renvoie le résultat par `tool_invoke_response`.
 *
 * Le `command` est contraint à `BROWSER_COMMANDS` (table fermée, cf.
 * `browserTool.ts`) : le sidecar ne peut pas faire exécuter une commande Tauri
 * arbitraire. `panelId` est injecté ICI (le modèle ne le connaît pas et ne doit
 * pas pouvoir le choisir).
 *
 * En cas de non-réponse (front fermé), on échoue EXPLICITEMENT : un outil
 * navigateur qui « réussirait » sans rien faire tromperait le modèle.
 */
const INVOKE_TIMEOUT_MS = 30_000;

function browserInvoke(panelId: string): (req: BrowserInvokeRequest) => Promise<string> {
  return (req) => {
    const requestId = nextRequestId("invoke");
    const promise = new Promise<string>((resolve) => {
      pendingInvokes.set(requestId, resolve);
    });
    emit({
      kind: "tool_invoke",
      requestId,
      command: req.command,
      args: { ...req.args, panelId },
    });
    return withTimeout(promise, "__origin_invoke_timeout__").then((value) => {
      if (value === "__origin_invoke_timeout__") {
        // Le résolveur peut encore être en table : on le retire pour ne pas
        // fuiter si une réponse tardive arrivait.
        pendingInvokes.delete(requestId);
        throw Object.assign(new Error("browser command timed out"), {
          code: "BROWSER_TIMEOUT",
        });
      }
      return value;
    });
  };
}

/**
 * Pont d'INVOKE générique pour les outils custom qui interrogent le backend
 * Rust (ex. `codebase_search` → `search_index`).
 *
 * POURQUOI UN PONT SÉPARÉ DE `browserInvoke`
 * ------------------------------------------
 * `browserInvoke` injecte un `panelId` (cible webview) et restreint la commande
 * aux `BROWSER_COMMANDS`. Ici, aucune notion de panel : on relaie simplement
 * `{ command, args }`. Le nom de commande est **figé par l'appelant** (jamais
 * fourni par le modèle) et reste vérifié côté front par `INVOKE_ALLOWLIST` —
 * double barrière : le sidecar ne peut pas viser hors allowlist, et le front
 * refuse toute commande non listée.
 */
function originInvoke(command: string, args: Record<string, unknown>): Promise<string> {
  const requestId = nextRequestId("invoke");
  const promise = new Promise<string>((resolve) => {
    pendingInvokes.set(requestId, resolve);
  });
  emit({ kind: "tool_invoke", requestId, command, args });
  return withTimeout(promise, "__origin_invoke_timeout__").then((value) => {
    if (value === "__origin_invoke_timeout__") {
      pendingInvokes.delete(requestId);
      throw Object.assign(new Error("invoke command timed out"), {
        code: "INVOKE_TIMEOUT",
      });
    }
    return value;
  });
}

// ── Construction du moteur ───────────────────────────────────────────────────

/**
 * Résout les spécifications DÉCLARATIVES d'outils custom (`ExtraToolSpec`) vers
 * leurs implémentations réelles, codées en dur ci-dessous.
 *
 * POURQUOI DÉCLARATIF
 * -------------------
 * Le front ne transporte JAMAIS de code exécutable : il n'envoie qu'un `kind`
 * (chaîne fermée). On le résout ici vers un outil connu. Un front compromis ne
 * peut donc pas faire exécuter du code arbitraire dans le sidecar — il ne peut
 * au pire demander que les outils déjà prévus.
 *
 * Les EFFETS des outils (ex. la todo list) sont ré-émis vers l'UI via
 * `emit({ kind: "tool_event", ... })`, que `clineClient` applique côté front.
 */
function buildExtraTools(specs: ExtraToolSpec[] | undefined, cwd: string) {
  const tools: unknown[] = [];
  for (const spec of specs ?? []) {
    if (spec.kind === "todo") {
      const { tools: todoTools, onEmit } = buildTodoTools(spec.sessionId, (sessionId, todos) => {
        // Ligne dédiée aux effets d'outil : elle ne dépend pas de la forme des
        // `CoreSessionEvent` (union fermée du SDK) et reste donc stable même si
        // le SDK fait évoluer ses événements.
        emit({ kind: "tool_event", tool: "todo", sessionId, todos });
      });
      // On ignore volontairement `onEmit` : `wrappedEmit` (interne à
      // `buildTodoTools`) est déjà branché sur `todo_write` et relaie via
      // `emit` ci-dessus. Le garder référencé évite un avertissement d'inutilité.
      void onEmit;
      tools.push(...todoTools);
    } else if (spec.kind === "browser") {
      // Navigateur piloté : chaque outil relaie sa commande Tauri via
      // `browserInvoke` (émission `tool_invoke` → front → Rust). Sans `panelId`,
      // on n'injecte RIEN : un outil navigateur sans cible est inutilisable, et
      // en injecter un laisserait le modèle appeler un outil qui échoue toujours.
      if (spec.panelId && spec.panelId.trim().length > 0) {
        const { tools: browserTools } = buildBrowserTools(browserInvoke(spec.panelId));
        tools.push(...browserTools);
        // Gestion des ONGLETS (ouvrir/fermer/lister/activer). Ces opérations ne
        // touchent aucune webview : elles appartiennent au FRONT (`previewTabs`).
        // On ne peut donc pas passer par `browserInvoke` (qui injecte un
        // `panelId` de webview) : elles passent par `originInvoke`, et le front
        // résout le `tabId` opaque vers l'onglet réel. Même condition d'activation
        // que `browser_*` : pas de navigateur exposé → pas d'outils d'onglets.
        const { tools: tabTools } = buildTabTools((req: TabInvokeRequest) => originInvoke(req.command, req.args));
        tools.push(...tabTools);
      }
    } else if (spec.kind === "code_index") {
      // Recherche dans l'index local du workspace : l'outil relaie la requête
      // vers la commande Tauri `search_index` via le pont `originInvoke`
      // (`tool_invoke` → front → Rust). Le workspace est FIGÉ ici (cwd de la
      // session) : le modèle ne peut viser un autre dossier.
      tools.push(buildCodeIndexTool(cwd, originInvoke));
    } else if (spec.kind === "project") {
      // Outils de COMPRÉHENSION DU PROJET (arborescence, git status/diff,
      // symboles, imports). Lecture seule, workspace FIGÉ (cwd de la session),
      // noms de commandes Tauri FIGÉS dans `./projectTools` : le modèle ne peut
      // choisir que les paramètres (requête, chemin relatif borné).
      tools.push(...buildProjectTools(cwd, originInvoke));
    } else if (spec.kind === "quality") {
      // Outils de CONTRÔLE QUALITÉ (détection des commandes de vérification du
      // projet : typecheck, tests, lint, build). Lecture seule : l'outil se
      // contente de LIRE des manifestes FIGÉS (package.json, Cargo.toml…) et de
      // renvoyer les commandes à lancer. L'exécution reste portée par
      // `run_commands` (natif SDK) — un seul chemin d'exécution.
      tools.push(...buildQualityTools(cwd, originInvoke));
    } else if (spec.kind === "team_escalate") {
      // Escalade d'équipe « à la demande » : l'outil ne fait que REMONTER une
      // intention au front (`tool_event`). C'est le front qui coupe le run léger
      // et relance avec les équipes — le sidecar ne peut pas re-seeder sa propre
      // session en plein run. Voir `./teamEscalateTool`.
      tools.push(
        ...buildTeamEscalateTool((reason) => {
          emit({ kind: "tool_event", tool: "team_escalate", sessionId: spec.sessionId, reason });
        }).tools,
      );
    }
  }
  return tools;
}

/**
 * Calcule les outils MCP à BLOQUER pour la session à partir de la liste
 * d'autorisation de l'agent.
 *
 * POURQUOI CE CHEMIN
 * ------------------
 * Le SDK enregistre tous les serveurs MCP du fichier de réglages et expose
 * leurs outils. Pour respecter la dotation d'un agent, on ne peut pas filtrer la
 * config du SDK côté front : on MASQUE donc, par un outil « refus » de même nom,
 * chaque outil MCP d'un serveur non autorisé (voir `./blockedTool`). Sans liste
 * d'autorisation (`undefined`), on ne bloque RIEN : le comportement par défaut
 * reste inchangé.
 *
 * Le serveur d'un outil est déduit de son nom `mcp__<server>__<tool>` (préfixe
 * posé par `instructions.ts`), ce qui évite de dépendre de la forme interne du
 * SDK.
 */
function blockedMcpSpecs(
  mcpTools: unknown[],
  enabledServers: string[] | undefined,
): { name: string; server: string }[] {
  // `undefined` = tous autorisés ; un tableau VIDE = aucun serveur autorisé.
  if (!enabledServers) return [];
  const allowed = new Set(enabledServers);
  const specs: { name: string; server: string }[] = [];
  for (const tool of mcpTools) {
    const name = (tool as { name?: unknown })?.name;
    if (typeof name !== "string") continue;
    const server = mcpServerOf(name);
    if (!server || allowed.has(server)) continue;
    specs.push({ name, server });
  }
  return specs;
}

/** Extrait `<server>` d'un nom d'outil `mcp__<server>__<tool>`, ou `null`. */
function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/**
 * Instancie `ClineCore` une seule fois, en mode **local** (in-process +
 * SQLite), avec la télémétrie neutralisée et **sans** exécuteurs d'outils.
 *
 * Sans `toolExecutors`, le SDK applique ses exécuteurs par défaut : lecture de
 * fichiers, recherche, shell, patch — exactement ce qu'un agent de code doit
 * faire. Le pont vers les commandes Rust (permissions, approbations) est un
 * chantier dédié (Lot 4) : le brancher ici prématurément court-circuiterait les
 * garde-fous de l'app.
 */
async function ensureCore(): Promise<ClineCore> {
  if (core) return core;

  core = await ClineCore.create({
    clientName: "origin",
    // `local` = exécution in-process et stockage SQLite local : le hub Cline
    // n'est jamais contacté, aucune donnée de session ne quitte la machine.
    backendMode: "local",
    // Aucun service de télémétrie fourni → le SDK garde son no-op. Rien ne sort.
    //
    // CAPABILITIES : c'est ICI que le contrôle d'Origin se rétablit.
    //   - `requestToolApproval` : le SDK consulte cette fonction avant tout
    //     outil non auto-approuvé ; on relaie au front, qui applique
    //     `permissions.ts` (confinement workspace, refus des commandes
    //     destructrices) et renvoie un verdict.
    //   - `toolExecutors` : on fournit les exécuteurs NATIFS du SDK, enveloppés
    //     pour prévenir le front AVANT chaque écriture (hook `onBeforeWrite`),
    //     afin que les checkpoints undo/keep du tour capturent l'état d'origine.
    //
    // `cwd` est fixé par session (`start`), mais les exécuteurs sont construits
    // au `create` : on utilise ici le cwd du process (dossier app-data), que les
    // outils reçoivent de toute façon par appel (`execCwd`). L'enveloppe
    // n'utilise `cwd` que comme repli si l'appel n'en fournit pas.
    capabilities: {
      requestToolApproval: (req) => transport.requestToolApproval(req),
      toolExecutors: buildToolExecutors(transport, process.cwd()),
    },
  });

  unsubscribe = core.subscribe((event: CoreSessionEvent) => {
    emit({ kind: "event", event });
  });

  return core;
}

// ── Gestion des commandes ────────────────────────────────────────────────────

async function handle(cmd: IncomingCommand): Promise<unknown> {
  switch (cmd.type) {
    case "ping":
      return { pong: true, dataDir: resolveDataDir(), pid: process.pid };

    case "listExtensions": {
      // Résolution À LA DEMANDE (sans session) : skills + slash-commands +
      // commandes custom, dans la MÊME forme que le retour de `start`, pour que
      // le front réutilise son normaliseur. Non fatal : un service vide suffit.
      const extensions = await resolveSessionExtensions(cmd.cwd);
      return {
        skills: extensions.userInstructionService
          .listRecords<SkillConfig>("skill")
          .map((record) => ({ name: record.item.name, description: record.item.description ?? "" })),
        commands: extensions.userInstructionService.listRuntimeCommands().map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          description: c.description,
        })),
        customCommands: extensions.customCommands,
        extensionIssues: extensions.issues.map((issue) => ({
          scope: issue.scope,
          message: neutralizeForClient(issue.message),
        })),
      };
    }

    case "start": {
      const engine = await ensureCore();
      // Résolution des extensions AVANT le démarrage : skills/rules/workflows,
      // chemins de plugins, outils MCP. Déduite du `cwd` de session (jamais du
      // front) et NON fatale — une extension cassée ne bloque pas la session.
      const extensions = await resolveSessionExtensions(cmd.cwd);
      sessionExtensions?.mcpManager?.dispose().catch(() => {
        /* un dispose en échec ne doit pas empêcher le nouveau démarrage */
      });
      sessionExtensions = extensions;
      // Outils MCP : s'ajoutent aux outils custom déclaratifs du front. On les
      // expose au modèle comme n'importe quel outil — donc soumis au joker non
      // auto-approuvé de `TOOL_POLICIES` (chaque appel MCP passe par la
      // politique d'approbation d'Origin).
      const mcpTools = extensions.mcpTools;
      // Dotation MCP de l'agent : si une liste d'autorisation est fournie, on
      // calcule les outils MCP NON autorisés et on injecte autant d'outils
      // « refus » qui MASQUENT leur définition (noms uniques par session).
      const blockedMcpTools = buildBlockedTools(blockedMcpSpecs(extensions.mcpTools, cmd.enabledMcpServers));
      // Outils custom déclaratifs du front (todo, navigateur, index), résolus UNE
      // fois.
      const customTools = buildExtraTools(cmd.extraTools, cmd.cwd);
      // IMPORTANT : on ne passe **jamais** `prompt` à `start()`.
      //
      // POURQUOI
      // --------
      // Le SDK, quand un `prompt` est fourni sans `interactive: true`, exécute
      // le premier tour LLM **à l'intérieur de `start()`** et ne résout qu'à la
      // fin de ce tour (`LocalRuntimeHost.startResolvedSession` →
      // `executeTurn` → `finalizeSingleRun`). Un tour d'agent dure des minutes :
      // Rust, qui attend la réponse NDJSON de `start`, resterait bloqué sans
      // jamais pouvoir afficher le début de génération ni corréler le `id`.
      //
      // En créant la session **sans tour**, `start()` résout immédiatement
      // (aucun appel réseau provider). Le premier message part ensuite via
      // `send`, dont le tour est streamé en événements `core://event`.
      const started = await engine.start({
        config: buildStartConfig(cmd, extensions),
        // Identifie la surface qui démarre la session dans les métadonnées.
        source: "origin" as never,
        mode: (cmd.mode ?? "act") as never,
        // REPRISE : historique persisté réinjecté (voir `StartCommand.initialMessages`).
        // Le SDK reconstruit le store conversationnel avec ces messages AVANT le
        // premier tour : l'agent retrouve tout son contexte même si la session
        // n'était plus résidente. Absent = session neuve (comportement inchangé).
        ...(cmd.initialMessages && cmd.initialMessages.length > 0
          ? { initialMessages: cmd.initialMessages }
          : {}),
        // Outils CUSTOM de la session (todo list type Trae, navigateur piloté),
        // OUTILS MCP et EXTENSIONS (skills + hooks). Le `localRuntime` doit être
        // fourni dès qu'UNE de ces briques existe : les skills ne dépendent pas
        // des outils custom, et les hooks non plus.
        localRuntime: {
          extraTools: [...customTools, ...mcpTools, ...blockedMcpTools],
          // Le service d'instructions fournit l'outil `skills` + l'expansion des
          // slash-commands `/skill`. Sans lui, les skills découvertes ne sont
          // jamais visibles du modèle.
          userInstructionService: extensions.userInstructionService,
          // Hooks `.cline/hooks` (scripts d'événements). Absent = aucun hook
          // configuré : on n'enregistre pas d'extension inerte.
          ...(extensions.hooks ? { hooks: extensions.hooks } : {}),
        },
      } as never);
      const sessionId = started.sessionId;
      // Le premier message, s'il existe, est envoyé **après** l'acquittement de
      // `start` : on répond d'abord à Rust, puis on lance le tour en tâche de
      // fond (les événements du tour arrivent par le canal `event`).
      if (cmd.prompt && cmd.prompt.trim().length > 0) {
        const firstPrompt = expandRuntimeSlashCommand(cmd.prompt);
        const firstMode = cmd.mode;
        void engine
          .send({
            sessionId,
            prompt: firstPrompt,
            mode: firstMode as never,
          })
          .catch((error) => {
            emit({ kind: "event", event: { type: "error", sessionId, error: serializeError(error) } });
          });
      }
      return {
        sessionId,
        manifestPath: started.manifestPath,
        messagesPath: started.messagesPath,
        // Skills RÉELLEMENT découvertes (nom + description), pour que l'UI
        // liste des skills opérationnelles et non une surface décorative.
        skills: extensions.userInstructionService
          .listRecords<SkillConfig>("skill")
          .map((record) => ({ name: record.item.name, description: record.item.description ?? "" })),
        // Slash-commands disponibles (`/skill`, `/workflow`) : le front les
        // propose dans la palette d'input, sans les coder en dur. On ne
        // transporte PAS `instructions` (le corps de la skill) : le modèle le
        // charge via l'outil `skills`, jamais via l'UI.
        commands: extensions.userInstructionService.listRuntimeCommands().map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          description: c.description,
        })),
        // Slash-commands PERSONNALISÉES (`.mira/commands/*.md`) : surface propre à
        // Mira, absente du SDK. On transporte `instructions` (le prompt) — le
        // front les invoque et l'utilisateur doit pouvoir les éditer dans
        // Settings, contrairement aux skills dont le corps reste côté modèle.
        customCommands: extensions.customCommands,
        // Problèmes d'extensions NON fatals (skills illisibles, MCP en échec,
        // plugins invalides). On UNIFIE les diagnostics de plugins du SDK dans
        // cette même liste : le front n'a ainsi qu'une seule forme à afficher.
        // RÈGLE PRODUIT : on NEUTRALISE la marque interne dans TOUT message qui
        // part vers le front (le client ne doit jamais voir « cline »).
        extensionIssues: [
          ...extensions.issues.map((issue) => ({
            scope: issue.scope,
            message: neutralizeForClient(issue.message),
          })),
          ...(started.pluginIssues ?? []).map((issue) => ({
            scope: "plugins" as const,
            message: neutralizeForClient(issue),
          })),
        ],
      };
    }

    case "send": {
      const engine = await ensureCore();
      await engine.send({
        sessionId: cmd.sessionId,
        prompt: expandRuntimeSlashCommand(cmd.prompt),
        mode: cmd.mode as never,
      });
      return { accepted: true };
    }

    case "abort": {
      const engine = await ensureCore();
      await engine.abort(cmd.sessionId, "aborted_by_host");
      return { aborted: true };
    }

    case "stop": {
      const engine = await ensureCore();
      await engine.stop(cmd.sessionId);
      return { stopped: true };
    }

    case "get": {
      const engine = await ensureCore();
      const session = await engine.get(cmd.sessionId);
      return { session: session ?? null };
    }

    case "messages": {
      const engine = await ensureCore();
      const messages = await engine.readMessages(cmd.sessionId);
      return { messages };
    }

    case "displayMessages": {
      const engine = await ensureCore();
      const messages = await engine.readDisplayMessages(cmd.sessionId);
      return { messages };
    }

    case "update": {
      const engine = await ensureCore();
      return engine.update(cmd.sessionId, {
        title: cmd.title ?? null,
        metadata: cmd.metadata ?? null,
        prompt: cmd.prompt ?? null,
      });
    }

    case "updateModel": {
      const engine = await ensureCore();
      await engine.updateSessionModel(cmd.sessionId, cmd.modelId);
      return { updated: true };
    }

    case "restore": {
      const engine = await ensureCore();
      return engine.restore({
        sessionId: cmd.sessionId,
        checkpointRunCount: cmd.checkpointRunCount,
        ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
        ...(cmd.restore ? { restore: cmd.restore } : {}),
        ...(cmd.start
          ? {
              start: {
                config: buildStartConfig(cmd.start, sessionExtensions),
                source: "origin" as never,
                mode: (cmd.start.mode ?? "act") as never,
              },
            }
          : {}),
      });
    }

    case "list": {
      const engine = await ensureCore();
      const sessions = await engine.list(200);
      return { sessions };
    }

    case "delete": {
      const engine = await ensureCore();
      const deleted = await engine.delete(cmd.sessionId);
      return { deleted };
    }

    case "dispose": {
      await disposeCore();
      return { disposed: true };
    }

    case "shutdown": {
      // La réponse part avant la fermeture : l'appelant Rust reçoit son acquittement.
      await disposeCore();
      setTimeout(() => process.exit(0), 50);
      return { shutdown: true };
    }

    case "tool_approval_response": {
      // Verdict du front sur une demande d'approbation. On résout le résolveur
      // en attente (s'il existe encore : une demande peut avoir expiré).
      const resolve = pendingApprovals.get(cmd.requestId);
      if (resolve) {
        pendingApprovals.delete(cmd.requestId);
        resolve({ approved: cmd.approved === true, reason: cmd.reason });
      }
      return { accepted: true };
    }

    case "tool_write_response": {
      // Accusé de réception d'une notification d'écriture : le front a
      // enregistré le chemin dans le checkpoint du tour, l'outil peut écrire.
      const resolve = pendingWrites.get(cmd.requestId);
      if (resolve) {
        pendingWrites.delete(cmd.requestId);
        resolve();
      }
      return { accepted: true };
    }

    case "tool_invoke_response": {
      // Résultat d'une commande navigateur : on débloque l'outil `browser_*` en
      // attente. Une erreur est re-jetée pour que le modèle la voie (elle devient
      // la sortie de l'outil) plutôt que d'être avalée silencieusement.
      const resolve = pendingInvokes.get(cmd.requestId);
      if (resolve) {
        pendingInvokes.delete(cmd.requestId);
        if (cmd.error) {
          throw Object.assign(new Error(cmd.error), { code: "BROWSER_ERROR" });
        }
        resolve(cmd.output ?? "");
      }
      return { accepted: true };
    }

    default: {
      const exhaustive: never = cmd;
      throw Object.assign(new Error(`commande inconnue: ${JSON.stringify(exhaustive)}`), {
        code: "UNKNOWN_COMMAND",
      });
    }
  }
}

/**
 * Politique d'outils appliquée à chaque session.
 *
 * POURQUOI CE N'EST PAS NÉGOCIABLE
 * --------------------------------
 * Le SDK applique par défaut `autoApprove: true` à tout outil non listé : il
 * exécuterait donc les écritures et les commandes **sans jamais consulter**
 * `requestToolApproval` — la politique de permissions d'Origin serait
 * purement ignorée (c'est ce qu'on a observé au banc Lot 4a : `approvals: 0`).
 *
 * On désactive donc explicitement l'auto-approbation sur tout ce qui MODIFIE le
 * système. Les noms sont les **noms canoniques réellement émis par le modèle**
 * (vérifiés dans `@cline/core` → `DefaultToolNames`) :
 *   - `editor` / `apply_patch` : écriture/édition de fichier ;
 *   - `run_commands` : exécution shell ;
 *   - `skills` : exécution d'une skill (effet indirect non maîtrisé).
 *
 * Les outils de LECTURE (`read_files`, `search_codebase`, `fetch_web_content`,
 * `web_search`) restent auto-approuvés : ils ne modifient rien, et les
 * confirmer ne ferait qu'ajouter de la friction (cf. `permissions.ts`, où la
 * lecture est « sûre »). Un outil NON listé et inconnu retombe sur le joker
 * `"*"` → NON auto-approuvé : on ne laisse jamais un outil non catalogué
 * s'exécuter en silence.
 */
const SENSITIVE_TOOL_POLICY = { autoApprove: false } as const;

/**
 * Noms canoniques des outils d'équipe du SDK Cline (identiques à
 * `TEAM_TOOL_NAMES` de `@cline/core`, vérifiés dans son bundle dist). Ils ne
 * sont exposés au modèle qu'en mode IA (`enableAgentTeams: true`).
 */
const TEAM_TOOL_NAMES: readonly string[] = [
  "team_spawn_teammate",
  "team_shutdown_teammate",
  "team_status",
  "team_task",
  "team_run_task",
  "team_cancel_run",
  "team_list_runs",
  "team_await_runs",
  "team_send_message",
  "team_broadcast",
  "team_read_mailbox",
  "team_mission_log",
  "team_cleanup",
  "team_create_outcome",
  "team_attach_outcome_fragment",
  "team_review_outcome_fragment",
  "team_finalize_outcome",
  "team_list_outcomes",
];

const TOOL_POLICIES: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {
  // Joker : tout outil non listé ci-dessous (y compris un futur outil du SDK)
  // doit passer par l'approbation. C'est le choix conservateur.
  "*": SENSITIVE_TOOL_POLICY,
  editor: SENSITIVE_TOOL_POLICY,
  apply_patch: SENSITIVE_TOOL_POLICY,
  run_commands: SENSITIVE_TOOL_POLICY,
  skills: SENSITIVE_TOOL_POLICY,
  // Lectures explicitement auto-approuvées (elles ne modifient rien).
  read_files: { autoApprove: true },
  search_codebase: { autoApprove: true },
  fetch_web_content: { autoApprove: true },
  web_search: { autoApprove: true },
  // `ask_question` POSE une question à l'utilisateur : c'est une lecture (elle
  // ne modifie rien). Sans cette entrée, le joker `"*"` la ferait passer par
  // l'approbation → une carte de confirmation POUR DEMANDER, absurde. On
  // l'auto-approuve explicitement. Note : `submit_and_exit` n'existe PAS dans
  // les noms d'outils du SDK (vérifié dans `DefaultToolNames`) — rien à ajouter.
  ask_question: { autoApprove: true },
  // Outils CUSTOM (voir `./todoTool`) : la todo list ne touche PAS au disque ni
  // au système, c'est un état de raisonnement remonté à l'UI. Les faire passer
  // par l'approbation ajouterait une carte de confirmation à CHAQUE mise à jour
  // de checklist — friction inutile pour un outil sans effet de bord. Sans cette
  // entrée, le joker `"*"` les refuserait (autoApprove: false).
  todo_write: { autoApprove: true },
  todo_read: { autoApprove: true },
  // Outil CUSTOM `codebase_search` (voir `./codeIndexTool`) : recherche dans
  // l'index local, LECTURE seule, aucun effet de bord. Auto-approuvé comme les
  // autres lectures — sinon une carte de confirmation à chaque recherche.
  codebase_search: { autoApprove: true },
  // Outils CUSTOM de COMPRÉHENSION DU PROJET (voir `./projectTools`) :
  // arborescence, statut git, diff, symboles, imports. TOUS en LECTURE seule,
  // aucun effet de bord → auto-approuvés, sinon une carte de confirmation à
  // chaque coup d'œil rendrait la reconnaissance de projet impraticable.
  project_overview: { autoApprove: true },
  git_status: { autoApprove: true },
  git_diff: { autoApprove: true },
  search_symbols: { autoApprove: true },
  find_imports: { autoApprove: true },
  // Outil CUSTOM de CONTRÔLE QUALITÉ (voir `./qualityTool`) : `detect_checks`
  // ne fait que LIRE des manifestes FIGÉS du workspace et renvoyer les commandes
  // de vérification détectées. Aucun effet de bord, aucune exécution → auto-
  // approuvé (une carte de confirmation pour « quel est ta commande de test »
  // serait absurde). L'exécution, elle, reste portée par `run_commands`, qui
  // N'EST PAS auto-approuvé : l'utilisateur garde le contrôle des commandes.
  detect_checks: { autoApprove: true },
  // Outil CUSTOM `escalate_to_team` (voir `./teamEscalateTool`) : simple demande
  // d'escalade, AUCUN effet de bord. Auto-approuvé, sinon une carte de
  // confirmation apparaîtrait au moment précis où le modèle veut gagner en
  // capacité — contre-productif.
  escalate_to_team: { autoApprove: true },
  // Outils NAVIGATEUR (voir `./browserTool`). On distingue LECTURE et ACTION :
  //   - `browser_status`/`browser_read_text`/`browser_read_dom`/`browser_query`
  //     et `browser_screenshot` n'ont aucun effet de bord : auto-approuvés, comme
  //     les autres lectures (sinon une carte de confirmation à chaque coup d'œil).
  //   - `browser_navigate`/`browser_click`/`browser_type`/`browser_press_key`
  //     MODIFIENT l'état de la page (et peuvent déclencher des effets externes) :
  //     NON auto-approuvés → le front applique la politique (navigation
  //     hors-loopback = confirmation explicite de l'utilisateur).
  browser_status: { autoApprove: true },
  browser_read_text: { autoApprove: true },
  browser_read_dom: { autoApprove: true },
  browser_query: { autoApprove: true },
  browser_screenshot: { autoApprove: true },
  browser_navigate: SENSITIVE_TOOL_POLICY,
  browser_click: SENSITIVE_TOOL_POLICY,
  browser_type: SENSITIVE_TOOL_POLICY,
  browser_press_key: SENSITIVE_TOOL_POLICY,
  // Outils d'ORCHESTRATION d'équipe (mode IA). Ce sont des outils de contrôle
  // (créer/lister/piloter des coéquipiers et des tâches), PAS des écritures :
  // les faire passer par l'approbation ajouterait de la friction à chaque
  // spawn sans gain de sécurité. Les ÉCRITURES des coéquipiers, elles, passent
  // toujours par `editor`/`apply_patch`/`run_commands` (non auto-approuvés ci-
  // dessus) : le confinement et le verdict du front restent intacts.
  ...Object.fromEntries(TEAM_TOOL_NAMES.map((name) => [name, { autoApprove: true }])),
};

/**
 * Traduit une commande `start` en configuration de session Cline.
 *
 * Le provider est **openai-compatible** : Origin parle déjà ce protocole
 * (même `baseUrl`/`apiKey`/`modelId` que le harness actuel), donc aucune
 * adaptation de transport n'est nécessaire.
 */
function buildStartConfig(cmd: StartCommand, extensions?: SessionExtensions | null) {
  const enableTeams = cmd.enableTeams === true;
  return {
    providerId: cmd.providerId ?? "openai-compatible",
    // Le protocole de transport est décidé par `clientType` — MAIS ce champ
    // n'appartient PAS à `CoreModelConfig` (donc il serait ignoré s'il était
    // posé au top-level). Il vit dans `ProviderConfig`, uniquement atteignable
    // via `providerConfig`. Voir le bloc `providerConfig` plus bas.
    // Bonus : pour un id de provider CUSTOM (ex. `orvyx`) non built-in, le SDK
    // exige `routingProviderId` pour réutiliser le comportement d'un provider
    // natif (sinon aucun handler n'est résolu → génération impossible).
    modelId: cmd.modelId,
    apiKey: cmd.apiKey,
    baseUrl: cmd.baseUrl,
    cwd: cmd.cwd,
    // ── PLAFOND DE SORTIE PAR APPEL ────────────────────────────────────────
    //
    // POURQUOI CE CHAMP EST OBLIGATOIRE POUR NOUS
    // -------------------------------------------
    // Orvyx (notre passerelle) applique un **pré-contrôle de crédit** : il
    // réserve `prompt_tokens + max_tokens` AVANT d'appeler le modèle, et refuse
    // en HTTP 402 (`insufficient_credits`) si la réservation dépasse le solde.
    //
    // Or, un modèle custom routé via `routingProviderId` n'a **aucune
    // `ModelInfo.maxTokens` connue** : le SDK n'envoie donc **aucun `max_tokens`**
    // dans la requête, et Orvyx retombe sur un défaut énorme → réservation
    // supérieure au moindre solde → 402 SYSTÉMATIQUE, même avec un prompt court.
    // (Vérifié empiriquement : corps de requête sans `max_tokens` → 402 ; avec
    // un `max_tokens` borné → 200.)
    //
    // `maxTokensPerTurn` est le levier OFFICIEL de `CoreModelConfig` (« Maximum
    // output tokens per API call ») : le SDK le convertit en `max_tokens`. On
    // borne donc la sortie par tour à une valeur saine — assez large pour une
    // réponse d'agent complète, assez basse pour que la réservation reste sous
    // le budget d'un plan (le plan gratuit à 1 USD reste inchangé).
    maxTokensPerTurn: cmd.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN,
    // `systemPrompt` est **requis** par le SDK. Si Origin n'en fournit pas
    // (mode par défaut), on passe une chaîne vide : le SDK applique alors son
    // prompt système natif plutôt que de rejeter la configuration.
    systemPrompt: cmd.systemPrompt ?? "",
    // Les sous-agents sont un choix explicite : en mode IDE on les coupe pour
    // économiser les tokens (un seul agent travaille).
    enableTools: true,
    // ORCHESTRATION EN MODE IA — UN SEUL CHEMIN, VOLONTAIREMENT.
    //
    // Le SDK expose DEUX mécanismes de sous-agents, aux propriétés opposées :
    //
    //   1. `spawn_agent` (activé par `enableSpawnAgent`) crée un sous-agent
    //      DÉTACHÉ : il est exécuté, mais AUCUN événement d'équipe n'est émis.
    //      Ses événements arrivent sans `teamAgentId`, sans `team_progress` :
    //      le sous-agent est donc **invisible** pour l'UI (observé au banc
    //      Lot 6 : `spawn_agent` appelé 2×, ZÉRO `team_progress`).
    //
    //   2. Les outils `team_*` (activés par `enableAgentTeams`) créent des
    //      coéquipiers RATTACHÉS à un `AgentTeamsRuntime` nommé : chaque action
    //      émet un `TeamEvent` → le SDK publie `team_progress` et renseigne
    //      `teamAgentId`/`teamRole:"teammate"` sur les événements du coéquipier.
    //      C'est le SEUL chemin qui alimente le suivi des sous-agents dans l'UI.
    //
    // On coupe donc `enableSpawnAgent` dès que les équipes sont actives : sans
    // cela le modèle dispose des deux et privilégie `spawn_agent` (plus simple
    // à appeler), ce qui rend le travail des sous-agents invisible. Un seul
    // mécanisme = un comportement déterministe et observable.
    enableSpawnAgent: !enableTeams,
    enableAgentTeams: enableTeams,
    // Politique d'outils : c'est CE QUI rend le pont d'approbation effectif
    // (sans elle, `requestToolApproval` n'est jamais appelé — voir le commentaire
    // de `TOOL_POLICIES`).
    toolPolicies: TOOL_POLICIES,
    // ── EXTENSIONS DE SESSION (skills, plugins) ────────────────────────────
    //
    // POURQUOI ICI
    // ------------
    // Les dossiers de plugins sont DÉDUITS du workspace par le SDK (jamais
    // fournis par le front) : on injecte donc leurs chemins dans la config, et
    // `start()` renvoie ses diagnostics dans `pluginIssues` (exposés plus bas).
    // Les SKILLS, eux, passent par `localRuntime.userInstructionService` (voir
    // `handle("start")`) : leur allowlist est ici pour ne publier au modèle que
    // les skills réellement découvertes (aucune annonce fantôme).
    ...(extensions && extensions.pluginPaths.length > 0
      ? { pluginPaths: extensions.pluginPaths }
      : {}),
    ...(typeof cmd.maxIterations === "number"
      ? { maxIterations: cmd.maxIterations }
      : {}),
    // ── ROUTAGE DU PROVIDER ────────────────────────────────────────────────
    //
    // POURQUOI `providerConfig` ET PAS LE TOP-LEVEL
    // ---------------------------------------------
    // `clientType` (« quel handler de transport utiliser ») n'appartient PAS à
    // `CoreModelConfig` : c'est un champ de `ProviderConfig`. Posé au
    // top-level de la config de session, il est donc **silencieusement
    // ignoré** par le SDK. On le place ici, dans le sous-objet `providerConfig`
    // que le SDK lit réellement.
    //
    // POURQUOI `routingProviderId`
    // ----------------------------
    // Les modèles Mira exposent un id de provider PROPRE (`orvyx`), absent du
    // catalogue natif du SDK. Sans indication, le SDK ne résout AUCUN handler
    // pour cet id → l'appel LLM n'est jamais émis. `routingProviderId` est
    // prévu EXACTEMENT pour ce cas : il permet d'exposer un id/catalogue
    // custom tout en réutilisant l'implémentation d'un provider natif. On
    // route donc vers `openai-compatible` (protocole REST OpenAI), qui est ce
    // que sert l'API Orvyx (`/v1/chat/completions`).
    ...(cmd.clientType || cmd.providerId
      ? {
          providerConfig: {
            providerId: cmd.providerId ?? "openai-compatible",
            clientType: cmd.clientType ?? "openai-compatible",
            routingProviderId: cmd.clientType ?? "openai-compatible",
            apiKey: cmd.apiKey,
            modelId: cmd.modelId,
            ...(cmd.baseUrl ? { baseUrl: cmd.baseUrl } : {}),
          },
        }
      : {}),
  } as never;
}

/**
 * Étend une slash-command `/skill args` vers sa charge utile avant envoi.
 *
 * POURQUOI `expandSkillCommands: false`
 * -------------------------------------
 * La session enregistre l'outil `skills` (via `userInstructionService`) : le
 * SDK recommande alors de LAISSER la commande TELLE QUE TAPÉE et de laisser le
 * modèle charger les instructions via l'outil. Le transcript persisté garde
 * donc `/skill args` (lisible) au lieu du corps complet de la skill (verbeux).
 * Les workflows, eux, n'ont pas d'outil dédié : ils s'étendent toujours.
 *
 * Les RULES ne sont pas des commandes : elles sont injectées par le SDK.
 */
function expandRuntimeSlashCommand(prompt: string): string {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/")) return prompt;
  // 1. Nos commands utilisateur (`.mira/commands`) : le SDK ne les connaît pas,
  //    on les développe donc nous-mêmes AVANT de lui céder la main.
  const custom = expandCustomSlashCommand(trimmed);
  if (custom !== null) return custom;
  const service = sessionExtensions?.userInstructionService;
  if (!service) return prompt;
  try {
    return service.resolveRuntimeSlashCommand(prompt, { expandSkillCommands: false });
  } catch {
    // Une commande inconnue reste inchangée : le modèle la recevra littéralement.
    return prompt;
  }
}

/**
 * Développe `/nom [args]` vers le prompt de la commande utilisateur.
 *
 * Renvoie `null` si le nom ne correspond à aucune commande de `.mira/commands` :
 * l'appelant laisse alors le SDK traiter la commande (skills/workflows). Les
 * arguments éventuels sont concaténés APRÈS le corps, séparés par une ligne
 * vide, pour que le modèle distingue l'instruction du paramétrage.
 */
function expandCustomSlashCommand(prompt: string): string | null {
  const commands = sessionExtensions?.customCommands;
  if (!commands || commands.length === 0) return null;
  const match = /^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return null;
  const command = commands.find((c) => c.name === match[1]);
  if (!command) return null;
  const args = (match[2] ?? "").trim();
  return args.length > 0 ? `${command.instructions}\n\n${args}` : command.instructions;
}

/** Arrête proprement le moteur et libère l'abonnement aux événements. */
async function disposeCore(): Promise<void> {
  unsubscribe?.();
  // Les serveurs MCP (transport stdio surtout) sont des PROCESSUS enfants : sans
  // `dispose`, ils resteraient attachés après l'arrêt du sidecar. On les ferme
  // AVANT le moteur, et une erreur ici ne doit jamais empêcher l'arrêt.
  try {
    await sessionExtensions?.mcpManager?.dispose();
  } catch {
    /* idem : un dispose en échec n'empêche pas l'arrêt */
  }
  sessionExtensions?.userInstructionService.stop();
  sessionExtensions = null;
  if (core) {
    try {
      await core.dispose("sidecar_shutdown");
    } catch {
      /* un dispose en échec ne doit pas empêcher l'arrêt du process */
    }
    core = null;
  }
}

// ── Boucle principale ────────────────────────────────────────────────────────

/**
 * Commandes de **contrôle** : elles doivent être traitées immédiatement, sans
 * attendre derrière une opération longue.
 *
 * POURQUOI C'EST CRITIQUE
 * -----------------------
 * `start` (avec prompt) et `send` lancent un tour d'agent qui peut durer
 * plusieurs minutes. Si on les mettait dans la même file séquentielle que tout
 * le reste, un `abort`/`shutdown` arrivé pendant ce tour attendrait la fin du
 * tour pour être traité → **l'utilisateur ne pourrait plus arrêter l'agent**.
 * On sort donc ces commandes de la file pour qu'elles court-circuitent.
 */
const CONTROL_COMMANDS = new Set([
  "abort",
  "stop",
  "shutdown",
  "ping",
  "status",
  // Les RÉPONSES aux demandes bloquantes doivent court-circuiter : elles
  // débloquent justement le tour qui est en cours dans la file. Les sérialiser
  // derrière ce tour provoquerait un **interblocage** (le tour attend la
  // réponse qui attend le tour).
  "tool_approval_response",
  "tool_write_response",
  "tool_invoke_response",
]);

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  // Prévient Rust (et les logs) que le canal est prêt — utile pour mesurer le
  // temps de démarrage réel du moteur.
  emit({ kind: "ready", pid: process.pid, dataDir, node: process.version });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // File séquentielle : l'ordre d'arrivée est significatif pour les commandes
  // de travail (`start` avant `send`). Les commandes de contrôle, elles,
  // court-circuitent cette file (voir `CONTROL_COMMANDS`).
  let queue: Promise<void> = Promise.resolve();

  /** Exécute une commande déjà parsée et émet sa réponse. */
  const runCommand = async (cmd: IncomingCommand): Promise<void> => {
    // L'`id` vient de Rust (`sidecar.rs`) sous forme **numérique** (u64) ; on
    // accepte string ou number et on le renvoie **tel quel** pour que la
    // corrélation côté Rust soit exacte (sinon les réponses seraient sur `null`).
    const rawId = (cmd as { id?: unknown }).id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    try {
      const result = await handle(cmd);
      emit({ id, ok: true, result });
    } catch (error) {
      emit({ id, ok: false, error: serializeError(error) });
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let cmd: IncomingCommand;
    try {
      cmd = JSON.parse(trimmed) as IncomingCommand;
    } catch (error) {
      emit({ id: null, ok: false, error: serializeError(error) });
      return;
    }

    if (CONTROL_COMMANDS.has((cmd as { type?: string }).type ?? "")) {
      // Court-circuit : traitée tout de suite, même si un tour est en cours.
      void runCommand(cmd);
      return;
    }

    // Commande de travail : sérialisée pour préserver l'ordre (start → send).
    queue = queue.then(() => runCommand(cmd));
  });

  // `stdin` se ferme = le parent (Origin) s'est arrêté : on nettoie et on sort.
  //
  // POURQUOI ON ATTEND LA FILE
  // --------------------------
  // En NDJSON-pipe, `close` peut tirer alors que des commandes de travail sont
  // encore dans la file ou en cours d'exécution. Sortir immédiatement les
  // tronquerait (réponse jamais émise, session à moitié créée). On draine donc
  // la file — puis on nettoie — avant de rendre la main. Aucune commande n'est
  // perdue, et l'arrêt reste borné par la durée de l'opération en cours.
  rl.on("close", () => {
    void queue
      .catch(() => {
        /* une commande en échec ne doit pas empêcher l'arrêt */
      })
      .finally(() => disposeCore())
      .finally(() => process.exit(0));
  });
}

main().catch((error) => {
  emit({ id: null, ok: false, error: serializeError(error) });
  process.exit(1);
});
