import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { tauriFetch } from "../tauri-fetch";
import { findCustomModel, isCustomModelKey, toClientType, type ApiFormat } from "./customModels";
import { isMiraModelKey, MIRA_PROVIDER_ID } from "./miraModels";

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../ai/modelDefaults";

/**
 * Providers NATIFS que le moteur connaît sous leur propre nom : il applique sa
 * base URL par défaut et son protocole. Ils restent disponibles pour les
 * actions internes (aucun catalogue n'est exposé à l'utilisateur pour autant).
 */
const CLINE_NATIVE_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  gemini: "google",
};

/** Base URL OpenAI par défaut (le SDK l'applique déjà, on la rend explicite). */
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export interface ClineProviderConfig {
  /** Identifiant de provider tel que le SDK d'agent l'attend. */
  providerId: string;
  /**
   * Base URL à surcharger, ou `undefined` pour laisser le SDK appliquer son
   * défaut (providers natifs). Ne JAMAIS transmettre une chaîne vide.
   */
  baseUrl: string | undefined;
  /**
   * `clientType` du SDK : c'est LUI qui choisit le protocole de transport
   * (`openai-compatible`, `openai`, `anthropic`). Omis = déduit du providerId.
   */
  clientType?: string;
  /** Plafond de tours d'outils (modèles personnalisés). */
  maxIterations?: number;
}

/**
 * Traduit une CIBLE (modèle Mira, modèle personnalisé OU provider natif) en
 * configuration compréhensible par le moteur d'agent.
 *
 * Ordre de résolution :
 *   1. Modèle personnalisé (déclaré par le client) : il porte TOUT (URL, format).
 *   2. Modèle Mira (`mira-<id>`) : provider interne, base URL = celle de Mira.
 *   3. Provider natif (usage interne uniquement).
 *
 * Lève une erreur pour une cible inconnue : mieux vaut échouer franchement que
 * d'envoyer une requête au mauvais endpoint.
 */
export function resolveClineProvider(modelKeyOrProviderId: string): ClineProviderConfig {
  const custom = findCustomModel(modelKeyOrProviderId);
  if (custom) {
    return {
      // Le moteur route par `clientType` : l'id de provider libre est accepté.
      providerId: modelKeyOrProviderId,
      baseUrl: custom.baseUrl,
      clientType: toClientType(custom.apiFormat),
      ...(custom.toolCallRounds ? { maxIterations: custom.toolCallRounds } : {}),
    };
  }

  // Modèles Mira : un seul provider, protocole OpenAI-compatible. La base URL
  // est récupérée à l'exécution (elle vient de la config Mira, pas d'un
  // catalogue figé côté front) ; on retombe sur le provider Mira si absente.
  if (isMiraModelKey(modelKeyOrProviderId)) {
    return { providerId: MIRA_PROVIDER_ID, baseUrl: undefined, clientType: "openai-compatible" };
  }

  const native = CLINE_NATIVE_PROVIDERS[modelKeyOrProviderId];
  if (native) return { providerId: native, baseUrl: undefined };

  if (modelKeyOrProviderId === "openai") {
    return { providerId: "openai-compatible", baseUrl: OPENAI_DEFAULT_BASE };
  }

  if (isCustomModelKey(modelKeyOrProviderId)) {
    throw new Error(`Unknown custom model: ${modelKeyOrProviderId}`);
  }

  // Provider « vase communicant » hérité : plus de catalogue, donc plus de base
  // URL connue. On refuse explicitement plutôt que de deviner une destination.
  throw new Error(`Unknown provider for the agent: ${modelKeyOrProviderId}`);
}

/**
 * Construit un `LanguageModel` pour les actions utilitaires (résumé de
 * compaction, message de commit, édition inline, optimisation de prompt).
 *
 * Les modèles personnalisés sont reconnus par leur clé préfixée et routés
 * selon leur format d'API ; le provider Mira pointe vers l'endpoint Mira ;
 * les providers natifs gardent leur SDK dédié.
 */
export function buildLanguageModel(
  modelKeyOrProviderId: string,
  modelId: string,
  apiKey: string,
  miraBaseUrl?: string,
): LanguageModel {
  const custom = findCustomModel(modelKeyOrProviderId);
  if (custom) return buildCustomLanguageModel(custom.apiFormat, custom.baseUrl, modelId, apiKey);

  // Provider Mira : endpoint OpenAI-compatible fourni par Mira.
  if (modelKeyOrProviderId === MIRA_PROVIDER_ID) {
    if (!miraBaseUrl) throw new Error("Mira provider is not configured (missing base URL)");
    return buildCustomLanguageModel("openai-chat", miraBaseUrl, modelId, apiKey);
  }

  switch (modelKeyOrProviderId) {
    case "anthropic":
      return createAnthropic({ apiKey, fetch: tauriFetch })(modelId);

    case "openai":
      return createOpenAI({ apiKey, fetch: tauriFetch })(modelId);

    case "gemini":
      return createGoogleGenerativeAI({ apiKey, fetch: tauriFetch })(modelId);
  }

  throw new Error(`Unknown model target: ${modelKeyOrProviderId}`);
}

/** Fabrique le client AI SDK correspondant au format d'API déclaré. */
function buildCustomLanguageModel(
  format: ApiFormat,
  baseUrl: string,
  modelId: string,
  apiKey: string,
): LanguageModel {
  switch (format) {
    case "anthropic":
      // L'AI SDK Anthropic attend la RACINE de l'API (il ajoute `/v1/messages`) :
      // on retire donc un éventuel suffixe `/v1` laissé collé par l'utilisateur.
      return createAnthropic({
        apiKey: apiKey || "no-key",
        baseURL: baseUrl.replace(/\/v1\/?$/, "") || baseUrl,
        fetch: tauriFetch,
      })(modelId);

    case "openai-responses":
      return createOpenAI({ apiKey: apiKey || "no-key", baseURL: baseUrl, fetch: tauriFetch })
        .responses(modelId);

    case "openai-chat":
    default:
      return createOpenAICompatible({
        name: "custom",
        baseURL: baseUrl,
        apiKey: apiKey || "no-key",
        fetch: tauriFetch,
      })(modelId);
  }
}
