import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { LanguageModel } from "ai";
import type { PendingAction } from "./tools";
import type { UsageData } from "../ai";
import { compactHistory } from "./compactHistory";
import { budgetLevel, emergencyTruncateToolResults, estimateTokensWithOverhead, CRITICAL_THRESHOLD, DEFAULT_TOKEN_BUDGET } from "./tokenBudget";
import {
  classifyFailure, parseRetryAfter, retryDelayMs, CONTINUATION_REMINDER, MAX_ATTEMPTS,
} from "./retry";

// ── Event types ────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "token";             delta: string; spawnId?: string }
  | { type: "reasoning";         delta: string; spawnId?: string }
  | { type: "tool-call";         id: string; toolName: string; args: unknown; spawnId?: string }
  | { type: "tool-result";       id: string; toolName: string; result: unknown; spawnId?: string }
  | { type: "approval-required"; id: string; action: PendingAction; approve: () => void; reject: () => void }
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
  | { type: "error";             message: string };

/** Issue d'un sous-agent — reflète un budget dur atteint ou une fin normale. */
export type SubAgentStatus = "completed" | "max_iterations" | "max_tokens" | "timeout" | "error" | "cancelled";

// ── runAgent ───────────────────────────────────────────────────────────────────

export interface RunAgentOptions {
  model:        LanguageModel;
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
    initialUsage,
    abortSignal,
    onSettled,
  } = options;
  const controller = new AbortController();

  // Propagation parent → enfant : si le run parent (ou l'hôte du sous-agent)
  // annule son signal, on coupe le stream. Les deux déclencheurs sont équivalents.
  if (abortSignal) {
    if (abortSignal.aborted) controller.abort();
    else abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
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
        ? { role: "system", content: systemPrompt, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
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
        onEvent({
          type: "notice",
          kind: "compaction",
          detail: level === "critical" ? "Contexte critique : compaction + troncature" : "Compaction de l'historique",
          savedTokens: saved,
        });
      }
    }

    if (cacheSystem && historyMsgs.length > 0) {
      const last = historyMsgs[historyMsgs.length - 1];
      const lastWithOptions = last as ModelMessage & { providerOptions?: { anthropic?: Record<string, unknown> } };
      historyMsgs[historyMsgs.length - 1] = {
        ...last,
        providerOptions: {
          ...(lastWithOptions.providerOptions ?? {}),
          anthropic: {
            ...(lastWithOptions.providerOptions?.anthropic ?? {}),
            cacheControl: { type: "ephemeral" },
          },
        },
      } as ModelMessage;
    }

    // Rappel système de reprise (tour de retry uniquement) — jamais persisté.
    const allMessages: ModelMessage[] = extraReminder
      ? [sysMsg, ...historyMsgs, { role: "user", content: extraReminder } as ModelMessage]
      : [sysMsg, ...historyMsgs];

    const result = streamText({
      model,
      messages:    allMessages,
      tools:       guardedTools,
      stopWhen:    stepCountIs(maxSteps),
      abortSignal: controller.signal,
    });

    for await (const part of result.fullStream) {
      if (controller.signal.aborted) break;

      switch (part.type) {
        case "text-delta":
          producedOutput = true;
          onEvent({ type: "token", delta: part.text });
          break;

        case "reasoning-delta":
          // Le raisonnement (modèles qui l'exposent) est du contenu visible : il
          // compte comme production pour ne pas rejouer un tour déjà entamé.
          producedOutput = true;
          if (part.text) onEvent({ type: "reasoning", delta: part.text });
          break;

        case "tool-call":
          producedOutput = true;
          onEvent({
            type:     "tool-call",
            id:       part.toolCallId,
            toolName: part.toolName,
            args:     (part as { input?: unknown }).input,
          });
          break;

        case "tool-result":
          producedOutput = true;
          onEvent({
            type:     "tool-result",
            id:       part.toolCallId,
            toolName: part.toolName,
            result:   (part as { output?: unknown }).output,
          });
          break;

        case "finish-step":
          onEvent({ type: "step-finish" });
          break;

        case "finish": {
          producedOutput = true;
          const { inputTokenDetails } = part.totalUsage;
          // `finishReason: "tool-calls"` signifie que le modèle voulait encore
          // appeler un outil mais que `stopWhen` l'a coupé : c'est un arrêt dur,
          // pas une réponse finale. Le rapport de sous-agent doit le refléter.
          if (part.finishReason === "tool-calls") hitStepLimit = true;
          onEvent({
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
  };

  (async () => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt++) {
      producedOutput = false;
      hitStepLimit = false;
      try {
        await attemptRun(attempt === 1 ? null : CONTINUATION_REMINDER);
        runStatus = controller.signal.aborted ? "cancelled" : (hitStepLimit ? "max_iterations" : "completed");
        settle();
        return; // terminé proprement
      } catch (e) {
        if (controller.signal.aborted) { runStatus = "cancelled"; settle(); return; }
        lastError = e;
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const retryAfter = parseRetryAfter(message.toLowerCase());
      const kind = classifyFailure(message, retryAfter);

      // Rien émis → on peut rejouer à l'identique. Du contenu déjà émis → on ne
      // rejoue pas la requête, mais on autorise un unique tour de continuation.
      const canRetry = !producedOutput || attempt === 1;
      const delay = canRetry ? retryDelayMs(kind, attempt, retryAfter) : null;

      if (delay == null) {
        runStatus = "error";
        onEvent({ type: "error", message });
        settle();
        return;
      }

      // Signale la reprise à l'UI (bannière « Nouvelle tentative… »).
      onEvent({
        type: "notice",
        kind: "retry",
        detail: `Reprise automatique (tentative ${attempt + 1}/${MAX_ATTEMPTS + 1}) — ${kind}`,
      });
      onEvent({ type: "token", delta: "" }); // keep-alive : laisse l'UI en streaming
      await sleep(delay, controller.signal);
      if (controller.signal.aborted) { runStatus = "cancelled"; settle(); return; }
    }

    runStatus = "error";
    onEvent({ type: "error", message: lastError instanceof Error ? lastError.message : String(lastError) });
    settle();
  })();

  return {
    cancel: () => controller.abort(),
    // Issue réelle du run — `max_iterations` n'est PAS un succès. Le parent
    // (root ou hôte d'un sous-agent) la lit après la fin du stream.
    status: () => runStatus,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
