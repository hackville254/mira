import { loadApiKey, resolveDefaultModel, resolveDefaultProvider } from "../secrets";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../../components/ai/providers";

/**
 * Providers purement locaux : ils ne requièrent AUCUNE clé API (l'authentification
 * est inutile, l'endpoint est sur la machine). Même liste que la génération de
 * commit et le chat : on ne duplique pas le contrat, on le centralise ici.
 */
export const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "vllm"]);

/**
 * Cible d'un appel LLM « utilitaire » (optimisation de prompt, message de commit).
 *
 * `providerId`/`modelId` proviennent du modèle SÉLECTIONNÉ dans la barre de
 * saisie du chat — c'est-à-dire l'`activeProviderIdRef`/`activeModelIdRef` du
 * panneau AI. Objectif : ces actions auxiliaires s'exécutent avec EXACTEMENT le
 * même modèle que celui qui traitera ensuite la demande, sans défaut figé.
 */
export interface ActiveModelTarget {
  providerId: string;
  modelId: string;
  /** Clé API du provider (`null` si absente ou provider local). */
  apiKey: string | null;
  /** Le provider est-il exploitable (clé présente ou provider local) ? */
  usable: boolean;
}

/**
 * Raison d'un échec d'action LLM auxiliaire. Typée pour permettre à l'appelant
 * d'afficher un message PRÉCIS : l'ancien contrat renvoyait un `null` muet qui
 * confondait « rien à décrire » et « provider non configuré », rendant le
 * diagnostic impossible côté utilisateur.
 */
export type LlmActionFailure =
  /** Aucune clé API pour un provider distant → rien n'est envoyé au réseau. */
  | "no-provider"
  /** Le dossier ciblé n'est pas un dépôt git (ex. génération de message de commit). */
  | "not-a-repo"
  /** Le binaire `git` n'a pas pu être lancé (absent du PATH, permissions…). */
  | "git-unavailable"
  /** L'appel IPC vers le backend a échoué (backend en erreur / non enregistré). */
  | "ipc-error"
  /** L'entrée est vide (ex. diff git vide → dépôt propre, brouillon vide). */
  | "empty-input"
  /** L'appel a échoué côté réseau/provider (message dans `detail`). */
  | "call-failed";

/** Résultat d'une action LLM auxiliaire : succès avec texte, ou échec typé. */
export type LlmActionResult =
  | { ok: true; text: string }
  | { ok: false; reason: LlmActionFailure; detail?: string };

/**
 * Résout la cible LLM à utiliser pour une action auxiliaire.
 *
 * Priorité des valeurs, identique au chat : les ids explicitement fournis
 * (sélection courante de l'UI) > `localStorage` (`origin-ai-*`) > `.env` > défaut.
 * La clé API est lue pour le provider RÉSOLU (et non pour un provider deviné) :
 * c'était le bug de l'ancien `optimizePrompt`, qui lisait la clé d'un provider
 * avant même de connaître le modèle effectif.
 *
 * Ne lève jamais : renvoie `usable: false` quand rien n'est configuré, à charge
 * de l'appelant de prévenir l'utilisateur plutôt que d'envoyer au réseau.
 */
export async function resolveActiveModelTarget(
  providerId?: string,
  modelId?: string,
): Promise<ActiveModelTarget> {
  const pid = providerId || (await resolveDefaultProvider(DEFAULT_PROVIDER_ID));
  // Fallback = le modèle par défaut de l'app (un VRAI id de modèle), jamais le
  // providerId : passer un id de provider comme modèle produirait un appel cassé.
  const mid = modelId || (await resolveDefaultModel(DEFAULT_MODEL_ID));
  const apiKey = await loadApiKey(pid);
  const usable = LOCAL_PROVIDER_IDS.has(pid) || !!apiKey;
  return { providerId: pid, modelId: mid, apiKey, usable };
}
