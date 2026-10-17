import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { LanguageModel } from "ai";
import type { PendingAction } from "./tools";
import type { UsageData } from "../ai";
import { compactHistory } from "./compactHistory";
import { budgetLevel, emergencyTruncateToolResults, estimateTokensWithOverhead, CRITICAL_THRESHOLD, DEFAULT_TOKEN_BUDGET } from "./tokenBudget";
import {
  classifyFailure, parseRetryAfter, retryDelayMs, CONTINUATION_REMINDER, MAX_ATTEMPTS,
} from "./retry";
import { shouldFallback, nextModelIndex, shouldFallbackOnSlowTtft } from "./modelCascade";
import { clampToolResult } from "./outputLimits";
import { modelHealth } from "./modelHealth";
import { log } from "../logger";

// Garde d'INACTIVITÉ du flux, en ms. Une fois le flux démarré, si AUCUN chunk
// n'arrive pendant ce délai, la tentative est coupée (classée transient →
// cascade/reprise). Le garde « premier chunk » ne suffit pas : un provider peut
// émettre un delta puis laisser le socket ouvert sans jamais le fermer — le tour
// reste alors figé à vie, en silence (symptôme observé en production : deux
// `list_directory` affichés puis 10 min de rien, sans `stream-end`). Ce délai
// doit rester LARGE : un gros modèle peut légitimement réfléchir longtemps entre
// deux tokens (raisonnement, generation d'un long appel d'outil), et un seuil
// trop bas couperait des tours valides. 90 s = marge sûre au-dessus d'un silence
// normal, tout en évitant l'attente infinie.
const DEFAULT_STALL_TIMEOUT_MS = 90_000;

// ── Event types ────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "token";             delta: string; spawnId?: string }
  | { type: "reasoning";         delta: string; spawnId?: string }
  | { type: "tool-call";         id: string; toolName: string; args: unknown; spawnId?: string }
  | { type: "tool-result";       id: string; toolName: string; result: unknown; spawnId?: string }
  // ── Sortie shell en DIRECT (miroir du « terminal agent », parité SOLO) ─────
  // Pendant qu'un outil shell (`run_commands`) tourne, le SDK streame sa sortie
  // sur `stdout`/`stderr` (`CoreSessionEvent` de type `chunk`). On la remonte ici
  // pour alimenter l'onglet « Agent » du panneau bas en temps réel, AVANT que le
  // `tool-result` final n'arrive. `stream` distingue les deux flux (colorisation).
  | { type: "terminal-output";    chunk: string; stream: "stdout" | "stderr" }
  | { type: "approval-required"; id: string; action: PendingAction; approve: () => void; reject: (answer?: string) => void }
  | { type: "approval-resolved"; id: string; status: "approved" | "rejected" }
  | { type: "notice";            kind: "compaction" | "retry"; detail: string; savedTokens?: number }
  // ── Sous-agents (mode IA uniquement) ───────────────────────────────────────
  // Le run enfant est émis avec les MÊMES events, préfixés par `spawnId`, afin
  // qu'ils ne se mélangent JAMAIS au flux du root. L'hôte route par `spawnId` :
  // sans id → root, avec id → carte du sous-agent concerné.
  | { type: "subagent-start"; spawnId: string; role: string; task: string; toolCallId?: string }
  | { type: "subagent-step";  spawnId: string; iteration: number }
  | { type: "subagent-end";   spawnId: string; status: SubAgentStatus; report: string; iterations: number; inputTokens: number; outputTokens: number }
  | { type: "step-finish" }
  | { type: "finish";            usage: UsageData }
  // ── Instrumentation (mesure de latence par tour) ───────────────────────────
  // Émis une fois par tour, juste avant `finish`/`error`. Permet d'objectiver
  // « c'est lent » : TTFT (démarrage perçu), débit de génération, et le modèle
  // réellement utilisé (une bascule de cascade change le modèle en cours de tour).
  | { type: "timing"; ttftMs: number; totalMs: number; genMs: number; outputChars: number; tokPerSec: number; model: string; fallbacks: number }
  | { type: "error";             message: string };

/** Issue d'un sous-agent — reflète un budget dur atteint ou une fin normale. */
export type SubAgentStatus = "completed" | "max_iterations" | "max_tokens" | "timeout" | "error" | "cancelled";

// ── runAgent ───────────────────────────────────────────────────────────────────

export interface RunAgentOptions {
  model:        LanguageModel;
  /**
   * Cascade de modèles de secours (repli). `modelChain[i]` est le modèle à
   * utiliser après `i` échecs de saturation. Le premier élément DOIT correspondre
   * à `model`. Vide ou absent → un seul modèle (comportement d'origine).
   * Utilisé en bascule automatique sur `rate-limited` / `transient`.
   */
  modelChain?:  LanguageModel[];
  /** Identifiants (mêmes index que `modelChain`) pour la trace `timing`. */
  modelIds?:    string[];
  messages:     ModelMessage[];
  tools:        ToolSet;
  systemPrompt: string;
  cacheSystem?: boolean;
  onEvent:      (event: AgentEvent) => void;
  /**
   * Nombre maximum de tours d'outils avant arrêt dur (`stopWhen`). Le root
   * utilise 24 ; un sous-agent un budget volontairement plus serré (économie
   * de tokens). L'arrêt par `stopWhen` est détecté pour rapporter l'issue
   * `max_iterations` au lieu d'un faux « completed ».
   */
  maxSteps?:    number;
  /**
   * Délai maximum par appel d'outil, en ms. Un outil qui dépasse est rejeté
   * (le tour continue avec un résultat d'erreur) — protège le root contre un
   * sous-agent bloqué. 0 = pas de limite.
   */
  toolTimeoutMs?: number;
  /**
   * Délai maximum avant le PREMIER chunk du flux, en ms. Si le provider
   * n'émet rien dans ce délai, la tentative est abandonnée avec une erreur
   * classée « transient » → bascule sur le modèle suivant de la cascade.
   * Protège contre un flux qui ne se ferme jamais (tour figé en silence).
   * 0 = pas de garde. Défaut : 45 000 ms.
   */
  firstChunkMs?: number;
  /**
   * Délai maximal d'INACTIVITÉ une fois le flux démarré, en ms. Si aucun chunk
   * n'arrive pendant ce délai, la tentative est coupée (classée « transient » →
   * cascade/reprise). Couvre le provider qui émet un delta puis laisse le socket
   * ouvert sans le fermer (tour figé à vie). 0 = pas de garde.
   * Défaut : 90 000 ms.
   */
  stallTimeoutMs?: number;
  /**
   * Budget TTFT (ms) : si le PREMIER chunk arrive après ce délai ET qu'un autre
   * modèle est disponible, on abandonne la tentative et on bascule (voir
   * `shouldFallbackOnSlowTtft`). Couvre le cas « le modèle répond mais très
   * lentement » (provider surchargé), que la cascade sur erreur ne voit pas.
   * 0 = désactivé. Défaut : 0 (activé explicitement par l'hôte).
   */
  ttftBudgetMs?: number;
  /**
   * Signal d'annulation externe (propagation parent → enfant). Quand un hôte
   * de sous-agent veut couper un run (timeout, budget, abort du root), il passe
   * son propre signal ici : le run s'arrête dès que l'un des deux se déclenche.
   */
  abortSignal?: AbortSignal;
  /**
   * Usage déjà consommé avant ce run — permet à un parent de cumuler l'usage
   * de ses enfants et de le reporter dans son propre event `finish`.
   */
  initialUsage?: UsageData;
  /**
   * Appelé UNE seule fois, à la toute fin du run (succès, erreur ou abort),
   * avec l'issue réelle. Permet à un hôte (ex. sous-agent) d'attendre la fin
   * du flux sans deviner à partir des events.
   */
  onSettled?: (status: SubAgentStatus) => void;
}

export function runAgent(options: RunAgentOptions): { cancel: () => void; status: () => SubAgentStatus } {
  const {
    model, messages, tools, systemPrompt,
    cacheSystem = false, onEvent,
    maxSteps = 24,
    toolTimeoutMs = 0,
    firstChunkMs = 45_000,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    ttftBudgetMs = 0,
    initialUsage,
    abortSignal,
    onSettled,
  } = options;

  // Cascade de modèles : `[0]` = modèle principal (celui de `model`), les
  // suivants = replis. Un seul élément si aucune cascade n'est fournie.
  const modelChain = options.modelChain && options.modelChain.length > 0
    ? options.modelChain
    : [model];
  const modelIds = options.modelIds ?? [];
  // Index du modèle courant dans la cascade (avance sur saturation).
  let chainIndex = 0;
  // Nombre de bascules effectuées ce run — exposé dans la trace `timing`.
  let fallbackCount = 0;
  const currentModel = () => modelChain[chainIndex];
  const currentModelId = () => modelIds[chainIndex] ?? "";
  let controller = new AbortController();

  // Vrai si l'utilisateur a demandé l'annulation (via `cancel()`). Sert à
  // distinguer une vraie annulation d'un abort interne (garde anti-flux-muet),
  // seul cas où l'on recrée un controller pour laisser la cascade s'exécuter.
  let userCancelled = false;

  // Enveloppe `onEvent` : après l'abort, PLUS AUCUN event n'est émis. Un outil
  // déjà « en vol » au moment du stop peut encore résoudre et tenter d'émettre
  // son `tool-result` via le flux — cette garde l'empêche de remonter à l'hôte.
  const emit = (event: AgentEvent) => {
    if (controller.signal.aborted) return;
    onEvent(event);
  };

  // Propagation parent → enfant : si le run parent (ou l'hôte du sous-agent)
  // annule son signal, on coupe le stream. Les deux déclencheurs sont équivalents.
  if (abortSignal) {
    if (abortSignal.aborted) { userCancelled = true; controller.abort(); }
    else abortSignal.addEventListener("abort", () => { userCancelled = true; controller.abort(); }, { once: true });
  }

  // Issue du run, locale à CET appel (jamais partagée entre runs concurrents).
  let runStatus: SubAgentStatus = "completed";

  // `onSettled` doit être appelé EXACTEMENT une fois, quel que soit le chemin de
  // sortie (succès, erreur, abort). On mémorise l'appel pour éviter un doublon.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettled?.(runStatus);
  };

  // Vrai dès que la tentative courante a produit du contenu visible (token, outil,
  // finish). Partagé entre `attemptRun` et la boucle de retry.
  let producedOutput = false;

  // Vrai si le flux s'est arrêté parce que `stopWhen` a été atteint — on ne doit
  // alors PAS rapporter un « completed » trompeur. Réinitialisé à chaque tentative.
  let hitStepLimit = false;

  // Vrai si la tentative a été coupée par la garde anti-flux-muet (et non par
  // l'utilisateur). Distingue un abandon interne — qui DOIT déclencher la
  // cascade — d'une annulation utilisateur, qui doit tout arrêter net.
  let firstChunkTimedOut = false;

  // Vrai si la tentative a été coupée par la garde TTFT (modèle trop lent). Même
  // logique : abandon interne → cascade, jamais confondu avec un abort utilisateur.
  let ttftTooSlow = false;

  // Vrai si la tentative a été coupée par la garde d'INACTIVITÉ : le flux avait
  // démarré (au moins un chunk) mais s'est tu au-delà de `stallTimeoutMs` sans se
  // fermer. Même traitement qu'un flux muet : abandon interne → cascade/reprise.
  let stalled = false;

  // Timeout dur par outil : un outil qui dépasse le délai est abandonné avec un
  // résultat d'erreur au lieu de bloquer tout le tour. On enveloppe l'`execute`
  // d'origine sans toucher au reste de la définition du tool (schéma, etc.).
  const guardedTools: ToolSet = toolTimeoutMs > 0
    ? Object.fromEntries(
        Object.entries(tools).map(([name, t]) => {
          const def = t as { execute?: (input: unknown, opts: unknown) => unknown };
          if (typeof def.execute !== "function") return [name, t];
          const original = def.execute;
          return [name, {
            ...def,
            execute: async (input: unknown, opts: unknown) => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  Promise.resolve(original(input, opts)),
                  new Promise((resolve) => {
                    timer = setTimeout(
                      () => resolve({ error: `Tool "${name}" timed out after ${toolTimeoutMs} ms` }),
                      toolTimeoutMs,
                    );
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            },
          }];
        }),
      )
    : tools;

  // Un tour = une ou plusieurs tentatives. On ne rejoue JAMAIS un tour qui a déjà
  // produit du contenu (tokens ou outils) : une reprise aveugle dupliquerait des
  // éditions. Dans ce cas on injecte un rappel de continuation et on laisse le
  // modèle reprendre. Seuls les échecs « à vide » (rien émis) sont réessayés à
  // l'identique, avec backoff exponentiel + jitter.
  const attemptRun = async (extraReminder: string | null): Promise<void> => {
    const sysMsg = (
      cacheSystem
        ? { role: "system", content: systemPrompt, providerOptions: markCacheable(undefined) }
        : { role: "system", content: systemPrompt }
    ) as ModelMessage;
    // Pression mémoire avant l'appel : compaction sémantique jusqu'à 80 %, puis
    // troncature d'urgence des vieux tool results au-delà de 95 % (cf. jcode).
    let historyMsgs: ModelMessage[];
    {
      const level = budgetLevel(messages);
      const working = messages.slice();
      const beforeTokens = estimateTokensWithOverhead(working);

      if (level === "critical") {
        // Urgence : on tronque d'abord, puis on compacte (les tool results
        // volumineux disparaissent avant la compaction sémantique).
        const truncated = emergencyTruncateToolResults(working);
        const compacted = compactHistory(truncated);
        // Si la troncature + compaction ne suffisent pas, dernier recours :
        // on repart de l'historique compacté seul, sans les vieux tool results.
        historyMsgs =
          estimateTokensWithOverhead(compacted) / DEFAULT_TOKEN_BUDGET >= CRITICAL_THRESHOLD
            ? emergencyTruncateToolResults(compacted)
            : compacted;
      } else {
        historyMsgs = compactHistory(working);
      }

      // Signale à l'UI qu'une compaction a réellement eu lieu (l'historique réduit
      // est plus court que l'original) — affiché comme bannière « Compaction… ».
      if (level !== "ok" && historyMsgs !== working) {
        const afterTokens = estimateTokensWithOverhead(historyMsgs);
        const saved = Math.max(0, Math.round(beforeTokens - afterTokens));
        emit({
          type: "notice",
          kind: "compaction",
          detail: level === "critical" ? "Contexte critique : compaction + troncature" : "Compaction de l'historique",
          savedTokens: saved,
        });
      }
    }

    // ── Stabilité du préfixe + cache fournisseur ─────────────────────────────
    // Le préfixe (system + outils + historique) est ré-expédié intégralement à
    // chaque tour. Si ce préfixe est IDENTIQUE d'un tour à l'autre, les providers
    // compatibles (Anthropic, OpenAI, et la plupart des passerelles) servent un
    // CACHE : le TTFT s'effondre au 2ᵉ tour. Deux conditions :
    //   1. le système et l'historique sont envoyés octet pour octet à l'identique ;
    //   2. un point de cache est posé sur le DERNIER message user (cf. Cline
    //      `applyPromptCacheToLastTextPart`) — tout le préfixe avant ce point est
    //      alors mis en cache, y compris les messages user antérieurs.
    // La donnée volatile (ex. `contextStatusPrompt`) est donc poussée en FIN de
    // système (après les blocs stables), et non en tête, pour ne pas décaler tout
    // l'historique. On n'ajoute jamais de cache breakpoint sur les 4 derniers
    // messages : un point mouvant à chaque tour casserait le cache au lieu de l'aider.
    if (cacheSystem && historyMsgs.length > 0) {
      const last = historyMsgs[historyMsgs.length - 1];
      const lastWithOptions = last as ModelMessage & { providerOptions?: Record<string, unknown> };
      historyMsgs[historyMsgs.length - 1] = {
        ...last,
        providerOptions: markCacheable(lastWithOptions.providerOptions),
      } as ModelMessage;
    }

    // Rappel système de reprise (tour de retry uniquement) — jamais persisté.
    const allMessages: ModelMessage[] = extraReminder
      ? [sysMsg, ...historyMsgs, { role: "user", content: extraReminder } as ModelMessage]
      : [sysMsg, ...historyMsgs];

    const result = streamText({
      model:       currentModel(),
      messages:    allMessages,
      tools:       guardedTools,
      stopWhen:    stepCountIs(maxSteps),
      abortSignal: controller.signal,
      // Plafond de génération par appel : évite qu'un modèle bavard épuise la
      // fenêtre restante et se fasse tronquer au milieu d'un outil (ce qui
      // déclencherait une reprise = un aller-retour entier de perdu). Réservé
      // ~25 % de la fenêtre pour l'entrée du tour suivant. Voir resolveMaxOutputTokens.
      maxOutputTokens: resolveMaxOutputTokens(estimateTokensWithOverhead(historyMsgs)),
    });

    // Instrumentation : on horodate le départ et le premier token de CONTENU
    // (texte ou raisonnement) pour mesurer le TTFT réel. Un `tool-call` arrive
    // souvent avant tout texte — il compte aussi comme « premier signe de vie »
    // du modèle, sinon on surestimerait le TTFT sur les tours d'outils.
    const t0 = performance.now();
    let firstSignalMs = -1;
    let outputChars = 0;
    // Compteur de chunks reçus : permet de distinguer « aucun octet reçu »
    // (provider muet) de « flux en cours » dans la trace de diagnostic.
    let chunkCount = 0;
    let firstChunkLogged = false;
    log.info("agent/run", `call-start model=${currentModelId() || "?"} msgs=${allMessages.length} retry=${extraReminder ? "oui" : "non"}`);

    // Garde anti-flux-muet : si le provider n'émet AUCUN chunk dans les
    // `FIRST_CHUNK_TIMEOUT_MS`, on coupe et on remonte une erreur classée
    // « transient » → la boucle de retry bascule sur le modèle suivant. Sans
    // cette borne, un flux qui ne se ferme jamais fige le tour à vie, en
    // silence (c'est exactement le symptôme observé : `call-start` puis rien).
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    if (firstChunkMs > 0) {
      firstChunkTimer = setTimeout(() => {
        log.warn("agent/run", `flux muet : aucun chunk après ${firstChunkMs} ms — abandon de la tentative`);
        firstChunkTimedOut = true;
        controller.abort();
      }, firstChunkMs);
    }

    // Garde d'INACTIVITÉ : réarmé à CHAQUE chunk. Il ne s'active qu'entre deux
    // chunks (flux interrompu au milieu) et non avant le premier — cette phase
    // est couverte par `firstChunkTimer`. Sans lui, un flux qui émet un delta
    // puis bloque le socket reste ouvert indéfiniment.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (stallTimeoutMs <= 0) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        log.warn("agent/run", `flux bloqué : aucun chunk depuis ${stallTimeoutMs} ms — abandon de la tentative`);
        stalled = true;
        controller.abort();
      }, stallTimeoutMs);
    };

    try {
      for await (const part of result.fullStream) {
        if (controller.signal.aborted) break;

        chunkCount++;

        // « Premier signe de vie » = premier CONTENU réel (texte, raisonnement,
        // appel d'outil). On ignore délibérément les parts d'échafaudage que le
        // SDK émet AVANT tout contenu (`start`, `start-step`, `text-start`,
        // `reasoning-start`, `tool-input-start`…). Les compter annulerait le
        // garde-flux-muet et fausserait le TTFT à ~0 ms : c'est précisément ce
        // qui masquait un modèle réellement lent (TTFT 10 s) et empêchait la
        // bascule. On ne chronomètre donc QUE la vraie production de tokens.
        const isContent =
          part.type === "text-delta" ||
          part.type === "reasoning-delta" ||
          part.type === "tool-call" ||
          part.type === "tool-input-start";

        // Progrès réel = contenu du modèle OU progression déterministe d'un tour
        // (résultat d'outil, fin de step). On réarme le garde d'inactivité sur ce
        // progrès SEULEMENT : un flux qui n'émettrait que des parts d'échafaudage
        // ou des heartbeats (sans jamais avancer) doit être coupé, pas bercé.
        const isProgress = isContent || part.type === "tool-result" || part.type === "finish-step";
        if (firstChunkLogged && isProgress) armStall();

        if (!firstChunkLogged && isContent) {
          firstChunkLogged = true;
          if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = undefined; }
          // Le flux est désormais « ouvert » : on bascule du garde premier-chunk
          // vers le garde d'inactivité entre chunks.
          armStall();
          const ttft = performance.now() - t0;
          log.info("agent/run", `first-chunk après ${Math.round(ttft)} ms (type=${part.type})`);
          // Santé du modèle : on mémorise le TTFT observé pour le routage
          // adaptatif des tours suivants (cf. rankModelChain).
          modelHealth.noteTtft(currentModelId(), ttft);
          // Garde TTFT : le modèle RÉPOND mais trop lentement. Si un autre modèle
          // est disponible, on abandonne cette tentative (avant tout contenu) pour
          // basculer. Sinon on laisse finir : mieux vaut une réponse lente que rien.
          if (shouldFallbackOnSlowTtft(ttft, ttftBudgetMs, producedOutput, chainIndex + 1 < modelChain.length)) {
            log.warn("agent/run", `TTFT ${Math.round(ttft)} ms > budget ${ttftBudgetMs} ms — bascule de modèle`);
            ttftTooSlow = true;
            controller.abort();
            break;
          }
        }

        switch (part.type) {
        case "text-delta":
          producedOutput = true;
          if (firstSignalMs < 0) firstSignalMs = performance.now() - t0;
          outputChars += part.text.length;
          emit({ type: "token", delta: part.text });
          break;

        case "reasoning-delta":
          // Le raisonnement (modèles qui l'exposent) est du contenu visible : il
          // compte comme production pour ne pas rejouer un tour déjà entamé.
          producedOutput = true;
          if (firstSignalMs < 0) firstSignalMs = performance.now() - t0;
          if (part.text) { outputChars += part.text.length; emit({ type: "reasoning", delta: part.text }); }
          break;

        case "tool-call":
          producedOutput = true;
          if (firstSignalMs < 0) firstSignalMs = performance.now() - t0;
          emit({
            type:     "tool-call",
            id:       part.toolCallId,
            toolName: part.toolName,
            args:     (part as { input?: unknown }).input,
          });
          break;

        case "tool-result":
          producedOutput = true;
          emit({
            type:     "tool-result",
            id:       part.toolCallId,
            toolName: part.toolName,
            // Plafond dur : un résultat d'outil volumineux est élidé AVANT d'entrer
            // dans l'historique. C'est le levier principal du temps total — chaque
            // octet conservé ici est repayé en entrée à chaque tour suivant.
            result:   clampToolResult((part as { output?: unknown }).output),
          });
          break;

        case "finish-step":
          emit({ type: "step-finish" });
          break;

        case "finish": {
          producedOutput = true;
          const { inputTokenDetails } = part.totalUsage;
          // `finishReason: "tool-calls"` signifie que le modèle voulait encore
          // appeler un outil mais que `stopWhen` l'a coupé : c'est un arrêt dur,
          // pas une réponse finale. Le rapport de sous-agent doit le refléter.
          if (part.finishReason === "tool-calls") hitStepLimit = true;

          // Trace de latence : émise AVANT `finish` pour que l'hôte puisse
          // l'afficher. `firstSignalMs < 0` (aucun contenu) → TTFT = durée totale.
          {
            const totalMs = performance.now() - t0;
            const ttftMs = firstSignalMs < 0 ? totalMs : firstSignalMs;
            const genMs = Math.max(1, totalMs - ttftMs);
            // ~4 chars/token : suffisant pour un débit relatif fiable.
            const outTokens = Math.ceil(outputChars / 4);
            log.info(
              "agent/timing",
              `model=${currentModelId() || "?"} ttft=${Math.round(ttftMs)}ms total=${Math.round(totalMs)}ms ` +
              `gen=${Math.round(genMs)}ms chars=${outputChars} tok/s=${Math.round((outTokens / (genMs / 1000)) * 10) / 10} ` +
              `fallbacks=${fallbackCount} reason=${part.finishReason}`,
            );
            emit({
              type: "timing",
              ttftMs: Math.round(ttftMs),
              totalMs: Math.round(totalMs),
              genMs: Math.round(genMs),
              outputChars,
              tokPerSec: Math.round((outTokens / (genMs / 1000)) * 10) / 10,
              model: currentModelId(),
              fallbacks: fallbackCount,
            });
          }

          emit({
            type:  "finish",
            usage: {
              inputTokens:         (part.totalUsage.inputTokens  ?? 0) + (initialUsage?.inputTokens  ?? 0),
              outputTokens:        (part.totalUsage.outputTokens ?? 0) + (initialUsage?.outputTokens ?? 0),
              cacheReadTokens:     (inputTokenDetails.cacheReadTokens  ?? 0) + (initialUsage?.cacheReadTokens     ?? 0),
              cacheCreationTokens: (inputTokenDetails.cacheWriteTokens ?? 0) + (initialUsage?.cacheCreationTokens ?? 0),
            },
          });
          break;
        }

        case "error": {
          // Une erreur en plein flux est levée pour être traitée par la boucle de
          // retry ci-dessous (classification permanente / rate-limit / transitoire).
          throw toError(part.error);
        }
      }
      }
    } finally {
      if (firstChunkTimer) clearTimeout(firstChunkTimer);
      if (stallTimer) clearTimeout(stallTimer);
      log.info("agent/run", `stream-end chunks=${chunkCount} après ${Math.round(performance.now() - t0)} ms`);
    }

    // Abort INTERNE (flux muet, flux bloqué, ou TTFT trop lent) : le `break`
    // ci-dessus sort de la boucle sans lever, donc l'appelant ne verrait qu'un
    // « cancelled » et la cascade ne s'appliquerait jamais (bug observé : modèle
    // lent de 12 s gardé jusqu'au bout malgré un budget TTFT de 3 s). On LEVE ici
    // une erreur transiente pour déclencher la classification → bascule/reprise.
    // Le cas « annulation utilisateur » n'arrive pas ici : `userCancelled` est
    // vérifié en amont et le signal externe n'est pas confondu avec ces flags.
    if (ttftTooSlow || firstChunkTimedOut || stalled) {
      throw new Error(
        stalled
          ? "Model stream stalled mid-response (inactivity timeout)"
          : ttftTooSlow
            ? "Model first token timed out (TTFT above budget)"
            : "Model stream produced no output (timeout)",
      );
    }
  };

  (async () => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt++) {
      producedOutput = false;
      hitStepLimit = false;
      firstChunkTimedOut = false;
      ttftTooSlow = false;
      stalled = false;
      try {
        await attemptRun(attempt === 1 ? null : CONTINUATION_REMINDER);
        runStatus = controller.signal.aborted ? "cancelled" : (hitStepLimit ? "max_iterations" : "completed");
        settle();
        return; // terminé proprement
      } catch (e) {
        // Annulation utilisateur → on s'arrête net. Un abort interne (flux muet)
        // ne doit PAS court-circuiter la cascade : on traite l'erreur normalement.
        if (userCancelled) { runStatus = "cancelled"; settle(); return; }
        lastError = e;
      }

      // Abort interne (flux muet, flux bloqué, TTFT trop lent) : on remet un
      // controller neuf pour permettre la tentative suivante, et on force une
      // erreur « transient » lisible afin que la classification/cascade
      // s'applique. Indispensable pour `stalled` : sans nouveau controller, la
      // tentative suivante hériterait d'un signal déjà avorté et sortirait
      // immédiatement sans rien produire.
      if (firstChunkTimedOut || ttftTooSlow || stalled) {
        controller = new AbortController();
        if (!lastError) {
          lastError = new Error(
            stalled
              ? "Model stream stalled mid-response (inactivity timeout)"
              : ttftTooSlow
                ? "Model first token timed out (TTFT above budget)"
                : "Model stream produced no output (timeout)",
          );
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const retryAfter = parseRetryAfter(message.toLowerCase());
      const kind = classifyFailure(message, retryAfter);

      // Santé du modèle : on mémorise les observations pour le routage adaptatif
      // des TOURS SUIVANTS (cf. modelHealth / rankModelChain). Un 429 met le
      // modèle en cooldown — sinon chaque tour recommencerait par lui et
      // gaspillerait un aller-retour sur un modèle qu'on SAIT saturé.
      if (kind === "rate-limited") modelHealth.noteRateLimit(currentModelId());

      log.warn(
        "agent/retry",
        `attempt=${attempt}/${MAX_ATTEMPTS + 1} kind=${kind} retryAfter=${retryAfter ?? "null"} ` +
        `produced=${producedOutput} model=${currentModelId() || "?"} err=${message.slice(0, 300)}`,
      );

      // ── 1. Bascule de modèle (priorité sur le backoff du même modèle) ───────
      // Si un autre modèle est disponible ET que le tour n'a rien produit, on
      // avance dans la cascade et on relance IMMÉDIATEMENT (pas d'attente) :
      // un provider saturé sur un modèle a souvent un autre modèle libre.
      // On ne bascule jamais après du contenu émis (dupliquerait des éditions).
      if (shouldFallback(kind, producedOutput)) {
        const next = nextModelIndex(chainIndex, modelChain.length);
        if (next != null) {
          chainIndex = next;
          fallbackCount++;
          log.warn("agent/cascade", `bascule ${modelIds[chainIndex - 1] || chainIndex} → ${modelIds[next] || next + 1} (${kind})`);
          onEvent({
            type: "notice",
            kind: "retry",
            detail: `Modèle ${modelIds[next] || next + 1} (bascule après ${kind})`,
          });
          onEvent({ type: "token", delta: "" }); // keep-alive : laisse l'UI en streaming
          continue; // nouvelle tentative, sans backoff
        }
        log.warn("agent/cascade", `cascade épuisée (${modelChain.length} modèles) — pas d'autre repli`);
      }

      // ── 2. Backoff sur le même modèle (cascade épuisée ou pas de cascade) ───
      // Rien émis → on peut rejouer à l'identique. Du contenu déjà émis → on ne
      // rejoue pas la requête, mais on autorise un unique tour de continuation.
      const canRetry = !producedOutput || attempt === 1;
      const delay = canRetry ? retryDelayMs(kind, attempt, retryAfter) : null;

      if (delay == null) {
        runStatus = "error";
        log.error("agent/run", `échec définitif après ${attempt} tentative(s) — kind=${kind} : ${message.slice(0, 300)}`);
        log.flush();
        onEvent({ type: "error", message });
        settle();
        return;
      }

      // Signale la reprise à l'UI (bannière « Nouvelle tentative… »).
      log.info("agent/retry", `backoff ${delay}ms (tentative ${attempt + 1}/${MAX_ATTEMPTS + 1})`);
      onEvent({
        type: "notice",
        kind: "retry",
        detail: `Reprise automatique (tentative ${attempt + 1}/${MAX_ATTEMPTS + 1}) — ${kind}`,
      });
      onEvent({ type: "token", delta: "" }); // keep-alive : laisse l'UI en streaming
      await sleep(delay, controller.signal);
      if (userCancelled) { runStatus = "cancelled"; settle(); return; }
    }

    runStatus = "error";
    log.error("agent/run", `échec définitif (toutes tentatives) : ${lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError).slice(0, 300)}`);
    log.flush();
    onEvent({ type: "error", message: lastError instanceof Error ? lastError.message : String(lastError) });
    settle();
  })();

  return {
    cancel: () => { userCancelled = true; controller.abort(); },
    // Issue réelle du run — `max_iterations` n'est PAS un succès. Le parent
    // (root ou hôte d'un sous-agent) la lit après la fin du stream.
    status: () => runStatus,
  };
}

/**
 * Plafond de tokens de sortie pour un appel, borné par la fenêtre restante.
 *
 * Porté de Cline (`resolveGatewayRequestMaxTokens`) : sans plafond, un modèle
 * bavard peut consommer toute la fenêtre restante et se faire couper au milieu
 * d'une édition ou d'un appel d'outil — ce qui coûte un aller-retour complet de
 * reprise. On borne donc à une fraction de la fenêtre restante (30 %, comme
 * Cline `DEFAULT_GATEWAY_MAX_OUTPUT_FRACTION`), avec un plancher pour ne jamais
 * étrangler une réponse légitime.
 *
 * @param estimatedInputTokens entrée estimée du tour (chars/4 + surcoût système)
 * @param windowTokens          fenêtre du modèle (défaut : budget de référence)
 */
export function resolveMaxOutputTokens(
  estimatedInputTokens: number,
  windowTokens = DEFAULT_TOKEN_BUDGET,
  fraction = 0.3,
  reserveTokens = 1_024,
): number {
  const remaining = Math.max(0, windowTokens - estimatedInputTokens - reserveTokens);
  // Plancher : sous 2 000 tokens de sortie on tronquerait des réponses saines.
  return Math.max(2_000, Math.floor(windowTokens * fraction), Math.floor(remaining));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Marque un message comme point de cache fournisseur pour TOUS les providers
 * qui le comprennent, en préservant d'éventuelles options existantes.
 *
 * Pourquoi tous les providers : le harness est agnostique (orvyx est
 * OpenAI-compatible, Anthropic est natif, etc.). Poser le marqueur Anthropic
 * `cacheControl` ne fait rien pour un provider OpenAI-compatible ; inversement,
 * `openai: { promptCacheKey }` ne fait rien pour Anthropic. Chaque provider
 * IGNORE les options qu'il ne connaît pas — envoyer les deux est donc sûr et
 * rend le cache effectif quel que soit le modèle choisi par l'utilisateur.
 */
function markCacheable(existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = existing ?? {};
  return {
    ...base,
    anthropic: { ...(base.anthropic as Record<string, unknown> | undefined), cacheControl: { type: "ephemeral" } },
    openai:    { ...(base.openai as Record<string, unknown> | undefined), promptCacheKey: "origin-agent" },
  };
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
