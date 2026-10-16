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
import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import { buildToolExecutors, type ApprovalTransport } from "./approval";
import { buildTodoTools } from "./todoTool";

// ── Types du protocole (miroir de `src-tauri/src/sidecar.rs`) ────────────────

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
  /** Garde-fou anti-boucle. */
  maxIterations?: number;
}

/** Spécification déclarative d'un outil custom (pas de code exécutable). */
interface ExtraToolSpec {
  kind: "todo";
  /** Id de session UI, pour attribuer les todos côté front. */
  sessionId: string;
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

type IncomingCommand = { id: string | number } & (
  | StartCommand
  | SendCommand
  | SessionRefCommand
  | DisplayMessagesCommand
  | UpdateCommand
  | UpdateModelCommand
  | RestoreCommand
  | SimpleCommand
  | ApprovalResponseCommand
  | WriteResponseCommand
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
  if (error instanceof Error) {
    const code =
      typeof (error as unknown as { code?: unknown }).code === "string"
        ? (error as unknown as { code: string }).code
        : error.name || "SIDECAR_ERROR";
    return { code, message: error.message };
  }
  if (typeof error === "string") {
    return { code: "SIDECAR_ERROR", message: error };
  }
  try {
    return { code: "SIDECAR_ERROR", message: JSON.stringify(error) };
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
function buildExtraTools(specs: ExtraToolSpec[] | undefined) {
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
    }
  }
  return tools;
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

    case "start": {
      const engine = await ensureCore();
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
        config: buildStartConfig(cmd),
        // Identifie la surface qui démarre la session dans les métadonnées.
        source: "origin" as never,
        mode: (cmd.mode ?? "act") as never,
        // Outils CUSTOM de la session (ex. todo list type Trae). Résolus depuis
        // les specs déclaratives du front ; leurs effets remontent par
        // `emit({ kind: "tool_event", ... })`.
        ...(cmd.extraTools && cmd.extraTools.length > 0
          ? { localRuntime: { extraTools: buildExtraTools(cmd.extraTools) } }
          : {}),
      } as never);
      const sessionId = started.sessionId;
      // Le premier message, s'il existe, est envoyé **après** l'acquittement de
      // `start` : on répond d'abord à Rust, puis on lance le tour en tâche de
      // fond (les événements du tour arrivent par le canal `event`).
      if (cmd.prompt && cmd.prompt.trim().length > 0) {
        const firstPrompt = cmd.prompt;
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
        pluginIssues: started.pluginIssues ?? [],
      };
    }

    case "send": {
      const engine = await ensureCore();
      await engine.send({
        sessionId: cmd.sessionId,
        prompt: cmd.prompt,
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
                config: buildStartConfig(cmd.start),
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
  // Outils CUSTOM (voir `./todoTool`) : la todo list ne touche PAS au disque ni
  // au système, c'est un état de raisonnement remonté à l'UI. Les faire passer
  // par l'approbation ajouterait une carte de confirmation à CHAQUE mise à jour
  // de checklist — friction inutile pour un outil sans effet de bord. Sans cette
  // entrée, le joker `"*"` les refuserait (autoApprove: false).
  todo_write: { autoApprove: true },
  todo_read: { autoApprove: true },
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
function buildStartConfig(cmd: StartCommand) {
  const enableTeams = cmd.enableTeams === true;
  return {
    providerId: cmd.providerId ?? "openai-compatible",
    modelId: cmd.modelId,
    apiKey: cmd.apiKey,
    baseUrl: cmd.baseUrl,
    cwd: cmd.cwd,
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
    ...(typeof cmd.maxIterations === "number"
      ? { maxIterations: cmd.maxIterations }
      : {}),
  } as never;
}

/** Arrête proprement le moteur et libère l'abonnement aux événements. */
async function disposeCore(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
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
