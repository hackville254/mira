// ── Contexte projet dérivé (injecté dans les sous-agents) ──────────────────────
//
// Objectif : qu'un sous-agent puisse S'ORIENTER SEUL (stack, structure, fichiers
// clés) sans qu'on lui écrive quoi que ce soit à la main. Tout est dérivé du
// workspace réel, jamais hardcodé.
//
// Contraintes produit :
//   - STRICTEMENT BORNÉ : le bloc fait au plus `MAX_CONTEXT_CHARS` caractères,
//     donc un coût en tokens prévisible même sur un dépôt de 2M+ lignes.
//   - DÉRIVÉ UNE FOIS PAR TOUR : le résultat est mis en cache par `folderPath`
//     et invalidé explicitement au début de chaque tour (`resetProjectContext`).
//   - JAMAIS BLOQUANT : toute erreur d'I/O est avalée ; un contexte vide est
//     préférable à un sous-agent qui plante.

import { invoke } from "@tauri-apps/api/core";

/** Plafond dur du bloc de contexte (caractères) — borne le coût en tokens. */
export const MAX_CONTEXT_CHARS = 2_400;
/** Profondeur d'arborescence résumée. */
const MAX_DEPTH = 2;
/** Nombre maximal d'entrées listées par niveau. */
const MAX_ENTRIES_PER_LEVEL = 12;

/** Fichiers « clés » dont la simple présence révèle la stack / le projet. */
const KEY_FILES = [
  "package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml",
  "go.mod", "Gemfile", "pom.xml", "build.gradle",
  "README.md", "README", ".editorconfig",
];

export interface ProjectContext {
  folderPath: string;
  /** Stack détectée, ex. ["Node/TypeScript", "Rust (Tauri)"] — best-effort. */
  stack: string[];
  /** Arborescence résumée (chemins relatifs, dossiers marqués d'un `/`). */
  tree: string[];
  /** Fichiers clés présents à la racine. */
  keyFiles: string[];
}

interface DirEntry { name: string; path: string; is_dir: boolean }

// ── Cache par tour ET par session ──────────────────────────────────────────────
//
// MULTITASKING : plusieurs tâches peuvent tourner en parallèle dans le même
// projet. Le cache est donc clé par « session » (l'identifiant de tâche fourni
// par l'appelant) ET validé sur le `folderPath`. Sans clé, deux runs concurrents
// partageraient la même entrée et l'un invaliderait le contexte de l'autre.

/** Clé de session par défaut (appelants mono-tâche / tests). */
export const DEFAULT_CONTEXT_KEY = "__default__";

const cache = new Map<string, ProjectContext>();

/** À appeler au début de chaque tour : le contexte de CETTE session est
 *  recalculé paresseusement. Sans clé : purge tous les contextes connus. */
export function resetProjectContext(sessionKey?: string): void {
  if (sessionKey === undefined) { cache.clear(); return; }
  cache.delete(sessionKey);
}

/**
 * Construit (ou réutilise) le contexte projet du dossier donné. Idempotent sur un
 * même `folderPath` au sein d'un tour ET d'une session. Ne jette jamais.
 */
export async function getProjectContext(folderPath: string, sessionKey: string = DEFAULT_CONTEXT_KEY): Promise<ProjectContext> {
  const cached = cache.get(sessionKey);
  if (cached && cached.folderPath === folderPath) return cached;

  const root = folderPath || ".";
  const tree: string[] = [];
  try {
    await walk(root, "", 0, tree);
  } catch {
    // Best-effort : on garde ce qu'on a déjà listé.
  }

  let rootEntries: DirEntry[];
  try {
    rootEntries = await invoke<DirEntry[]>("read_dir", { path: root });
  } catch {
    rootEntries = [];
  }
  const names = new Set(rootEntries.map(e => e.name));
  const keyFiles = KEY_FILES.filter(f => names.has(f));

  const ctx: ProjectContext = { folderPath: root, stack: detectStack(keyFiles, names), tree, keyFiles };
  cache.set(sessionKey, ctx);
  return ctx;
}

/** Walk borné (profondeur + entrées/niveau) — jamais récursif à l'infini. */
async function walk(dir: string, prefix: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length > 200) return;
  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("read_dir", { path: dir });
  } catch {
    return;
  }
  const shown = entries
    .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "target")
    .slice(0, MAX_ENTRIES_PER_LEVEL);

  for (const e of shown) {
    out.push(prefix + e.name + (e.is_dir ? "/" : ""));
  }
  if (depth === MAX_DEPTH) return;
  for (const e of shown) {
    if (e.is_dir) await walk(e.path, `${prefix}${e.name}/`, depth + 1, out);
  }
}

/** Détection de stack purement déclarative (fichiers présents → libellé). */
function detectStack(keyFiles: string[], names: Set<string>): string[] {
  const out: string[] = [];
  if (keyFiles.includes("package.json")) {
    out.push(names.has("tsconfig.json") ? "Node/TypeScript" : "Node/JavaScript");
  }
  if (keyFiles.includes("Cargo.toml")) out.push("Rust");
  if (names.has("src-tauri")) out.push("Tauri desktop app");
  if (keyFiles.includes("pyproject.toml")) out.push("Python");
  if (keyFiles.includes("go.mod")) out.push("Go");
  if (keyFiles.includes("Gemfile")) out.push("Ruby");
  if (keyFiles.includes("pom.xml") || keyFiles.includes("build.gradle")) out.push("JVM");
  return out;
}

/**
 * Assemble le bloc texte injecté dans le prompt du sous-agent : contexte projet
 * + résumé du fil + todos en cours. Toujours ≤ `MAX_CONTEXT_CHARS`.
 */
export function buildContextBlock(
  ctx: ProjectContext,
  opts: { threadSummary?: string; todos?: string[] } = {},
): string {
  const parts: string[] = [];
  if (ctx.stack.length) parts.push(`Stack: ${ctx.stack.join(", ")}`);
  if (ctx.keyFiles.length) parts.push(`Key files: ${ctx.keyFiles.join(", ")}`);
  if (ctx.tree.length) parts.push(`Structure:\n${ctx.tree.join("\n")}`);
  if (opts.threadSummary?.trim()) parts.push(`What the parent already knows:\n${opts.threadSummary.trim()}`);
  if (opts.todos?.length) parts.push(`Current task list:\n${opts.todos.map(t => `- ${t}`).join("\n")}`);

  if (!parts.length) return "";
  const body = parts.join("\n\n");
  const header = "<project-context>\n";
  const footer = "\n</project-context>";
  // Borne DURE : header + corps (+ ellipsis) + footer ≤ MAX_CONTEXT_CHARS.
  const budget = MAX_CONTEXT_CHARS - header.length - footer.length;
  const trimmed = body.length > budget
    ? body.slice(0, Math.max(0, budget - 1)) + "…"
    : body;
  return header + trimmed + footer;
}
