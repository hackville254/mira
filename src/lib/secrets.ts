import { invoke } from '@tauri-apps/api/core';

// Accounts are namespaced as "provider:<providerId>" e.g. "provider:anthropic"
function accountKey(providerId: string) {
  return `provider:${providerId}`;
}

export async function saveApiKey(providerId: string, secret: string): Promise<void> {
  await invoke('set_secret', { account: accountKey(providerId), secret });
}

export async function loadApiKey(providerId: string): Promise<string | null> {
  return invoke<string | null>('get_secret', { account: accountKey(providerId) });
}

export async function deleteApiKey(providerId: string): Promise<void> {
  await invoke('delete_secret', { account: accountKey(providerId) });
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
  configured: boolean;
}

const EMPTY_DEV_CONFIG: DevAiConfig = {
  provider: null,
  model: null,
  apiKey: null,
  baseUrl: null,
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
