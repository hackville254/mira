import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Compte Mira : connexion du poste au plan de contrôle (device flow OAuth 2.0)
 * et synchronisation de ce que Mira fournit (clé Orvyx + catalogue de modèles).
 *
 * Concept produit : Mira est payant et fournit SES modèles. Pour que le poste
 * puisse les utiliser, il lui faut (1) la clé Orvyx du compte et (2) la liste
 * des modèles. Les deux viennent du plan de contrôle — jamais du `.env`, qui
 * n'est qu'un confort de dev.
 *
 * Sécurité : le token d'accès et le secret Orvyx ne transitent JAMAIS par ce
 * module. Ils restent côté Rust (`cloud.rs`), qui les range dans le keychain OS.
 * L'UI ne voit que des métadonnées non sensibles (code utilisateur, plan,
 * empreinte de clé).
 */

/** Catalogue Mira synchronisé, mis en cache local pour un démarrage à froid. */
const CATALOG_STORAGE_KEY = "mira-cloud-models";

/** Métadonnées de compte, non sensibles, mémorisées pour l'affichage. */
const ACCOUNT_STORAGE_KEY = "mira-cloud-account";

/**
 * Événement émis quand l'état de connexion change (connexion, rafraîchissement,
 * déconnexion). Permet aux composants qui affichent l'identité (sidebar des
 * réglages) de se mettre à jour sans rechargement ni polling.
 */
export const CLOUD_ACCOUNT_EVENT = "mira-cloud-account-changed";

function emitAccountChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CLOUD_ACCOUNT_EVENT));
}

/** Ce que le poste sait de la fourniture Mira, sans secret. */
export interface CloudAccount {
  email: string | null;
  plan: string | null;
  /** Empreinte de la clé provisionnée (jamais la clé elle-même). */
  keyFingerprint: string | null;
  maskedHint: string | null;
  budgetUsd: number | null;
}

/** Un modèle Mira tel que servi par le plan de contrôle. */
export interface CloudModel {
  id: string;
  display_name: string;
}

/** Démarrage d'un device flow : ce que l'UI doit montrer à l'utilisateur. */
export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Résultat d'un poll de device flow. */
export type PollOutcome =
  | { outcome: "pending"; interval: number }
  | { outcome: "approved" }
  | { outcome: "denied" }
  | { outcome: "expired" };

/**
 * Démarre un device flow et renvoie le code à afficher. Le `device_code` reste
 * côté Rust : l'UI ne peut donc pas le rejouer ni le falsifier.
 */
export async function startDeviceFlow(label?: string): Promise<DeviceStart> {
  const raw = await invoke<{
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>("cloud_device_start", { clientLabel: label ?? null });
  return {
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    verificationUriComplete: raw.verification_uri_complete,
    expiresIn: raw.expires_in,
    interval: raw.interval,
  };
}

/** Interroge l'état du device flow courant (les jetons restent côté Rust). */
export async function pollDeviceFlow(): Promise<PollOutcome> {
  const raw = await invoke<
    { pending: { interval: number } } | "approved" | "denied" | "expired"
  >("cloud_device_poll");
  if (typeof raw === "string") return { outcome: raw };
  return { outcome: "pending", interval: raw.pending.interval };
}

/**
 * Boucle de polling jusqu'à un état terminal.
 *
 * `interval` est imposé par le serveur (protection anti-brute-force) : on le
 * respecte strictement. `signal` permet à l'UI d'annuler proprement (fermeture
 * de la modale) sans laisser de boucle orpheline.
 */
export async function waitForApproval(
  signal?: AbortSignal,
  onTick?: (secondsLeft: number) => void,
): Promise<"approved" | "denied" | "expired" | "cancelled"> {
  let intervalMs = 5000;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    const res = await pollDeviceFlow();
    if (res.outcome === "approved") return "approved";
    if (res.outcome === "denied") return "denied";
    if (res.outcome === "expired") return "expired";
    intervalMs = res.interval * 1000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    onTick?.(intervalMs / 1000);
  }
}

/**
 * Provisionne la clé Orvyx du compte (rangée côté Rust dans le keychain OS) et
 * renvoie ses métadonnées non sensibles.
 */
export async function provisionKey(deviceLabel?: string): Promise<CloudAccount> {
  const raw = await invoke<{
    key_fingerprint: string;
    masked_hint: string;
    budget_usd: number;
  }>("cloud_provision_key", { deviceLabel: deviceLabel ?? null });
  const account: CloudAccount = {
    email: null,
    plan: null,
    keyFingerprint: raw.key_fingerprint,
    maskedHint: raw.masked_hint,
    budgetUsd: raw.budget_usd,
  };
  saveAccount(account);
  emitAccountChanged();
  return account;
}

/** Vrai si une session cloud est active (jeton en mémoire côté Rust). */
export async function isSignedIn(): Promise<boolean> {
  const raw = await invoke<{ signed_in: boolean }>("cloud_status");
  return raw.signed_in;
}

/** Récupère le catalogue Mira du plan de contrôle et le met en cache local. */
export async function syncModels(): Promise<CloudModel[]> {
  const models = await invoke<CloudModel[]>("cloud_fetch_models");
  saveCatalog(models);
  return models;
}

/** Efface la session cloud côté poste (sans révoquer la clé Orvyx). */
export async function signOut(): Promise<void> {
  await invoke("cloud_sign_out");
  localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  emitAccountChanged();
}

/**
 * Orchestre une connexion complète : device flow → approbation → provision de
 * la clé → synchronisation du catalogue.
 *
 * C'est la SEULE implémentation du flow : la page Réglages et la modale du
 * TitleBar l'appellent toutes les deux, ce qui évite que les deux chemins
 * d'entrée divergent (un correctif de sécurité doit profiter aux deux).
 *
 * `onStarted` reçoit le code utilisateur dès qu'il est disponible, pour que
 * l'appelant l'affiche pendant l'attente. `signal` annule le polling.
 *
 * Renvoie l'issue du flow. Ne lève jamais pour un refus ou une expiration :
 * ce sont des issues normales, remontées via la valeur de retour (seules les
 * erreurs réseau/backend lèvent).
 */
export async function runDeviceSignIn(options?: {
  label?: string;
  signal?: AbortSignal;
  onStarted?: (flow: DeviceStart) => void;
}): Promise<"approved" | "denied" | "expired" | "cancelled"> {
  const flow = await startDeviceFlow(options?.label);
  options?.onStarted?.(flow);
  const result = await waitForApproval(options?.signal);
  if (result === "approved") {
    await provisionKey(options?.label);
    await syncModels();
  }
  return result;
}

// ── Cache local (démarrage à froid, affichage) ───────────────────────────────

/** Catalogue Mira mémorisé, ou `null` si jamais synchronisé. */
export function loadCachedCatalog(): CloudModel[] | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((m): m is CloudModel => !!m && typeof m.id === "string")
      .map(m => ({ id: m.id, display_name: typeof m.display_name === "string" ? m.display_name : m.id }));
  } catch {
    // Cache corrompu : on l'ignore plutôt que de faire échouer le démarrage.
    return null;
  }
}

function saveCatalog(models: CloudModel[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(models));
}

/** Métadonnées de compte mémorisées (affichage), ou `null`. */
export function loadAccount(): CloudAccount | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudAccount;
  } catch {
    return null;
  }
}

function saveAccount(account: CloudAccount): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

// ── Hook React ───────────────────────────────────────────────────────────────

/** État de compte exposé à l'UI : déconnecté, ou avec les métadonnées connues. */
export interface AccountState {
  /** `true` si une session cloud est active (jeton en mémoire côté Rust). */
  signedIn: boolean;
  /** Métadonnées non sensibles, ou `null` si jamais connecté. */
  account: CloudAccount | null;
  /** `true` tant que l'état initial n'a pas été résolu (évite un flash). */
  loading: boolean;
}

/**
 * Suit l'état de connexion Mira, réactif aux changements (connexion,
 * déconnexion, rafraîchissement) via `CLOUD_ACCOUNT_EVENT`.
 *
 * `signedIn` vient d'une source fiable — la présence d'un jeton côté Rust — et
 * non du cache local : un `localStorage` résiduel ne doit pas faire croire à
 * une session valide.
 */
export function useAccount(): AccountState {
  const [signedIn, setSignedIn] = useState(false);
  const [account, setAccount] = useState<CloudAccount | null>(() => loadAccount());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const session = await isSignedIn().catch(() => false);
      if (!alive) return;
      setSignedIn(session);
      setAccount(loadAccount());
      setLoading(false);
    };
    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener(CLOUD_ACCOUNT_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(CLOUD_ACCOUNT_EVENT, onChange);
    };
  }, []);

  return { signedIn, account, loading };
}
