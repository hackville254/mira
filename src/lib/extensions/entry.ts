/**
 * Résolution de l'entrypoint d'une extension (mode « léger »).
 *
 * PROBLÈME RÉEL (reproduit sur `ms-python.python-2026.4.0`) :
 *   le manifeste déclare `"main": "./out/client/extension"` — SANS extension
 *   `.js` — alors que le fichier livré est `out/client/extension.js`. Un
 *   `readFile("./out/client/extension")` échoue donc avec « No such file or
 *   directory », et l'UI affichait une erreur pour *toutes* les extensions qui
 *   utilisent cette convention (webpack/tsc émettent souvent un `main` sans
 *   suffixe). C'est un bug systémique, pas propre à une extension.
 *
 * STRATÉGIE
 * ---------
 * On résout en trois états, et on essaie des fallbacks d'extension :
 *   - **Declarative** : le manifeste ne déclare aucun `main` → c'est une
 *     extension de *contributions passives* (thèmes, grammaires, snippets).
 *     Statut NORMAL, jamais une erreur : il n'y a simplement pas de code à
 *     exécuter en mode léger.
 *   - **Code(path)** : un entrypoint exécutable a été trouvé.
 *   - **Missing(path)** : un `main` est déclaré mais aucun fichier correspondant
 *     n'existe (ni tel quel, ni avec `.js`, ni en `index.js`). Là seulement on
 *     signale « code non supporté en mode léger ».
 *
 * SÉCURITÉ : la résolution est purement logique. Le chemin retourné reste
 * relatif au dossier de l'extension et n'est jamais absolu ; la vérification
 * d'existence (et le confinement au dossier de l'extension) est faite par le
 * backend `read_extension_asset` via un test de lecture. On refuse tout `main`
 * qui s'échapperait du dossier (absolu, `..`, backslash Windows).
 */

/** Les trois états possibles de l'entrypoint. */
export type EntryKind = "declarative" | "code" | "missing";

export interface ResolvedEntry {
  kind: EntryKind;
  /**
   * Chemin relatif de l'entrypoint à lire, uniquement quand `kind === "code"`.
   * `null` pour les états `declarative` et `missing`.
   */
  path: string | null;
  /**
   * Chemin déclaré par le manifeste (sans transformation), pour les logs et le
   * message utilisateur. `null` quand aucun `main` n'est déclaré.
   */
  declared: string | null;
}

/**
 * Normalise un `main` en chemin relatif sûr, ou `null` s'il sort du dossier.
 * Retire le `./` de tête, rejette l'absolu (`/…`, `C:\…`) et le `..`.
 */
export function normalizeEntryPath(main: string): string | null {
  const cleaned = main.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return null;
  // Refuse toute remontée de dossier.
  if (cleaned.split("/").some((seg) => seg === "..")) return null;
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Candidats de chemins à essayer, dans l'ordre :
 *   1. le chemin déclaré tel quel,
 *   2. avec le suffixe `.js` (cas webpack/tsc : `main` sans extension),
 *   3. `<chemin>/index.js` (convention dossier).
 * Dédupliqués, bornés, et seulement pour un `main` sûr.
 */
export function entryCandidates(main: string): string[] {
  const base = normalizeEntryPath(main);
  if (!base) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  push(base);
  push(`${base}.js`);
  push(`${base.replace(/\/+$/, "")}/index.js`);
  return out;
}

/**
 * Résout l'entrypoint d'une extension à partir de son `main` et d'un testeur
 * d'existence **asynchrone** (typiquement : essayer de lire l'asset via le
 * backend, qui rejette si le fichier n'existe pas).
 *
 * Le testeur est injecté pour rester testable sans Tauri. Il ne doit PAS lever :
 * il doit retourner un booléen.
 */
export async function resolveEntry(
  main: string | null | undefined,
  fileExists: (relPath: string) => Promise<boolean>,
): Promise<ResolvedEntry> {
  // Pas de `main` → extension purement déclarative (thème, grammaire, snippet).
  if (!main) {
    return { kind: "declarative", path: null, declared: null };
  }

  const candidates = entryCandidates(main);
  // `main` déclaré mais insalubre (absolu / `..`) : on refuse sans tenter.
  if (candidates.length === 0) {
    return { kind: "missing", path: null, declared: main };
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return { kind: "code", path: candidate, declared: main };
    }
  }

  // Un `main` est déclaré, mais rien ne correspond → « code non supporté ».
  return { kind: "missing", path: null, declared: main };
}
