import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { tauriFetch } from "../tauri-fetch";

export const OPENAI_COMPAT_BASE: Record<string, string> = {
  orvyx:      "https://api.orvyx-ai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek:   "https://api.deepseek.com",
  mistral:    "https://api.mistral.ai/v1",
  groq:       "https://api.groq.com/openai/v1",
  xai:        "https://api.x.ai/v1",
  cohere:     "https://api.cohere.com/compatibility/v1",
  lmstudio:   "http://localhost:1234/v1",
  vllm:       "http://localhost:8000/v1",
  ollama:     "http://localhost:11434/v1",
};

/**
 * Providers à protocole NATIF (non OpenAI Chat Completions). Le SDK Cline les
 * connaît sous leur propre identifiant et applique SA base URL par défaut : il
 * ne faut donc PAS leur passer la base OpenAI-compatible d'Origin (le protocole
 * resterait celui du provider, mais l'URL serait fausse → appel cassé).
 */
const CLINE_NATIVE_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  gemini: "google",
};

/** Base URL OpenAI par défaut (le SDK l'applique déjà, on la rend explicite). */
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export interface ClineProviderConfig {
  /** Identifiant de provider tel que le SDK Cline l'attend. */
  providerId: string;
  /**
   * Base URL à surcharger, ou `undefined` pour laisser le SDK appliquer son
   * défaut (cas des providers natifs comme Anthropic / Gemini).
   */
  baseUrl: string | undefined;
}

/**
 * Traduit un provider Origin en configuration compréhensible par le SDK Cline.
 *
 * Le SDK route selon le `providerId` : les endpoints OpenAI Chat Completions
 * (Orvyx et tout vase communicant) doivent passer par `"openai-compatible"` avec
 * leur `baseUrl` ; les providers natifs (Anthropic, Gemini) gardent leur
 * protocole et donc leur base URL par défaut.
 *
 * Lève une erreur pour un provider inconnu : mieux vaut échouer franchement que
 * d'envoyer une requête au mauvais endpoint.
 */
export function resolveClineProvider(providerId: string): ClineProviderConfig {
  const native = CLINE_NATIVE_PROVIDERS[providerId];
  if (native) return { providerId: native, baseUrl: undefined };

  if (providerId === "openai") return { providerId: "openai-compatible", baseUrl: OPENAI_DEFAULT_BASE };

  const base = OPENAI_COMPAT_BASE[providerId];
  if (base) return { providerId: "openai-compatible", baseUrl: base };

  throw new Error(`Unknown provider for Cline: ${providerId}`);
}

export function buildLanguageModel(
  providerId: string,
  modelId: string,
  apiKey: string,
): LanguageModel {
  switch (providerId) {
    case "anthropic":
      return createAnthropic({ apiKey, fetch: tauriFetch })(modelId);

    case "openai":
      return createOpenAI({ apiKey, fetch: tauriFetch })(modelId);

    case "gemini":
      return createGoogleGenerativeAI({ apiKey, fetch: tauriFetch })(modelId);

    default: {
      const baseURL = OPENAI_COMPAT_BASE[providerId];
      if (!baseURL) throw new Error(`Unknown provider: ${providerId}`);
      return createOpenAICompatible({
        name: providerId,
        baseURL,
        apiKey: apiKey || "no-key",
        fetch: tauriFetch,
      })(modelId);
    }
  }
}
