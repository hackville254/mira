/**
 * Origin — Pont de traduction des événements Cline SDK → événements d'UI.
 *
 * RÔLE
 * ----
 * Le moteur d'agent (Cline SDK `@cline/core`) tourne dans un **sidecar Node**
 * lancé par Rust (`src-tauri/src/sidecar.rs`). Toute la sortie du sidecar est
 * relayée **brute** au webview sur `cline://event` : Rust ne ré-encode rien.
 * C'est donc ICI, côté front, que l'on traduit la représentation du SDK vers le
 * type `AgentEvent` que l'UI sait déjà afficher (`src/lib/agent/run.ts`).
 *
 * POURQUOI UN PONT DANS LE FRONT (et non en Rust)
 * -----------------------------------------------
 *   1. **Une seule source de vérité UI** : l'UI consomme un type stable
 *      (`AgentEvent`), quel que soit le harness sous-jacent. Le jour où le SDK
 *      change un nom de champ, on corrige UN fichier typé, pas du Rust.
 *   2. **Zéro re-encodage Rust** : le sidecar sérialise déjà du JSON ; le faire
 *      transiter par des `serde` intermédiaires serait du travail perdu et une
 *      source de bugs de casse (camelCase ↔ snake_case).
 *   3. **Traçabilité** : chaque événement non reconnu est journalisé (jamais
 *      avalé en silence) — on sait immédiatement si le SDK évolue.
 *
 * SÉCURITÉ
 * --------
 * Ce module ne fait que LIRE et NORMALISER : il ne détient aucun secret, ne
 * fait aucun appel réseau, et **ne prend aucune décision d'autorisation**
 * (le verdict reste dans `permissions.ts`). Les demandes d'approbation sont
 * émises par le sidecar sur un **canal de contrôle dédié** (hors flux
 * d'agent) : ce module se contente de les typer (`ClineApprovalRequest`,
 * `ClineWriteRequest`) pour que `clineClient` sache à qui répondre.
 */

import type { AgentEvent } from "./run";
import type { UsageData } from "../ai";
import { log } from "../logger";

// ── Outils qui MODIFIENT le disque ───────────────────────────────────────────
//
// SOURCE UNIQUE DE VÉRITÉ. Avant, la détection d'écriture était dupliquée et
// codée en dur sur `write_file|edit|multi_edit` (noms du harness historique).
// Or le SDK Cline émet des noms CANONIQUES différents — `editor` et
// `apply_patch` (cf. `cline-sidecar/src/approval.ts` et la politique
// `TOOL_POLICIES` de `index.ts`). Résultat : côté front, la bannière Undo/Keep
// ne se déclenchait pas de façon fiable (« N files changed » n'apparaissait
// pas), alors même que le checkpoint disque, lui, était bien alimenté par le
// canal `tool_write` du sidecar.
//
// On centralise donc la liste ICI, et on garde les anciens noms par prudence
// (certains chemins Plan/heuristiques les produisent encore). Toute détection
// d'écriture du front doit passer par `isWriteTool()` — jamais par une
// comparaison littérale dispersée.
export const WRITE_TOOL_NAMES: readonly string[] = [
  "editor",        // SDK Cline — écriture/édition de fichier
  "apply_patch",   // SDK Cline — patch (peut toucher plusieurs fichiers)
  "write_to_file", // alias observés selon les versions du SDK
  "write_file",    // harness historique / heuristiques front
  "edit",
  "multi_edit",
];

/** `true` si un outil peut modifier le disque (donc alimenter un checkpoint). */
export function isWriteTool(toolName: string | undefined | null): boolean {
  return typeof toolName === "string" && WRITE_TOOL_NAMES.includes(toolName);
}

// ── Lignes de CONTRÔLE du sidecar (hors flux d'agent) ────────────────────────
//
// Le sidecar émet deux familles de lignes :
//   - `kind: "event"` → le flux d'agent (`agent_event`, `chunk`, …) ;
//   - `kind: "tool_approval"` / `kind: "tool_write"` → des demandes BLOQUANTES
//     (voir `sidecar/src/index.ts`). Ces dernières ne sont pas des événements
//     d'agent : elles attendent une réponse et ne se traduisent pas en
//     `AgentEvent`. On les extrait ici pour que `clineClient` sache à qui
//     répondre, SANS polluer `translateClineLine` (qui reste pur).

/** Demande d'approbation d'outil émise par le sidecar (bloquante). */
export interface ClineApprovalRequest {
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: unknown;
  policy?: unknown;
}

/** Notification d'écriture imminente (checkpoint undo/keep) — bloquante. */
export interface ClineWriteRequest {
  requestId: string;
  paths: string[];
}

/** Ligne de contrôle reconnue, ou `null` si ce n'est pas une de ces demandes. */
export type ClineControlLine =
  | { kind: "tool_approval"; request: ClineApprovalRequest }
  | { kind: "tool_write"; request: ClineWriteRequest };

// ── Traduction principale ─────────────────────────────────────────────────────

// ── Formes émises par le SDK (sous-ensemble de @cline/shared AgentEvent) ───────
//
// On ne redéclare ici QUE ce que le pont consomme, en restant tolérant :
// tous les champs sont optionnels, car on refuse de planter sur une variante
// inattendue — un événement inconnu est journalisé, jamais fatal.

/** Métadonnées présentes sur CHAQUE événement d'agent (sous-agents). */
interface ClineEventMeta {
  agentId?: string;
  conversationId?: string;
  parentAgentId?: string | null;
}

interface ClineContentStart extends ClineEventMeta {
  type: "content_start";
  contentType: "text" | "reasoning" | "media" | "tool";
  text?: string;
  accumulated?: string;
  reasoning?: string;
  redacted?: boolean;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
}

interface ClineContentUpdate extends ClineEventMeta {
  type: "content_update";
  contentType: "text" | "reasoning" | "media" | "tool";
  /** Delta de texte (contentType="text"). */
  text?: string;
  /** Delta de raisonnement (contentType="reasoning"). */
  reasoning?: string;
  toolName?: string;
  toolCallId?: string;
  update?: unknown;
}

interface ClineContentEnd extends ClineEventMeta {
  type: "content_end";
  contentType: "text" | "reasoning" | "media" | "tool";
  text?: string;
  reasoning?: string;
  toolName?: string;
  toolCallId?: string;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

interface ClineIterationStart extends ClineEventMeta {
  type: "iteration_start";
  iteration: number;
}

interface ClineIterationEnd extends ClineEventMeta {
  type: "iteration_end";
  iteration: number;
  hadToolCalls: boolean;
  toolCallCount: number;
}

interface ClineUsage extends ClineEventMeta {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  totalInputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalOutputTokens?: number;
}

interface ClineNotice extends ClineEventMeta {
  type: "notice";
  noticeType: "recovery" | "stop" | "status";
  message: string;
  reason?: string;
}

interface ClineDone extends ClineEventMeta {
  type: "done";
  reason: "completed" | "max_iterations" | "aborted" | "mistake_limit" | "error";
  text?: string;
  iterations?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface ClineError extends ClineEventMeta {
  type: "error";
  error?: { message?: string } | string;
  recoverable?: boolean;
}

/** Union (tolérante) des événements que le pont sait interpréter. */
type ClineAgentEvent =
  | ClineContentStart
  | ClineContentUpdate
  | ClineContentEnd
  | ClineIterationStart
  | ClineIterationEnd
  | ClineUsage
  | ClineNotice
  | ClineDone
  | ClineError;

// ── Enveloppe du sidecar (`CoreSessionEvent`) ─────────────────────────────────

/**
 * Événement de session émis par le sidecar. On traite deux variantes :
 *   - `agent_event` : le contenu d'agent (texte, outils, usage, done…) ;
 *   - `team_progress` : le cycle de vie des coéquipiers (mode IA / équipes).
 * Les autres (`chunk`, `status`, `session_snapshot`, `hook`, `ended`,
 * `pending_prompts`) sont du bruit de transport ou des mécanismes internes du
 * SDK : les ignorer est sans risque pour l'UI.
 */
interface ClineSessionEventEnvelope {
  type?: string;
  payload?: {
    sessionId?: string;
    event?: ClineAgentEvent;
    teamAgentId?: string;
    teamRole?: string;
    // ── team_progress (Lot 6) ──
    teamName?: string;
    lifecycle?: ClineTeamLifecycle;
    summary?: ClineTeamSummary;
    // ── status ──
    status?: string;
    // ── ended ──
    reason?: string;
    // ── chunk ──
    stream?: string;
    chunk?: string;
    // ── pending_prompts / pending_prompt_submitted ──
    prompts?: ClinePendingPrompt[];
    id?: string;
    prompt?: string;
    delivery?: string;
    attachmentCount?: number;
    // ── hook ──
    hookEventName?: string;
    toolName?: string;
    iteration?: number;
    agentId?: string;
    parentAgentId?: string;
  };
}

/** Prompt en attente (file ou « steer ») signalé par le moteur. */
interface ClinePendingPrompt {
  id?: string;
  prompt?: string;
  delivery?: string;
  attachmentCount?: number;
}

// ── Événements d'ÉQUIPE (`team_progress`) ─────────────────────────────────────
//
// En mode IA, le root délègue à des coéquipiers via les outils `team_*`. Le SDK
// ne fait alors PAS passer leur cycle de vie par les `agent_event` du root :
// il émet des `team_progress` (un flux de « lifecycle » + un `summary`
// périodique de l'équipe). C'est la SEULE source pour savoir qu'un coéquipier
// naît, démarre une tâche, progresse et meurt — sans quoi les sous-agents
// resteraient invisibles dans l'UI.
//
// Formes constatées empiriquement (banc Lot 6, `banc-lot6-dump.json`) :
//   teammate_spawned → { agentId }
//   run_queued/run_started/run_progress/run_completed/run_failed → { agentId, runId, message? }
//   task_start/task_end → { agentId, taskId?, message? }
//   team_mission_log  → { agentId?, message }
// On reste tolérant : tous les champs optionnels, un eventType inconnu est
// journalisé, jamais fatal.

/** Cycle de vie d'un événement d'équipe (sous-ensemble de `TeamProgressLifecycleEvent`). */
interface ClineTeamLifecycle {
  teamName?: string;
  sessionId?: string;
  eventType?: string;
  ts?: string;
  agentId?: string;
  taskId?: string;
  runId?: string;
  outcomeId?: string;
  fragmentId?: string;
  message?: string;
}

/** Résumé périodique de l'équipe (sous-ensemble de `TeamProgressSummary`). */
interface ClineTeamSummary {
  members?: {
    total?: number;
    byStatus?: { idle?: number; running?: number; stopped?: number };
    leadCount?: number;
    teammateCount?: number;
  };
  runs?: {
    total?: number;
    activeRunIds?: string[];
    latestRunId?: string | null;
  };
}

// ── État d'un run (translation avec mémoire) ──────────────────────────────────

/**
 * Le pont conserve un peu d'état entre deux événements, car le SDK sépare ce
 * que l'UI veut voir unifié :
 *   - le TTFT (temps jusqu'au premier contenu) n'existe pas tel quel côté SDK :
 *     on l'horodate nous-mêmes au premier `content_start` de contenu ;
 *   - l'`usage` arrive par petits paquets cumulés ; le `done` fournit le total.
 *
 * Une instance = un run. On n'en partage jamais entre deux runs (sinon les
 * mesures d'un tour pollueraient le suivant).
 */
export interface ClineRunState {
  /** Horodatage de début du run (ms epoch), pour TTFT + durée totale. */
  startedAt: number;
  /** Horodatage du premier contenu (texte/raisonnement/outil), -1 tant qu'aucun. */
  firstContentAt: number;
  /** Nombre de caractères de contenu produit (texte + raisonnement). */
  outputChars: number;
  /** Dernier `usage` cumulé reçu du SDK (reporté sur `finish`). */
  usage: UsageData;
  /** Identifiant du modèle, pour la trace `timing`. */
  modelId: string;
  /** Nombre d'itérations observées (fallback si `done.iterations` absent). */
  iterations: number;
}

/** Crée l'état d'un run — à appeler AVANT d'envoyer le premier message. */
export function createClineRunState(modelId: string): ClineRunState {
  return {
    startedAt: Date.now(),
    firstContentAt: -1,
    outputChars: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId,
    iterations: 0,
  };
}

// ── Traduction principale ─────────────────────────────────────────────────────

/**
 * Traduit UNE ligne NDJSON brute reçue sur `cline://event` en zéro, un ou
 * plusieurs `AgentEvent` d'UI, et met à jour l'état du run.
 *
 * Renvoie un TABLEAU car certains événements SDK se décomposent en plusieurs
 * événements d'UI (ex. `done` → `timing` puis `finish`). L'appelant se contente
 * d'itérer et de pousser chaque élément dans son `handleEvent`.
 *
 * @param raw   ligne JSON brute émise par le sidecar (déjà `JSON.parse` éventuel
 *              fait par l'appelant, ou chaîne : on accepte les deux).
 * @param state état mutable du run courant (voir `createClineRunState`).
 */
export function translateClineLine(raw: unknown, state: ClineRunState): AgentEvent[] {
  const envelope = parseEnvelope(raw);
  if (!envelope) return [];

  // Les `team_progress` (mode IA) portent le cycle de vie des coéquipiers :
  // c'est là — et nulle part ailleurs — que l'on apprend qu'un sous-agent
  // naît/progresse/meurt. On les traduit vers les mêmes `subagent-*` que le
  // chemin `spawn_agent` du mode IDE, pour que l'UI n'ait qu'un seul modèle.
  if (envelope.type === "team_progress") return translateTeamProgress(envelope);

  // ── Autres variantes de `CoreSessionEvent` (hors `agent_event`) ─────────────
  //
  // Le SDK émet plusieurs familles en plus du contenu d'agent. La plupart n'ont
  // pas d'équivalent UI direct, mais deux sont utiles à la robustesse :
  //   - `chunk` de flux `stderr` : un outil (commande shell) a écrit sur la
  //     sortie d'erreur. On le remonte comme un `notice` pour que l'utilisateur
  //     voie un problème au lieu d'un long silence (sinon la commande « semble »
  //     figée jusqu'à son `content_end`).
  //   - `ended` : la session s'est arrêtée côté moteur. Si aucun `done` n'est
  //     venu clore le tour, l'UI resterait bloquée sur « génération en cours ».
  //     On émet alors un `finish` de secours (idempotent côté UI).
  // Les autres (`status`, `session_snapshot`, `hook`, `pending_prompts`,
  // `pending_prompt_submitted`) sont du transport / de l'orchestration interne :
  // sans effet sur l'affichage aujourd'hui, on les ignore sans bruit.
  if (envelope.type === "chunk") return translateChunk(envelope);
  if (envelope.type === "ended") return translateEnded(envelope, state);

  // Seul `agent_event` porte du contenu d'agent.
  if (envelope.type !== "agent_event") return [];

  const event = envelope.payload?.event;
  if (!event || typeof event.type !== "string") return [];

  // Sous-agent : le SDK route par `parentAgentId` (le lead qui a créé l'agent).
  // L'UI, elle, route par `spawnId` — on fait donc correspondre les deux.
  const spawnId = resolveSpawnId(event, envelope);

  switch (event.type) {
    case "content_start":
      return translateContentStart(event, state, spawnId);

    case "content_update":
      // Le SDK peut streamer des DELTAS de contenu : du texte (`contentType:
      // "text"`) ou du raisonnement. On les traduit comme un `token`/`reasoning`
      // — sinon ces tokens seraient perdus (le seul `content_end` final ne
      // restitue pas toujours le flux complet, et l'effet perçu serait un
      // « texte qui n'arrive qu'à la fin »).
      //
      // Les `content_update` de type `tool` (stdout streamé d'une commande) ne
      // sont pas mappés : le `content_end` qui suit porte le résultat complet.
      if (event.contentType === "text" && event.text) {
        if (state.firstContentAt < 0) state.firstContentAt = Date.now();
        state.outputChars += event.text.length;
        return [{ type: "token", delta: event.text, spawnId }];
      }
      if (event.contentType === "reasoning" && event.reasoning) {
        if (state.firstContentAt < 0) state.firstContentAt = Date.now();
        state.outputChars += event.reasoning.length;
        return [{ type: "reasoning", delta: event.reasoning, spawnId }];
      }
      return [];

    case "content_end": {
      if (event.contentType !== "tool") return [];
      // Fin d'un outil : on fige sa carte avec le résultat (ou l'erreur).
      const id = event.toolCallId ?? "";
      if (!id) return [];
      const result = event.error ? { error: event.error } : event.output;
      return [{ type: "tool-result", id, toolName: event.toolName ?? "", result, spawnId }];
    }

    case "iteration_start": {
      state.iterations = event.iteration;
      return [];
    }

    case "iteration_end":
      return [{ type: "step-finish" }];

    case "usage": {
      // Le SDK fournit déjà des totaux cumulés : on les préfère aux champs du
      // tour, pour que la trace de fin reflète tout le run, pas la dernière API.
      state.usage = {
        inputTokens: event.totalInputTokens ?? event.inputTokens,
        outputTokens: event.totalOutputTokens ?? event.outputTokens,
        cacheReadTokens: event.totalCacheReadTokens ?? event.cacheReadTokens,
        cacheCreationTokens: event.totalCacheWriteTokens ?? event.cacheWriteTokens,
      };
      return [];
    }

    case "notice": {
      // Les notices de compaction sont mappées vers la bannière existante.
      // Les autres (status, recovery, stop) sont du bruit pour l'UI d'aujourd'hui.
      if (event.reason === "auto_compaction" || event.reason === "manual_compaction") {
        return [{ type: "notice", kind: "compaction", detail: event.message }];
      }
      return [];
    }

    case "done": {
      // PIÈGE (mode IA) : un coéquipier émet SON PROPRE `done` (on l'a observé
      // sur banc — `teamAgentId="explorer"`, `teamRole="teammate"`). Ce n'est
      // PAS la fin du tour : le root continue son orchestration (il attend le
      // run, agrège, puis conclut). Clore le run global ici ferait disparaître
      // l'UI en plein milieu de l'orchestration. On clôt donc la CARTE du
      // sous-agent et rien d'autre.
      if (spawnId) {
        return [{
          type: "subagent-end",
          spawnId,
          status: event.reason === "completed" ? "completed" : "error",
          report: event.text ?? "",
          iterations: event.iterations ?? 0,
          inputTokens: event.usage?.inputTokens ?? 0,
          outputTokens: event.usage?.outputTokens ?? 0,
        }];
      }
      if (event.usage) {
        state.usage = {
          inputTokens: event.usage.inputTokens ?? state.usage.inputTokens,
          outputTokens: event.usage.outputTokens ?? state.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens ?? state.usage.cacheReadTokens,
          cacheCreationTokens: event.usage.cacheWriteTokens ?? state.usage.cacheCreationTokens,
        };
      }
      // Trace de latence, puis `finish` — dans cet ordre, comme le fait déjà
      // `runAgent` (l'UI logue `timing` et clôt sur `finish`).
      const timing = buildTiming(state);
      return [timing, { type: "finish", usage: state.usage }];
    }

    case "error":
      return [{ type: "error", message: errorMessage(event) }];

    default:
      // Variante inconnue : on ne casse rien, mais on le SAIT (le SDK a évolué).
      log.warn("agent/clineBridge", `événement SDK non géré: ${String((event as { type?: unknown }).type)}`);
      return [];
  }
}

/**
 * Reconnaît une ligne de CONTRÔLE (demande bloquante) émise par le sidecar.
 *
 * Renvoie `null` pour toute autre ligne (événement d'agent, bruit de transport),
 * ce qui permet à `clineClient` de router sans ambiguïté :
 *   `translateClineControlLine(raw)` d'abord, puis `translateClineLine(raw, state)`.
 */
export function translateClineControlLine(raw: unknown): ClineControlLine | null {
  const obj = typeof raw === "string" ? tryParse(raw) : raw;
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  if (o.kind === "tool_approval") {
    const requestId = typeof o.requestId === "string" ? o.requestId : "";
    if (!requestId) return null;
    return {
      kind: "tool_approval",
      request: {
        requestId,
        toolName: typeof o.toolName === "string" ? o.toolName : "",
        toolCallId: typeof o.toolCallId === "string" ? o.toolCallId : undefined,
        input: o.input,
        policy: o.policy,
      },
    };
  }

  if (o.kind === "tool_write") {
    const requestId = typeof o.requestId === "string" ? o.requestId : "";
    if (!requestId) return null;
    const paths = Array.isArray(o.paths)
      ? o.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    return { kind: "tool_write", request: { requestId, paths } };
  }

  return null;
}

/** Parse tolérant : renvoie `null` au lieu de jeter sur une ligne illisible. */
function tryParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

// ── Helpers de traduction ─────────────────────────────────────────────────────

function translateContentStart(
  event: ClineContentStart,
  state: ClineRunState,
  spawnId: string | undefined,
): AgentEvent[] {
  const markContent = () => {
    if (state.firstContentAt < 0) state.firstContentAt = Date.now();
  };

  switch (event.contentType) {
    case "text": {
      markContent();
      const delta = event.text ?? "";
      state.outputChars += delta.length;
      return delta ? [{ type: "token", delta, spawnId }] : [];
    }
    case "reasoning": {
      markContent();
      const delta = event.reasoning ?? "";
      state.outputChars += delta.length;
      return delta ? [{ type: "reasoning", delta, spawnId }] : [];
    }
    case "tool": {
      markContent();
      const id = event.toolCallId ?? "";
      if (!id) return [];
      return [{
        type: "tool-call",
        id,
        toolName: event.toolName ?? "",
        args: event.input,
        spawnId,
      }];
    }
    default:
      return [];
  }
}

/**
 * Traduit un `chunk` de flux outil. Seul `stderr` est remonté (sous forme de
 * `notice`) : un outil qui écrit sur la sortie d'erreur est un signal utile
 * pendant un long silence. Les flux `stdout`/`agent` sont du bruit (le résultat
 * structuré arrive par `content_end`) : on les ignore.
 */
function translateChunk(envelope: ClineSessionEventEnvelope): AgentEvent[] {
  const chunk = envelope.payload?.chunk;
  if (envelope.payload?.stream !== "stderr" || !chunk) return [];
  return [{ type: "notice", kind: "retry", detail: chunk }];
}

/**
 * Traduit un `ended` (session arrêtée côté moteur). Si le tour n'a pas déjà été
 * clos par un `done`, on émet un `finish` de secours avec l'usage accumulé, pour
 * que l'UI ne reste pas bloquée sur « génération en cours ».
 *
 * L'UI ignore les `finish` en double (elle est déjà en fin de tour) : émettre ce
 * filet de sécurité est donc sans risque si un `done` a précédé.
 */
function translateEnded(envelope: ClineSessionEventEnvelope, state: ClineRunState): AgentEvent[] {
  const reason = envelope.payload?.reason;
  // Un `ended` porte toujours un motif ; `completed` est le cas normal déjà
  // couvert par `done`. On ne fabrique un `finish` que pour une fin anormale.
  if (!reason || reason === "completed") return [];
  return [{ type: "finish", usage: state.usage }];
}

/** Construit la trace `timing` à partir de l'état accumulé du run. */
function buildTiming(state: ClineRunState): Extract<AgentEvent, { type: "timing" }> {
  const end = Date.now();
  const totalMs = Math.max(1, end - state.startedAt);
  const ttftMs = state.firstContentAt < 0 ? totalMs : Math.max(1, state.firstContentAt - state.startedAt);
  const genMs = Math.max(1, totalMs - ttftMs);
  // ~4 chars/token : suffisant pour un débit relatif fiable (même heuristique
  // que le harness actuel, cf. `run.ts`).
  const outTokens = Math.ceil(state.outputChars / 4);
  return {
    type: "timing",
    ttftMs,
    totalMs,
    genMs,
    outputChars: state.outputChars,
    tokPerSec: Math.round((outTokens / (genMs / 1000)) * 10) / 10,
    model: state.modelId,
    fallbacks: 0,
  };
}

/** Extrait un message d'erreur lisible, quelle que soit la forme reçue. */
function errorMessage(event: ClineError): string {
  const e = event.error;
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  return "erreur du moteur d'agent";
}

/**
 * Détermine le `spawnId` d'un événement. Un événement appartenant à un
 * sous-agent porte `parentAgentId` (l'agent parent qui l'a créé) ; l'UI route
 * ces flux vers la carte du sous-agent via `spawnId`. Le `teamAgentId` de
 * l'enveloppe est plus précis quand il est présent (équipes Cline).
 */
function resolveSpawnId(event: ClineEventMeta, envelope: ClineSessionEventEnvelope): string | undefined {
  const fromTeam = envelope.payload?.teamAgentId;
  if (typeof fromTeam === "string" && fromTeam.length > 0) return fromTeam;
  const parent = event.parentAgentId;
  if (typeof parent === "string" && parent.length > 0) return parent;
  return undefined;
}

// ── Traduction des événements d'équipe (`team_progress`) ──────────────────────

/**
 * Traduit un `team_progress` en `AgentEvent` de sous-agent.
 *
 * POURQUOI CE MAPPING
 * -------------------
 * Le mode IA (équipes) et le mode IDE (`spawn_agent`) produisent le même
 * concept — un sous-agent avec un cycle de vie — mais par deux canaux
 * différents. On unifie ici vers `subagent-start/step/end` afin que
 * `AiPanel` n'ait AUCUNE logique spécifique aux équipes : il reçoit les mêmes
 * événements, routés par `spawnId`.
 *
 * `spawnId` = `lifecycle.agentId` : par convention un coéquipier a un `agentId`
 * stable (ex. `"explorer"`), c'est la clé de sa carte dans `swarmStore`. On
 * ignore les événements sans `agentId` (bruit d'orchestration du lead).
 *
 * `toolCallId` du `subagent-start` = `runId` s'il est présent : dans le flux
 * IA, la carte du coéquipier est rattachée au tool-call `team_run_task` (qui a
 * lancé le run), pas à un `spawn_agent`. Le `runId` permet ce rattachement.
 */
function translateTeamProgress(envelope: ClineSessionEventEnvelope): AgentEvent[] {
  const lc = envelope.payload?.lifecycle;
  if (!lc || typeof lc.eventType !== "string") return [];

  const agentId = typeof lc.agentId === "string" && lc.agentId.length > 0 ? lc.agentId : undefined;

  switch (lc.eventType) {
    case "teammate_spawned": {
      // Naissance d'un coéquipier : on crée sa carte. `toolCallId` est inconnu
      // ici (le spawn précède le run) — le rattachement à la carte du tool-call
      // `team_run_task` se fera au `run_started` suivant, via `runId`.
      if (!agentId) return [];
      return [{ type: "subagent-start", spawnId: agentId, role: agentId, task: "" }];
    }

    case "task_start":
    case "run_started": {
      // Le run démarre réellement : on rattache la carte au tool-call parent
      // via `runId` (l'UI retrouve le tool-call `team_run_task` correspondant).
      if (!agentId) return [];
      return [{ type: "subagent-start", spawnId: agentId, role: agentId, task: lc.message ?? "", toolCallId: lc.runId }];
    }

    case "run_progress": {
      // Battement de cœur du run : on incrémente l'itération de la carte.
      if (!agentId) return [];
      return [{ type: "subagent-step", spawnId: agentId, iteration: parseIteration(lc.message) }];
    }

    case "task_end":
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
    case "run_interrupted": {
      if (!agentId) return [];
      const status = teamRunStatus(lc.eventType);
      return [{
        type: "subagent-end",
        spawnId: agentId,
        status,
        report: lc.message ?? "",
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
      }];
    }

    case "agent_event":
      // Le contenu du coéquipier arrive par les `agent_event` habituels, déjà
      // routés par `teamAgentId` (voir `resolveSpawnId`). Rien à faire ici.
      return [];

    default:
      // `run_queued`, `team_mission_log`, `team_task_updated`, outcomes, etc. :
      // utiles au diagnostic mais sans effet sur les cartes de sous-agents.
      return [];
  }
}

/** Extrait un numéro d'itération d'un message de type `iteration_N_started`. */
function parseIteration(message: string | undefined): number {
  if (!message) return 0;
  const m = /iteration_(\d+)/.exec(message);
  return m ? Number(m[1]) : 0;
}

/** Mappe un eventType de fin de run d'équipe vers `SubAgentStatus`. */
function teamRunStatus(eventType: string): Extract<AgentEvent, { type: "subagent-end" }>["status"] {
  switch (eventType) {
    case "run_completed":
      return "completed";
    case "run_cancelled":
      return "cancelled";
    case "run_interrupted":
      return "cancelled";
    case "run_failed":
      return "error";
    default:
      return "completed";
  }
}

/**
 * Normalise la ligne brute en enveloppe exploitable.
 *
 * DEUX FORMES À GÉRER
 * -------------------
 * Le sidecar n'émet PAS directement un `CoreSessionEvent` : il enrobe chaque
 * événement dans un message NDJSON `{ kind: "event", event: <CoreSessionEvent> }`
 * (voir `emit()` dans `sidecar/src/index.ts`). Le `CoreSessionEvent` lui-même a
 * la forme `{ type: "agent_event", payload: {...} }`. Il faut donc DÉPIOCER le
 * `kind` avant de lire `type`/`payload` — sinon `envelope.type` vaudrait
 * `undefined` et AUCUN événement ne serait traduit.
 *
 * On accepte aussi un objet déjà dépiauté (un `CoreSessionEvent` nu) : c'est le
 * cas des tests unitaires, qui n'ont pas à simuler l'enveloppe de transport.
 *
 * Toute ligne illisible est ignorée sans bruit excessif.
 */
function parseEnvelope(raw: unknown): ClineSessionEventEnvelope | null {
  const parsed = typeof raw === "string" ? tryParse(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  // Forme de transport du sidecar : `{ kind: "event", event: {...} }`.
  if (o.kind === "event") {
    const inner = o.event;
    return inner && typeof inner === "object" ? (inner as ClineSessionEventEnvelope) : null;
  }

  // Forme nue (tests) : l'objet EST déjà le `CoreSessionEvent`.
  return o as ClineSessionEventEnvelope;
}
