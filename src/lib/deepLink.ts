import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Deep links `mira://` (retour du navigateur après un device flow).
 *
 * Le Rust (`src-tauri/src/deep_link.rs`) filtre les URL, ramène la fenêtre au
 * premier plan, puis émet l'évènement `mira://deep-link` avec l'URL acceptée.
 * Ici on ne fait que router : le contenu est un *signal*, jamais une preuve.
 *
 * ⚠️ Sécurité : ne JAMAIS faire confiance à une URL de deep link pour établir
 * une session ou livrer un secret. L'approbation réelle se vérifie uniquement
 * via le poll du device flow (`cloud_device_poll`). Un `mira://auth` forgé par
 * un tiers ne peut donc, au mieux, que réveiller l'application.
 */

/** Nom de l'évènement émis côté Rust. Doit rester synchronisé avec `DEEP_LINK_EVENT`. */
export const DEEP_LINK_EVENT = "mira://deep-link";

/**
 * S'abonne aux deep links. L'URL est passée au callback sous forme brute.
 *
 * Retourne une fonction de désabonnement (à appeler au démontage React).
 */
export async function onDeepLink(
  handler: (url: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(DEEP_LINK_EVENT, (event) => {
    if (typeof event.payload === "string") handler(event.payload);
  });
}

/** Vrai si l'URL est un retour d'authentification Mira bien formé. */
export function isAuthDeepLink(url: string): boolean {
  return url.startsWith("mira://auth");
}

/**
 * Crée un canal « nudge » à usage unique, alimenté par les deep links `auth`.
 *
 * L'abonné reçoit un signal AVEUGLE (« il vient peut-être de se passer quelque
 * chose côté navigateur ») et déclenche un poll. Il ne reçoit jamais de données
 * de l'URL : une URL forgée ne peut donc rien injecter, elle ne fait, au mieux,
 * qu'avancer un poll de quelques secondes.
 */
export function createAuthNudge(): {
  subscribe: (cb: () => void) => () => void;
  listen: () => Promise<UnlistenFn>;
} {
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async listen() {
      return onDeepLink((url) => {
        if (!isAuthDeepLink(url)) return;
        for (const cb of listeners) cb();
      });
    },
  };
}

