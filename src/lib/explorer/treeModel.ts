import type { FsEntry } from "../fs";

// ── Utilitaires de chemin (indépendants de l'OS) ──────────────────────────────

export function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function parentOf(p: string): string {
  return p.replace(/[/\\][^/\\]+$/, "");
}

export function baseName(p: string): string {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? p;
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}${sepOf(dir)}${name}`;
}

export function normalize(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/** Le chemin `child` est-il `ancestor` ou l'un de ses descendants ? */
export function isAncestorOrSelf(child: string, ancestor: string): boolean {
  const c = normalize(child);
  const a = normalize(ancestor);
  if (c === a) return true;
  return c.startsWith(a + sepOf(a));
}

// ── Tri (dossiers d'abord, puis A→Z insensible à la casse) ────────────────────

export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

// ── Flatten (arbre visible → liste plate pour la virtualisation) ──────────────

export interface FlatRow {
  entry: FsEntry;
  depth: number;
  /** Le dossier est-il déplié ? (toujours false pour un fichier) */
  open: boolean;
}

/**
 * Aplati l'arbre en ne conservant que les lignes **visibles** (dossiers dépliés
 * et leurs descendants). Résultat consommé par la liste virtualisée.
 */
export function flattenTree(
  root: FsEntry[],
  expanded: Set<string>,
  childrenOf: (path: string) => FsEntry[] | undefined,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (entries: FsEntry[], depth: number) => {
    for (const entry of entries) {
      const open = entry.is_dir && expanded.has(entry.path);
      rows.push({ entry, depth, open });
      if (open) {
        const kids = childrenOf(entry.path);
        if (kids && kids.length) walk(kids, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
}

// ── Sélection ─────────────────────────────────────────────────────────────────

export interface SelectMods {
  meta?: boolean;  // Cmd (macOS) / Ctrl → bascule unitaire
  shift?: boolean; // plage depuis l'ancre
}

/**
 * Calcule la nouvelle sélection à partir des lignes visibles.
 * - Cmd/Ctrl : bascule unitaire, l'ancre devient la ligne cliquée.
 * - Shift : sélectionne la plage entre l'ancre (incluse) et la ligne cliquée,
 *   **au sein des lignes actuellement visibles uniquement** (comme VS Code).
 * - Clic simple : sélection unique, nouvelle ancre.
 */
export function nextSelection(
  visiblePaths: string[],
  current: Set<string>,
  anchor: string | null,
  clicked: string,
  mods: SelectMods,
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor && visiblePaths.includes(anchor)) {
    const a = visiblePaths.indexOf(anchor);
    const b = visiblePaths.indexOf(clicked);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { selected: new Set(visiblePaths.slice(lo, hi + 1)), anchor };
    }
  }
  if (mods.meta) {
    const next = new Set(current);
    if (next.has(clicked)) next.delete(clicked);
    else next.add(clicked);
    return { selected: next, anchor: clicked };
  }
  return { selected: new Set([clicked]), anchor: clicked };
}
