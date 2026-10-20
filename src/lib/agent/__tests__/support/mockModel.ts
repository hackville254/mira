import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";

// ── Harnais de test déterministe pour runAgent ─────────────────────────────────
//
// Ce module construit des `LanguageModel` simulés qui rejouent des scripts de
// streaming RÉELS au format `LanguageModelV3StreamPart` (le format bas niveau
// consommé par `streamText`). Le but est d'exercer la VRAIE boucle de `runAgent`
// (tool-loop, cascade, timeouts, clamp, abort) sans réseau et sans payer d'API.
//
// ATTENTION : un modèle simulé valide le COMPORTEMENT DU HARNAIS, pas
// l'intelligence d'un modèle. Un scénario « le modèle doit s'abstenir » vérifie
// que notre boucle transmet correctement le choix du modèle, pas que le modèle
// réel choisirait bien.

/** Un script = une « réponse » de modèle, jouée au tour numéro `callIndex`. */
export type StreamScript = (callIndex: number) => {
  chunks: LanguageModelV3StreamPart[];
  /** Délai initial avant le premier chunk (ms) — pour tester les gardes. */
  initialDelayInMs?: number | null;
  /** Délai entre chaque chunk (ms). */
  chunkDelayInMs?: number | null;
};

/** Usage par défaut, réaliste mais minimal. */
function makeUsage(input = 100, output = 20): LanguageModelV3Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** Fin de flux : `finishReason.unified` doit refléter l'issue réelle. */
function finish(
  reason: "stop" | "tool-calls" | "length" | "error",
  usage: LanguageModelV3Usage = makeUsage(),
): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified: reason, raw: undefined }, usage };
}

/** Un chunk texte simple (start → delta → end). */
export function textChunks(id: string, text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

/** Un chunk appel d'outil : input-string JSON, comme un vrai provider. */
export function toolCallChunk(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV3StreamPart {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input: typeof input === "string" ? input : JSON.stringify(input),
  };
}

/** Réponse finale : texte + finish("stop"). */
export function finalText(text: string, usage?: LanguageModelV3Usage): LanguageModelV3StreamPart[] {
  return [...textChunks("txt", text), finish("stop", usage)];
}

/** Tour d'appel d'outil : (optionnel) texte + tool-call + finish("tool-calls"). */
export function toolCallTurn(
  calls: Array<{ id: string; name: string; input: unknown }>,
  opts?: { text?: string; usage?: LanguageModelV3Usage },
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  if (opts?.text) parts.push(...textChunks("txt", opts.text));
  for (const c of calls) parts.push(toolCallChunk(c.id, c.name, c.input));
  parts.push(finish("tool-calls", opts?.usage));
  return parts;
}

/** Chunk `error` en plein flux — pour tester la classification des échecs. */
export function errorChunk(message: string): LanguageModelV3StreamPart[] {
  return [{ type: "error", error: new Error(message) }];
}

/**
 * Construit un modèle simulé qui joue `scripts[i]` au i-ème appel `doStream`.
 * Au-delà du dernier script, rejoue le dernier (utile pour les boucles).
 *
 * Le délai simulé respecte le signal d'abort RÉEL transmis par le SDK
 * (`options.abortSignal`, héritée de `streamText({ abortSignal })`) : il rejette
 * immédiatement à l'abort. C'est indispensable car `simulateReadableStream` ne
 * gère PAS l'annulation nativement — sans cela, le `await delay(...)` du flux
 * resterait bloqué même après un `controller.abort()` de `runAgent` (les gardes
 * anti-flux-muet / d'inactivité ne pourraient jamais débloquer la boucle, ce qui
 * produisait de faux timeouts de test).
 */
export function scriptedModel(
  scripts: StreamScript[],
  modelId = "mock-model",
): LanguageModel {
  const doStreamCalls: Parameters<NonNullable<MockLanguageModelV3["doStream"]>>[0][] = [];
  const doStream: NonNullable<MockLanguageModelV3["doStream"]> = async (options) => {
    const callIndex = doStreamCalls.length;
    doStreamCalls.push(options);
    const script = scripts[Math.min(callIndex, scripts.length - 1)](callIndex);
    // Signal RÉEL du run en cours : recréé à chaque tentative, il reflète les
    // aborts internes (gardes) comme l'annulation utilisateur.
    const signal = options.abortSignal ?? undefined;
    return {
      stream: simulateReadableStream({
        chunks: script.chunks,
        initialDelayInMs: script.initialDelayInMs ?? null,
        chunkDelayInMs: script.chunkDelayInMs ?? null,
        _internal: { delay: abortableDelay(signal) },
      }),
    };
  };
  const model = new MockLanguageModelV3({ modelId, doStream });
  (model as unknown as { _doStreamCalls: typeof doStreamCalls })._doStreamCalls = doStreamCalls;
  return model as unknown as LanguageModel;
}

/**
 * Délai qui rejette immédiatement si le signal est avorté — nécessaire car
 * `simulateReadableStream` n'a pas de gestion d'annulation et resterait bloqué
 * dans son `await delay(...)` après un `controller.abort()` de `runAgent`.
 */
function abortableDelay(signal?: AbortSignal) {
  return (ms: number | null): Promise<void> => {
    if (ms == null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      const t = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); reject(new DOMException("aborted", "AbortError")); };
      const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/** Nombre d'appels `doStream` réellement effectués sur un modèle du harnais. */
export function streamCallCount(model: LanguageModel): number {
  return ((model as unknown as { _doStreamCalls?: unknown[] })._doStreamCalls ?? []).length;
}

/**
 * Modèle qui échoue les `failTimes` PREMIERS appels `doStream` (erreur jetée
 * hors flux, comme un 429/5xx au niveau HTTP), puis réussit.
 */
export function flakyModel(
  failTimes: number,
  failMessage: string,
  successScript: StreamScript,
  modelId = "flaky-model",
): LanguageModel {
  let calls = 0;
  const doStream: NonNullable<MockLanguageModelV3["doStream"]> = async (options) => {
    const n = calls++;
    if (n < failTimes) throw new Error(failMessage);
    const script = successScript(n);
    return {
      stream: simulateReadableStream({
        chunks: script.chunks,
        initialDelayInMs: script.initialDelayInMs ?? null,
        chunkDelayInMs: script.chunkDelayInMs ?? null,
        _internal: { delay: abortableDelay(options.abortSignal ?? undefined) },
      }),
    };
  };
  const model = new MockLanguageModelV3({ modelId, doStream });
  return model as unknown as LanguageModel;
}

/**
 * Modèle qui ne respecte pas ses délais réels (les gardes de runAgent se basent
 * sur le temps mural). `initialDelayInMs` est donc appliqué par
 * `simulateReadableStream` — mais nos scénarios de timeout utilisent de très
 * petites valeurs pour rester rapides.
 */
export { finish, makeUsage };
