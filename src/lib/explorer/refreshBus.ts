/**
 * Bus de rafraîchissement de l'explorateur.
 *
 * Pourquoi un bus et pas des props : l'écriture « agent » qui doit rafraîchir
 * l'arbre se produit profondément dans `AiPanel`, alors que l'explorateur vit
 * dans `Sidebar` (arbre React distinct). Faire remonter un callback à travers
 * `App` → `Sidebar` → `FileTree` → `useExplorer` imposerait une plomberie qui
 * traverserait des composants sans rapport (éditeur, panneaux d'outils).
 *
 * Ce bus expose donc **une seule** capacité : « ces dossiers ont changé, recharge
 * -les ». L'`useExplorer` y souscrit ; l'écrivain (agent) y publie des dossiers
 * **précis** (le parent du fichier écrit), ce qui évite un `reloadAll()` complet
 * à chaque écriture — coûteux sur un gros workspace et en rafale.
 *
 * Portée volontairement minuscule : pas de payload générique, pas d'historique,
 * pas de rejeu. Un abonné unique (l'explorateur monté) ; publier sans abonné est
 * un no-op silencieux (ex. sidebar fermée).
 */

type RefreshListener = (dirs: string[]) => void;

const listeners = new Set<RefreshListener>();

/**
 * Abonne un consommateur (typiquement `useExplorer`). Retourne la fonction de
 * désabonnement à appeler au démontage.
 */
export function subscribeExplorerRefresh(listener: RefreshListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Signale que des fichiers ont changé dans les dossiers `dirs`. Le filtrage
 * (workspace, normalisation) reste à la charge de l'abonné : `useExplorer`
 * connaît la racine et ignore déjà tout chemin hors workspace.
 */
export function notifyExplorerDirsChanged(dirs: string[]): void {
  if (dirs.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(dirs);
    } catch {
      // Un abonné défaillant ne doit jamais casser l'écrivain (ni les autres
      // abonnés) : on isole l'erreur, le refresh est un effet de confort.
    }
  }
}
