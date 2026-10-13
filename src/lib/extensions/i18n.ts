/**
 * Résolution des chaînes localisées d'extension (`%key%`).
 *
 * Un `package.json` VS Code peut écrire `"title": "%command.foo.title%"`. Le
 * texte réel vit alors dans `package.nls.json` (ou `package.nls.<locale>.json`).
 * Sans résolution, la palette affiche le placeholder brut — ce qui rend les
 * commandes illisibles. On résout donc chaque `%clé%` vers sa traduction.
 *
 * Portée volontairement limitée :
 *   - lecture de `package.nls.json` de l'extension (déjà installée) ;
 *   - repli sur le nom localisé anglais (`package.nls.en.json`) ;
 *   - si une clé reste introuvable, on retire les `%` pour éviter le bruit
 *     visuel (jamais de placeholder brut montré à l'utilisateur).
 *
 * Framework-free (map module-level + subscribe) pour un usage React via
 * `useSyncExternalStore` comme depuis du code simple.
 */
import { readExtensionAsset } from "../extensions";

type Listener = () => void;

/** extensionId → table de traduction (clé → texte). */
const tables = new Map<string, Record<string, string>>();
/** extensionId → promesse en cours (évite les lectures redondantes). */
const pending = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();

/** Révision incrémentée à chaque table chargée — snapshot stable pour React. */
let revision = 0;

function emit(): void {
  revision++;
  for (const l of listeners) l();
}

/** S'abonner aux mises à jour des tables. Retourne un désabonnement. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot pour `useSyncExternalStore` : change quand une table est chargée. */
export function getRevision(): number {
  return revision;
}

/**
 * Charge (une seule fois) les tables de traduction d'une extension. Idempotent :
 * un appel répété ne relit pas le disque. Les erreurs sont absorbées — une
 * extension sans fichier NLS reste utilisable (les clés seront simplement
 * retirées de leurs `%`).
 */
export function ensureExtensionI18n(extensionId: string): Promise<void> {
  if (tables.has(extensionId)) return Promise.resolve();
  const inFlight = pending.get(extensionId);
  if (inFlight) return inFlight;
  const task = (async () => {
    const merged: Record<string, string> = {};
    for (const file of ["package.nls.json", "package.nls.en.json"]) {
      try {
        const raw = await readExtensionAsset(extensionId, file);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && !(k in merged)) merged[k] = v;
          }
        }
      } catch {
        // Fichier absent ou illisible : on tente le suivant.
      }
    }
    tables.set(extensionId, merged);
    pending.delete(extensionId);
    emit();
  })();
  pending.set(extensionId, task);
  return task;
}

/**
 * Table courante pour une extension ; renvoie une référence **stable** tant que
 * la table n'a pas changé, pour `useSyncExternalStore`.
 */
const EMPTY: Record<string, string> = {};
export function getI18nTable(extensionId: string): Record<string, string> {
  return tables.get(extensionId) ?? EMPTY;
}

/**
 * Résout les `%clé%` d'un libellé. `%key%` (tout le champ) → traduction ;
 * `foo %key% bar` → interpolation. Une clé inconnue est rendue sans les `%`.
 */
export function resolveNlsText(text: string, table: Record<string, string>): string {
  if (!text || !text.includes("%")) return text;
  return text.replace(/%([^%]+)%/g, (_m, key: string) => {
    const hit = table[key.trim()];
    return hit ?? "";
  });
}
