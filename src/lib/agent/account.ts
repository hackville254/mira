import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

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
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Résultat d'un poll de device flow. */
export type PollOutcome =
  | { outcome: "pending"; interval: number }
  | {
      outcome: "approved";
      email: string | null;
      plan: string | null;
      budgetUsd: number | null;
    }
  | { outcome: "denied" }
  | { outcome: "expired" };

/**
 * Démarre un device flow et renvoie le lien d'appairage. Le `device_code` reste
 * côté Rust : l'UI ne peut donc pas le rejouer ni le falsifier.
 *
 * Le `user_code` n'est volontairement pas remonté : le parcours est « par lien »
 * (façon Trae), l'utilisateur n'a jamais de code à recopier.
 */
export async function startDeviceFlow(label?: string): Promise<DeviceStart> {
  const raw = await invoke<{
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>("cloud_device_start", { clientLabel: label ?? null });
  return {
    verificationUri: raw.verification_uri,
    verificationUriComplete: raw.verification_uri_complete,
    expiresIn: raw.expires_in,
    interval: raw.interval,
  };
}

/** Interroge l'état du device flow courant (les jetons restent côté Rust). */
export async function pollDeviceFlow(): Promise<PollOutcome> {
  const raw = await invoke<
    | { pending: { interval: number } }
    | { approved: { email: string | null; plan: string | null; budget_usd: number | null } }
    | "denied"
    | "expired"
  >("cloud_device_poll");
  if (raw === "denied" || raw === "expired") return { outcome: raw };
  if ("approved" in raw) {
    return {
      outcome: "approved",
      email: raw.approved.email,
      plan: raw.approved.plan,
      budgetUsd: raw.approved.budget_usd,
    };
  }
  return { outcome: "pending", interval: raw.pending.interval };
}

/** Issue d'une attente d'approbation. */
export type SignInResult =
  | {
      outcome: "approved";
      email: string | null;
      plan: string | null;
      budgetUsd: number | null;
    }
  | { outcome: "denied" }
  | { outcome: "expired" }
  | { outcome: "cancelled" };

/**
 * Boucle de polling jusqu'à un état terminal.
 *
 * `interval` est imposé par le serveur (protection anti-brute-force) : on le
 * respecte strictement. `signal` permet à l'UI d'annuler proprement (fermeture
 * de la modale) sans laisser de boucle orpheline.
 *
 * `nudge` est un canal d'ACCÉLÉRATION : quand un deep link `mira://auth` signale
 * que le navigateur vient d'approuver, on déclenche immédiatement le prochain
 * poll au lieu d'attendre la fin de l'intervalle. Le serveur impose de toute
 * façon un intervalle minimal — un nudge trop rapproché reçoit `slow_down`, ce
 * qui n'est jamais une erreur, donc aucun risque d'abus.
 *
 * Résilience : une erreur TRANSITOIRE (réseau coupé une seconde, backend qui
 * redémarre) ne doit PAS faire échouer la connexion — l'utilisateur a peut-être
 * déjà approuvé dans son navigateur. On compte les échecs consécutifs et on ne
 * renonce qu'après `MAX_CONSECUTIVE_ERRORS`, ce qui évite à la fois le blocage
 * silencieux et la boucle infinie si le plan de contrôle est réellement en
 * panne. Un `AbortSignal` coupe toujours immédiatement.
 */
const MAX_CONSECUTIVE_ERRORS = 6;
const ERROR_RETRY_MS = 3000;

export async function waitForApproval(
  signal?: AbortSignal,
  onTick?: (secondsLeft: number) => void,
  nudge?: { subscribe: (cb: () => void) => () => void },
): Promise<SignInResult> {
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) return { outcome: "cancelled" };
    let res: PollOutcome;
    try {
      res = await pollDeviceFlow();
      consecutiveErrors = 0;
    } catch (e) {
      // Panne transitoire : on réessaie plutôt que d'invalider une session qui
      // a très probablement abouti côté navigateur.
      if (signal?.aborted) return { outcome: "cancelled" };
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw e;
      await sleep(ERROR_RETRY_MS, signal, nudge);
      continue;
    }
    if (res.outcome === "approved") {
      return {
        outcome: "approved",
        email: res.email,
        plan: res.plan,
        budgetUsd: res.budgetUsd,
      };
    }
    if (res.outcome === "denied") return { outcome: "denied" };
    if (res.outcome === "expired") return { outcome: "expired" };
    const intervalMs = res.interval * 1000;
    await sleep(intervalMs, signal, nudge);
    onTick?.(intervalMs / 1000);
  }
}

/** Attente annulable : réveillée par le timer, un nudge, ou l'annulation. */
function sleep(
  ms: number,
  signal?: AbortSignal,
  nudge?: { subscribe: (cb: () => void) => () => void },
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubNudge?.();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const unsubNudge = nudge?.subscribe(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Provisionne la clé Orvyx du compte (rangée côté Rust dans le keychain OS) et
 * renvoie ses métadonnées non sensibles.
 *
 * `identity` provient de l'approbation du device flow (email + plan du compte) :
 * `cloud_provision_key` ne renvoie que des métadonnées de clé, pas l'identité.
 */
export async function provisionKey(
  deviceLabel?: string,
  identity?: { email: string | null; plan: string | null },
): Promise<CloudAccount> {
  const raw = await invoke<{
    key_fingerprint: string;
    masked_hint: string;
    budget_usd: number;
  }>("cloud_provision_key", { deviceLabel: deviceLabel ?? null });
  const account: CloudAccount = {
    email: identity?.email ?? null,
    plan: identity?.plan ?? null,
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

/**
 * Réactualise les métadonnées du compte (plan, budget) depuis le plan de
 * contrôle, SANS action utilisateur.
 *
 * Raison d'être : le plan d'un client peut changer côté serveur (passage au
 * payant, nouveau quota d'équipe) alors que le poste reste ouvert. Le desktop
 * doit refléter ce changement de lui-même — l'ancien bouton « Refresh models »
 * faisait ce travail mais obligeait l'utilisateur à cliquer.
 *
 * Ne fait rien si aucune session n'est active ou si l'appel échoue : c'est un
 * rafraîchissement d'affichage, jamais un motif d'échec. Ne renvoie l'état
 * modifié QUE si quelque chose a réellement changé, pour éviter de notifier
 * les abonnés (et de re-rendre) inutilement à chaque cycle.
 */
export async function refreshAccount(): Promise<CloudAccount | null> {
  if (!(await isSignedIn().catch(() => false))) return null;
  let fresh: CloudAccount;
  try {
    fresh = await provisionKey();
  } catch {
    // Réseau/back-end indisponible : on conserve l'état connu.
    return null;
  }
  const prev = loadAccount();
  if (
    prev &&
    prev.email === fresh.email &&
    prev.plan === fresh.plan &&
    prev.budgetUsd === fresh.budgetUsd &&
    prev.keyFingerprint === fresh.keyFingerprint
  ) {
    return null;
  }
  return fresh;
}

/** Récupère le catalogue Mira du plan de contrôle et le met en cache local. */
export async function syncModels(): Promise<CloudModel[]> {
  const models = await invoke<CloudModel[]>("cloud_fetch_models");
  saveCatalog(models);
  return models;
}

/**
 * Ramène la fenêtre Mira au premier plan (best-effort).
 *
 * Le navigateur ne peut pas réveiller une app native : après l'approbation,
 * c'est au poste de se manifester pour que l'utilisateur voie la connexion
 * aboutir. Une erreur ici ne doit jamais invalider une session pourtant
 * approuvée — on l'avale donc en silence.
 */
export async function focusCloudWindow(): Promise<void> {
  await invoke("cloud_focus_window").catch(() => { /* focus best-effort */ });
}

/**
 * Ouvre la page de tarifs du portail Mira dans le navigateur système.
 *
 * Utilisé quand Orvyx refuse une requête faute de crédit : l'action utile pour
 * l'utilisateur est de changer d'offre, pas de réessayer. L'URL est fabriquée
 * côté Rust à partir de la base du plan de contrôle (jamais fournie par un
 * modèle ni par l'utilisateur) — le front ne fait que l'ouvrir.
 */
export async function openUpgradePage(): Promise<void> {
  const url = await invoke<string>("cloud_upgrade_url");
  await openUrl(url);
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
  /** Canal d'accélération branché sur le deep link `mira://auth`. */
  nudge?: { subscribe: (cb: () => void) => () => void };
}): Promise<SignInResult> {
  const flow = await startDeviceFlow(options?.label);
  options?.onStarted?.(flow);
  const result = await waitForApproval(options?.signal, undefined, options?.nudge);
  if (result.outcome === "approved") {
    // Le poste se ramène au premier plan : l'utilisateur est dans le navigateur,
    // il doit voir l'app se rouvrir (comportement attendu, façon Trae).
    await focusCloudWindow();
    // Session OK : le poll a DÉJÀ rangé jetons + clé Orvyx côté Rust (keychain).
    // Le rafraîchissement ci-dessous n'est que de l'affichage (empreinte, plan).
    // Il ne doit JAMAIS invalider une connexion pourtant réussie : une panne
    // réseau ou un endpoint d'affichage indisponible ne fait pas échouer le
    // sign-in — sinon la modale resterait bloquée alors que l'utilisateur est
    // bel et bien connecté (régression vécue : « connecté mais bloqué »).
    await provisionKey(options?.label, { email: result.email, plan: result.plan }).catch(
      () => { /* métadonnées indisponibles : la session reste valide */ },
    );
    await syncModels().catch(() => { /* catalogue indisponible : idem */ });
    // L'identité d'affichage doit être rafraîchie même si provisionKey a échoué :
    // on mémorise l'email/plan/budget issus de l'approbation et on prévient les
    // abonnés (TitleBar) que l'état de connexion a changé. Le budget vient du
    // poll, donc le crédit offert (plan gratuit) s'affiche dès la connexion.
    const prev = loadAccount();
    saveAccount({
      email: result.email,
      plan: result.plan,
      keyFingerprint: prev?.keyFingerprint ?? null,
      maskedHint: prev?.maskedHint ?? null,
      budgetUsd: result.budgetUsd ?? prev?.budgetUsd ?? null,
    });
    emitAccountChanged();
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
