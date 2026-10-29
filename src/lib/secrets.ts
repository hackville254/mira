import { invoke } from '@tauri-apps/api/core';
import { resolveMiraModel, MIRA_MODEL_PREFIX } from './agent/miraModels';

// Accounts are namespaced as "provider:<providerId>" e.g. "provider:anthropic"
function accountKey(providerId: string) {
  return `provider:${providerId}`;
}

/**
 * Cache mémoire des clés API lues depuis le keychain OS.
 *
 * `loadApiKey` était appelé à CHAQUE tour et faisait un aller-retour IPC +
 * accès keychain avant le premier token : c'est un coût de TTFT pur, alors que
 * la clé d'un provider ne change pas en cours de session. On mémorise donc la
 * valeur par provider (y compris `null` = clé absente, pour ne pas re-sonder le
 * keychain à chaque tour). `saveApiKey` / `deleteApiKey` invalident l'entrée,
 * ce qui garde le cache cohérent avec toute modification faite dans l'UI.
 *
 * Sécurité : la clé reste en mémoire de processus, jamais écrite sur disque ni
 * dans un bundle. Elle n'est lue qu'au moment de construire le client LLM.
 */
const apiKeyCache = new Map<string, string | null>();

export async function saveApiKey(providerId: string, secret: string): Promise<void> {
  await invoke('set_secret', { account: accountKey(providerId), secret });
  apiKeyCache.set(providerId, secret);
}

export async function loadApiKey(providerId: string): Promise<string | null> {
  if (apiKeyCache.has(providerId)) return apiKeyCache.get(providerId) ?? null;
  const key = await invoke<string | null>('get_secret', { account: accountKey(providerId) });
  apiKeyCache.set(providerId, key ?? null);
  return key;
}

export async function deleteApiKey(providerId: string): Promise<void> {
  await invoke('delete_secret', { account: accountKey(providerId) });
  apiKeyCache.set(providerId, null);
}

/**
 * Configuration AI de développement lue depuis le `.env` par le backend Rust.
 *
 * Fallback uniquement : sert à tester sans passer par l'UI. Les valeurs saisies
 * dans l'app (keychain OS + localStorage) restent prioritaires. En build
 * release, `configured` vaut toujours `false` (le backend ignore le `.env`).
 *
 * La clé n'est éventuellement renvoyée que pour le provider configuré ; elle
 * ne transite jamais par un bundle JS (elle vient d'un `invoke`).
 */
export interface DevAiConfig {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  /** Liste ordonnée d'ids de modèles autorisés (cascade rate-limit). */
  allowedModels: string | null;
  configured: boolean;
}

const EMPTY_DEV_CONFIG: DevAiConfig = {
  provider: null,
  model: null,
  apiKey: null,
  baseUrl: null,
  allowedModels: null,
  configured: false,
};

let devConfigPromise: Promise<DevAiConfig> | null = null;

/** Lecture mémoïsée de la config de dev (une seule invocation par session). */
export function loadDevAiConfig(): Promise<DevAiConfig> {
  if (!devConfigPromise) {
    devConfigPromise = invoke<DevAiConfig>('dev_ai_config').catch(() => EMPTY_DEV_CONFIG);
  }
  return devConfigPromise;
}

/** Provider par défaut, priorité : localStorage > `.env` > fallback fourni. */
export async function resolveDefaultProvider(fallback: string): Promise<string> {
  const stored = localStorage.getItem('origin-ai-provider');
  if (stored) return stored;
  const dev = await loadDevAiConfig();
  return dev.provider ?? fallback;
}

/**
 * Modèle par défaut, priorité : localStorage > `.env` > fallback fourni.
 *
 * Si le `.env` définit le provider ET le modèle mais que l'UI a mémorisé un
 * autre provider, le modèle du `.env` ne s'applique pas (il ne vaut que pour
 * son provider) : on retombe sur le fallback.
 */
export async function resolveDefaultModel(fallback: string): Promise<string> {
  const stored = localStorage.getItem('origin-ai-model');
  if (stored) return stored;
  const dev = await loadDevAiConfig();
  if (!dev.model) return fallback;
  const storedProvider = localStorage.getItem('origin-ai-provider');
  // Le modèle du `.env` n'est cohérent qu'avec son propre provider.
  if (storedProvider && dev.provider && storedProvider !== dev.provider) return fallback;
  return dev.model;
}

/**
 * Résout le COUPLE (provider, modèle) par défaut, en tenant compte des modèles
 * Mira.
 *
 * POURQUOI ce n'est pas fait dans `resolveDefaultProvider`/`resolveDefaultModel`
 * séparément : un modèle Mira a besoin que le provider ET le modèle soient
 * cohérents. Si le `.env` déclare un provider Mira, le provider par défaut doit
 * être la CLÉ du modèle principal (`mira-<id>`) et non le nom interne du
 * provider — sinon le sélecteur ne reconnaîtrait pas la sélection au démarrage.
 *
 * Priorité : sélection mémorisée > défaut Mira (`.env`) > défauts fournis.
 */
export async function resolveDefaultTarget(
  fallbackProvider: string,
  fallbackModel: string,
): Promise<{ providerId: string; modelId: string }> {
  const storedProvider = localStorage.getItem('origin-ai-provider');
  const storedModel = localStorage.getItem('origin-ai-model');
  if (storedProvider && storedModel) return { providerId: storedProvider, modelId: storedModel };

  const dev = await loadDevAiConfig();
  if (dev.provider && dev.model) {
    // Défaut fourni par Mira : c'est le modèle principal du catalogue.
    const mira = await resolveMiraModel(`${MIRA_MODEL_PREFIX}${dev.model}`);
    if (mira) return { providerId: mira.key, modelId: mira.key };
    return { providerId: storedProvider ?? dev.provider, modelId: storedModel ?? dev.model };
  }
  return {
    providerId: storedProvider ?? fallbackProvider,
    modelId: storedModel ?? fallbackModel,
  };
}

/**
 * Liste brute des modèles autorisés (cascade), priorité : localStorage > `.env`.
 *
 * Renvoie la chaîne brute séparée par des virgules (ou null). Le découpage /
 * dédup est fait par `parseAllowedModels` du module `modelCascade`, pour garder
 * la logique de cascade testable et centralisée.
 */
export async function resolveAllowedModels(): Promise<string | null> {
  const stored = localStorage.getItem('origin-ai-allowed-models');
  if (stored) return stored;
  const dev = await loadDevAiConfig();
  return dev.allowedModels ?? null;
}
