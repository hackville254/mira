/**
 * Persistance de l'état d'expansion de l'explorateur, par workspace.
 *
 * L'objectif est de retrouver, au redémarrage, la même arborescence ouverte que
 * celle laissée par l'utilisateur — comme VS Code.
 *
 * Sécurité / robustesse :
 *  - Stocké en localStorage sous une clé **dérivée du chemin** du workspace.
 *  - Lecture validée : seules les chaînes plausibles sont conservées (borne de
 *    taille + nombre), un contenu corrompu n'empêche jamais le rendu.
 */
const KEY_PREFIX = 'origin-explorer-expanded:';

/** Nombre maximal de dossiers mémorisés (garde-fou anti-bloat localStorage). */
const MAX_ENTRIES = 2000;

function keyFor(rootPath: string): string {
  return KEY_PREFIX + rootPath.replace(/[/\\]+$/, '');
}

/** Charge l'ensemble des chemins de dossiers dépliés pour ce workspace. */
export function loadExpanded(rootPath: string): Set<string> {
  if (!rootPath) return new Set();
  try {
    const raw = localStorage.getItem(keyFor(rootPath));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const item of parsed.slice(0, MAX_ENTRIES)) {
      if (typeof item === 'string' && item.length > 0 && item.length <= 4096) out.add(item);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Persiste l'ensemble des dossiers dépliés pour ce workspace. */
export function saveExpanded(rootPath: string, expanded: Set<string>): void {
  if (!rootPath) return;
  try {
    const arr = [...expanded].slice(0, MAX_ENTRIES);
    localStorage.setItem(keyFor(rootPath), JSON.stringify(arr));
  } catch {
    // Quota dépassé ou localStorage indisponible : la persistance est un
    // confort, jamais une condition de bon fonctionnement.
  }
}
