import {
  readDir,
  readFile,
  writeFile,
  renamePath,
  deletePath,
  createDirCmd,
  copyPath,
  pathExists,
  type FsEntry,
} from "../fs";
import { baseName, joinPath, normalize, parentOf, isAncestorOrSelf } from "./treeModel";

/**
 * Contexte d'exécution des opérations FS de l'explorateur.
 * `workspaceRoot` est transmis à **chaque** commande : le backend re-vérifie le
 * confinement (défense en profondeur), le frontend ne fait ici que pré-filtrer
 * pour éviter des appels inutiles et donner un retour immédiat.
 */
export interface ExplorerOpsCtx {
  workspaceRoot: string;
  onChanged: (dirs: string[]) => void;
}

function scope(ctx: ExplorerOpsCtx) {
  return { workspaceRoot: ctx.workspaceRoot };
}

function isInsideWorkspace(ctx: ExplorerOpsCtx, path: string): boolean {
  return isAncestorOrSelf(path, ctx.workspaceRoot);
}

export interface OpResult {
  ok: boolean;
  /** Chemin finalement écrit/créé (ex. après résolution de conflit de nom). */
  path?: string;
  /** Message d'erreur lisible si `ok === false`. */
  error?: string;
}

/**
 * Résout un nom disponible dans `dir` : « name », puis « name copy »,
 * « name copy 2 »… comme VS Code. Empêche tout écrasement silencieux.
 *
 * `reserved` permet de réserver les noms déjà attribués **dans le même lot**
 * (déplacement/copie de plusieurs fichiers) : sur un FS lent (réseau, ou
 * écritures pas encore visibles), se fier uniquement à `pathExists` pourrait
 * attribuer deux fois le même nom de repli.
 */
export async function uniquePath(
  ctx: ExplorerOpsCtx,
  dir: string,
  name: string,
  reserved?: Set<string>,
): Promise<string> {
  const taken = (candidate: string) =>
    (reserved?.has(normalize(candidate)) ?? false) || pathExistsCached(ctx, candidate);

  let candidate = joinPath(dir, name);
  if (!(await taken(candidate))) return candidate;

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  do {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    candidate = joinPath(dir, `${stem}${suffix}${ext}`);
    i += 1;
  } while (await taken(candidate));
  return candidate;
}

/** `pathExists` sans le préfixe async répété (lisibilité dans `uniquePath`). */
function pathExistsCached(ctx: ExplorerOpsCtx, candidate: string): Promise<boolean> {
  return pathExists(candidate, scope(ctx));
}

// ── Création ──────────────────────────────────────────────────────────────────

export async function createFile(ctx: ExplorerOpsCtx, parentDir: string, name: string): Promise<OpResult> {
  if (!isInsideWorkspace(ctx, parentDir)) return { ok: false, error: "Path outside workspace" };
  const trimmed = name.trim();
  if (!trimmed || /[/\\]/.test(trimmed)) return { ok: false, error: "Invalid file name" };
  const dest = joinPath(parentDir, trimmed);
  try {
    if (await pathExists(dest, scope(ctx))) return { ok: false, error: `"${trimmed}" already exists` };
    await writeFile(dest, "", scope(ctx));
    ctx.onChanged([parentDir]);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createFolder(ctx: ExplorerOpsCtx, parentDir: string, name: string): Promise<OpResult> {
  if (!isInsideWorkspace(ctx, parentDir)) return { ok: false, error: "Path outside workspace" };
  const trimmed = name.trim();
  if (!trimmed || /[/\\]/.test(trimmed)) return { ok: false, error: "Invalid folder name" };
  const dest = joinPath(parentDir, trimmed);
  try {
    if (await pathExists(dest, scope(ctx))) return { ok: false, error: `"${trimmed}" already exists` };
    await createDirCmd(dest, scope(ctx));
    ctx.onChanged([parentDir]);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Renommage ─────────────────────────────────────────────────────────────────

export async function renameEntry(
  ctx: ExplorerOpsCtx,
  from: string,
  newName: string,
): Promise<OpResult> {
  if (!isInsideWorkspace(ctx, from)) return { ok: false, error: "Path outside workspace" };
  const trimmed = newName.trim();
  if (!trimmed || /[/\\]/.test(trimmed)) return { ok: false, error: "Invalid name" };
  const dir = parentOf(from);
  const dest = joinPath(dir, trimmed);
  if (normalize(dest) === normalize(from)) return { ok: true, path: from };
  try {
    if (await pathExists(dest, scope(ctx))) return { ok: false, error: `"${trimmed}" already exists` };
    await renamePath(from, dest, scope(ctx));
    ctx.onChanged([dir]);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Déplacement / copie ───────────────────────────────────────────────────────

/**
 * Déplace une sélection vers `targetDir`. Les chemins invalides (dossier dans
 * lui-même/descendant, déjà dans la cible) sont ignorés sans erreur bloquante.
 * En cas de conflit de nom, on résout « name copy » (jamais d'écrasement).
 */
export async function moveInto(ctx: ExplorerOpsCtx, sources: string[], targetDir: string): Promise<OpResult[]> {
  const results: OpResult[] = [];
  if (!isInsideWorkspace(ctx, targetDir)) return [{ ok: false, error: "Target outside workspace" }];
  const target = normalize(targetDir);
  // Noms de repli déjà attribués dans ce lot (anti-collision intra-lot).
  const reserved = new Set<string>();

  for (const src of sources) {
    if (!isInsideWorkspace(ctx, src)) { results.push({ ok: false, error: "Source outside workspace" }); continue; }
    const s = normalize(src);
    if (target === s || target.startsWith(s + sepSlash(s))) continue; // dans soi-même
    if (normalize(parentOf(s)) === target) continue;                  // déjà dans la cible
    try {
      const dest = await uniquePath(ctx, targetDir, baseName(src), reserved);
      await renamePath(src, dest, scope(ctx));
      reserved.add(normalize(dest));
      results.push({ ok: true, path: dest });
    } catch (e) {
      results.push({ ok: false, error: String(e) });
    }
  }
  // Rafraîchit la cible **et** les dossiers sources : sans le parent source,
  // le fichier déplacé resterait affiché à son ancien emplacement (bug visible).
  if (results.some(r => r.ok)) {
    const dirs = new Set<string>([targetDir]);
    for (const src of sources) dirs.add(parentOf(src));
    ctx.onChanged([...dirs]);
  }
  return results;
}

/**
 * Copie une sélection vers `targetDir` (mêmes gardes que `moveInto`).
 * Sert au presse-papier « Copy » et au drop de fichiers depuis l'OS lus comme
 * des chemins ; dans le cas OS, les sources sont hors workspace et lues via
 * `importPaths` qui autorise explicitement une source externe.
 */
export async function copyInto(ctx: ExplorerOpsCtx, sources: string[], targetDir: string): Promise<OpResult[]> {
  const results: OpResult[] = [];
  if (!isInsideWorkspace(ctx, targetDir)) return [{ ok: false, error: "Target outside workspace" }];
  const target = normalize(targetDir);
  const reserved = new Set<string>();

  for (const src of sources) {
    const s = normalize(src);
    // Une source externe (drop OS) n'a pas à être dans le workspace ; on
    // interdit seulement de copier un dossier dans son propre sous-arbre.
    if (target === s || target.startsWith(s + sepSlash(s))) continue;
    try {
      const dest = await uniquePath(ctx, targetDir, baseName(src), reserved);
      await copyPath(src, dest, scope(ctx));
      reserved.add(normalize(dest));
      results.push({ ok: true, path: dest });
    } catch (e) {
      results.push({ ok: false, error: String(e) });
    }
  }
  if (results.some(r => r.ok)) ctx.onChanged([targetDir]);
  return results;
}

function sepSlash(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

// ── Suppression (avec confirmation fournie par l'appelant) ────────────────────

export async function deleteEntries(ctx: ExplorerOpsCtx, paths: string[]): Promise<OpResult[]> {
  const results: OpResult[] = [];
  const touched = new Set<string>();
  for (const p of paths) {
    if (!isInsideWorkspace(ctx, p)) { results.push({ ok: false, error: "Path outside workspace" }); continue; }
    if (normalize(p) === normalize(ctx.workspaceRoot)) { results.push({ ok: false, error: "Cannot delete workspace root" }); continue; }
    try {
      await deletePath(p, scope(ctx));
      touched.add(parentOf(p));
      results.push({ ok: true, path: p });
    } catch (e) {
      results.push({ ok: false, error: String(e) });
    }
  }
  if (touched.size) ctx.onChanged([...touched]);
  return results;
}

// ── Lecture ───────────────────────────────────────────────────────────────────

export async function listDir(ctx: ExplorerOpsCtx, dir: string): Promise<FsEntry[]> {
  if (!isInsideWorkspace(ctx, dir)) return [];
  return readDir(dir, scope(ctx));
}

export async function readTextFile(ctx: ExplorerOpsCtx, path: string): Promise<string | null> {
  try {
    return await readFile(path, scope(ctx));
  } catch {
    return null;
  }
}
