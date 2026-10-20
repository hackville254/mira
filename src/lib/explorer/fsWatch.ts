/**
 * Pont entre la surveillance disque RUST (`fs://changed`) et le bus de
 * rafraîchissement de l'explorateur.
 *
 * POURQUOI ICI ET PAS DANS `useExplorer`
 * --------------------------------------
 * `listen()` de Tauri est un ABONNEMENT GLOBAL (une seule souscription par
 * nom d'événement suffit) : le câbler dans le hook monté/démonté par l'UI
 * multiplierait les abonnements concurrents à chaque remontage de la sidebar.
 * On isole donc la souscription dans un module de portée applicative,
 * `startFilePathWatch()`, appelé UNE fois au démarrage de l'app.
 *
 * RÔLE : traduire un événement disque (liste de dossiers touchés, émis par
 * `fs_watch.rs`) en notification du bus. Le filtrage par workspace et le
 * debounce restent dans `useExplorer`, qui connaît la racine et sait quels
 * dossiers sont réellement affichés.
 *
 * SÉCURITÉ : le payload vient du process Rust (frontière de confiance locale),
 * mais on ne s'y fie pas pour autant — on ne transmet que des CHAÎNES et on
 * rejette tout le reste. Aucun chemin n'est utilisé pour lire/écrire quoi que
 * ce soit côté front : il sert uniquement à décider quel dossier recharger, et
 * `useExplorer` re-filtre déjà tout chemin hors workspace.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { notifyExplorerDirsChanged } from "./refreshBus";
import { log } from "../logger";

/** Doit rester synchrone avec `fs_watch::EVENT_FS_CHANGED` (Rust). */
const EVENT_FS_CHANGED = "fs://changed";

/**
 * Démarre l'écoute de la surveillance disque. Renvoie la fonction d'arrêt.
 *
 * Best-effort : si l'écoute échoue (contexte non-Tauri, par ex. dans un
 * navigateur de test), on journalise et on renvoie un no-op — l'explorateur
 * reste fonctionnel, il perd juste le rafraîchissement « externe ».
 */
export async function startFilePathWatch(): Promise<UnlistenFn> {
  try {
    return await listen<string[]>(EVENT_FS_CHANGED, (event) => {
      const payload = event.payload;
      if (!Array.isArray(payload)) return;
      const dirs = payload.filter((d): d is string => typeof d === "string" && d.length > 0);
      notifyExplorerDirsChanged(dirs);
    });
  } catch (error) {
    log.warn("explorer/fsWatch", `surveillance disque indisponible : ${String(error)}`);
    return () => {};
  }
}
