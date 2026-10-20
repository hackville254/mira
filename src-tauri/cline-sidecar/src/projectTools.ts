/**
 * Mira — Outils CUSTOM de COMPRÉHENSION DU PROJET (sidecar Cline).
 *
 * RÔLE
 * ----
 * Donner à l'agent des outils de reconnaissance qu'il appelle LUI-MÊME pour
 * comprendre un projet AVANT d'agir : arborescence, état git, diff courant,
 * recherche de symboles (fonctions/classes/types) et dépendances d'imports.
 *
 * Sans ces outils, l'agent ne dispose que de `read_file`/`grep`/`glob` : sur un
 * projet de plusieurs millions de lignes, il tâtonne (il lit fichier par
 * fichier) et rate le contexte structurel. On lui expose donc les capacités
 * DÉJÀ implémentées côté Rust (`tree.rs`, `git.rs`, `search.rs`) sous forme
 * d'outils typés, bornés et en lecture seule.
 *
 * POURQUOI ICI (Node) ET PAS CÔTÉ FRONT
 * -------------------------------------
 * Les outils sont exécutés par le MOTEUR d'agent : leur définition doit vivre
 * dans le même process que lui. Ils ne font RIEN localement : ils relaient une
 * commande Tauri FIGÉE vers le front via le pont `tool_invoke` (`originInvoke`),
 * exactement comme `codebase_search` (cf. `./codeIndexTool`).
 *
 * SÉCURITÉ
 * --------
 *   - **Lecture seule** : aucun de ces outils n'écrit sur le disque. Ils sont
 *     auto-approuvés côté `TOOL_POLICIES` (sinon une carte de confirmation à
 *     chaque appel rendrait l'agent inutilisable).
 *   - **Nom de commande FIGÉ** ici : le modèle ne peut jamais choisir la
 *     commande Tauri exécutée, seulement les paramètres (query, path…). Le front
 *     revérifie de toute façon chaque commande contre `INVOKE_ALLOWLIST`.
 *   - **Workspace FIGÉ** : tous les outils reçoivent le `cwd` de la session au
 *     moment de la construction. Le modèle ne peut pas viser un autre dossier.
 *   - **Entrées bornées** : longueurs de requête et plafonds de résultats
 *     limités, pour qu'un prompt hostile ne puisse pas saturer la mémoire de la
 *     webview ni noyer le contexte du modèle.
 *   - **Chemins bornés** : pour `git_diff` sur un fichier précis, on REFUSE tout
 *     chemin absolu ou contenant `..` (traversée hors workspace).
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Longueur maximale d'une requête de recherche (borne anti-abus). */
const MAX_QUERY_LEN = 200;
/** Nombre maximal de symboles renvoyés. */
const MAX_SYMBOLS = 60;
/** Nombre maximal d'arêtes d'imports rendues (le graphe complet peut être énorme). */
const MAX_EDGES = 200;
/** Profondeur maximale de l'arborescence rendue (au-delà : résumé). */
const MAX_TREE_DEPTH = 3;
/** Nombre maximal d'entrées d'arborescence rendues. */
const MAX_TREE_ENTRIES = 400;
/** Plafond d'octets du diff git (aligné sur la borne Rust par défaut). */
const DEFAULT_DIFF_BYTES = 12_000;
const MAX_DIFF_BYTES = 40_000;

/** Pont vers les commandes Tauri (cf. `codeIndexTool.OriginInvoke`). */
export type OriginInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** Forme d'un symbole renvoyé par `search_symbols` (cf. `search.rs`). */
interface SymbolMatch {
  name: string;
  kind: string;
  path: string;
  line: number;
  line_content: string;
}

/** Forme d'une arête d'import (cf. `tree.rs`). */
interface ImportEdge {
  from: string;
  to: string;
}

/** Nœud d'arborescence (cf. `tree.rs::FileTreeNode`). */
interface FileTreeNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: FileTreeNode[];
}

/** Fichier au statut git (cf. `git.rs::StatusFile`). */
interface StatusFile {
  status: string;
  path: string;
}

/**
 * Vrai si le chemin est un chemin RELATIF sûr : ni absolu, ni remontant (`..`),
 * ni commençant par `-` (qui serait interprété comme une option git).
 */
function isSafeRelPath(path: string): boolean {
  const p = path.trim();
  if (p.length === 0) return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.startsWith("-")) return false;
  const segments = p.split(/[\\/]+/);
  return !segments.includes("..");
}

/**
 * Construit les outils de compréhension du projet pour une session.
 *
 * @param workspace racine du workspace (chemin absolu, FIGÉ à la construction).
 * @param originInvoke pont vers les commandes Tauri (voir `OriginInvoke`).
 */
export function buildProjectTools(workspace: string, originInvoke: OriginInvoke) {
  // ── project_overview ───────────────────────────────────────────────────────
  // Vue synthétique : arborescence bornée + état d'index. Permet au modèle de
  // se repérer sans lire les fichiers un par un.
  const projectOverview = createTool({
    name: "project_overview",
    description:
      "Get a bounded overview of the project structure: a depth-limited file tree " +
      "and whether the local codebase index is built. Use this FIRST on an unfamiliar " +
      "project to orient yourself before reading files.",
    inputSchema: z.object({
      depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { depth?: number }) {
      try {
        const depth = Math.min(Math.max(input.depth ?? 2, 1), MAX_TREE_DEPTH);
        const raw = await originInvoke("get_file_tree", { folder: workspace });
        const tree = JSON.parse(raw) as FileTreeNode;
        const lines: string[] = [];
        let count = 0;
        const walk = (node: FileTreeNode, level: number) => {
          if (count >= MAX_TREE_ENTRIES) return;
          const indent = "  ".repeat(level);
          const suffix = node.is_dir ? "/" : "";
          lines.push(`${indent}${node.name}${suffix}`);
          count += 1;
          if (node.is_dir && level < depth) {
            for (const child of node.children) walk(child, level + 1);
          }
        };
        walk(tree, 0);
        const truncated = count >= MAX_TREE_ENTRIES ? "\n… (tree truncated)" : "";
        return {
          output: `Project tree (root: ${workspace}, depth ${depth}):\n${lines.join("\n")}${truncated}`,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `project_overview failed: ${message}`, isError: true };
      }
    },
  });

  // ── git_status ─────────────────────────────────────────────────────────────
  // État git (fichiers modifiés/staged/non suivis). Indispensable pour éviter
  // d'écraser un travail en cours et pour cibler un diff.
  const gitStatus = createTool({
    name: "git_status",
    description:
      "List the git working-tree status of the project: modified, staged and untracked " +
      "files with their status codes. Read-only. Use it to see what has changed before " +
      "reviewing or editing code.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      try {
        const raw = await originInvoke("git_status_files", { path: workspace });
        const files = JSON.parse(raw) as StatusFile[];
        if (!Array.isArray(files) || files.length === 0) {
          return { output: "Working tree is clean (no changes).", isError: false };
        }
        const lines = files.map((f) => `${f.status.padEnd(3)} ${f.path}`).join("\n");
        return {
          output: `${files.length} changed file(s):\n${lines}`,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `git_status failed: ${message}`, isError: true };
      }
    },
  });

  // ── git_diff ───────────────────────────────────────────────────────────────
  // Diff des changements par rapport à HEAD (staged + unstaged). Lecture seule.
  const gitDiff = createTool({
    name: "git_diff",
    description:
      "Show the git diff (staged + unstaged) of the working tree against HEAD, or the " +
      "pending diff of a single relative file. Read-only, byte-capped. Use it to review " +
      "your own changes or the current modifications before deciding an action.",
    inputSchema: z.object({
      file: z
        .string()
        .max(400)
        .optional()
        .describe("Optional workspace-relative file path to limit the diff to one file."),
      maxBytes: z.number().int().min(1_000).max(MAX_DIFF_BYTES).optional(),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { file?: string; maxBytes?: number }) {
      const cap = Math.min(Math.max(input.maxBytes ?? DEFAULT_DIFF_BYTES, 1_000), MAX_DIFF_BYTES);
      try {
        // Un chemin absolu ou remontant est REFUSÉ : on ne laisse pas le modèle
        // sortir du workspace via un diff ciblé.
        if (input.file !== undefined && !isSafeRelPath(input.file)) {
          return {
            output: `git_diff refused: "${input.file}" is not a safe workspace-relative path.`,
            isError: true,
          };
        }
        const raw = await originInvoke("git_diff", {
          path: workspace,
          max_bytes: cap,
        });
        // La commande Rust renvoie directement la chaîne de diff (pas de JSON).
        const diff = raw ?? "";
        if (diff.trim().length === 0) {
          return { output: "No pending changes (working tree matches HEAD).", isError: false };
        }
        // Si un fichier est demandé, on filtre les sections du diff le concernant.
        const body =
          input.file !== undefined ? filterDiffForFile(diff, input.file) : diff;
        if (body.trim().length === 0) {
          return {
            output: `No pending changes for "${input.file}".`,
            isError: false,
          };
        }
        return { output: body, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `git_diff failed: ${message}`, isError: true };
      }
    },
  });

  // ── search_symbols ─────────────────────────────────────────────────────────
  // Recherche de définitions (fonctions/classes/types/…) par nom. Beaucoup plus
  // précis que du grep texte pour « où est définie X ».
  const searchSymbols = createTool({
    name: "search_symbols",
    description:
      "Search for code SYMBOLS (functions, classes, interfaces, types, structs, enums…) " +
      "by name across the project. Returns each symbol's kind, file and line. Use it to " +
      "locate a DEFINITION precisely, instead of grepping raw text.",
    inputSchema: z.object({
      query: z.string().min(1).max(MAX_QUERY_LEN),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { query: string }) {
      try {
        const raw = await originInvoke("search_symbols", {
          folder: workspace,
          query: input.query.slice(0, MAX_QUERY_LEN),
        });
        const symbols = JSON.parse(raw) as SymbolMatch[];
        if (!Array.isArray(symbols) || symbols.length === 0) {
          return { output: `No symbol matched "${input.query}".`, isError: false };
        }
        const shown = symbols.slice(0, MAX_SYMBOLS);
        const lines = shown
          .map((s) => `${s.kind} ${s.name} — ${s.path}:${s.line}`)
          .join("\n");
        const more = symbols.length > shown.length ? `\n… ${symbols.length - shown.length} more` : "";
        return { output: `${symbols.length} symbol(s):\n${lines}${more}`, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `search_symbols failed: ${message}`, isError: true };
      }
    },
  });

  // ── find_imports ───────────────────────────────────────────────────────────
  // Dépendances d'imports (graphe from→to). Pour évaluer l'impact d'un
  // changement (« qui dépend de quoi »).
  const findImports = createTool({
    name: "find_imports",
    description:
      "List the import dependencies of the project as from→to file edges (relative " +
      "JS/TS imports). Use it to understand how modules depend on each other before " +
      "changing or deleting a file.",
    inputSchema: z.object({
      file: z
        .string()
        .max(400)
        .optional()
        .describe("Optional workspace-relative file path: only show edges touching it."),
    }),
    lifecycle: { completesRun: false },
    async execute(input: { file?: string }) {
      try {
        if (input.file !== undefined && !isSafeRelPath(input.file)) {
          return {
            output: `find_imports refused: "${input.file}" is not a safe workspace-relative path.`,
            isError: true,
          };
        }
        const raw = await originInvoke("get_import_edges", { folder: workspace });
        const edges = JSON.parse(raw) as ImportEdge[];
        if (!Array.isArray(edges) || edges.length === 0) {
          return { output: "No import edges found.", isError: false };
        }
        const needle = input.file?.trim();
        const filtered =
          needle === undefined
            ? edges
            : edges.filter((e) => e.from.endsWith(needle) || e.to.endsWith(needle));
        if (filtered.length === 0) {
          return { output: `No import edge touches "${needle}".`, isError: false };
        }
        const shown = filtered.slice(0, MAX_EDGES);
        const lines = shown.map((e) => `${e.from} → ${e.to}`).join("\n");
        const more =
          filtered.length > shown.length ? `\n… ${filtered.length - shown.length} more` : "";
        return {
          output: `${filtered.length} import edge(s):\n${lines}${more}`,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `find_imports failed: ${message}`, isError: true };
      }
    },
  });

  return [projectOverview, gitStatus, gitDiff, searchSymbols, findImports];
}

/**
 * Filtre un diff unifié multi-fichiers pour ne garder que les sections
 * concernant un fichier relatif donné. Un diff git a la forme :
 *   diff --git a/<path> b/<path>
 *   <lignes…>
 *   diff --git a/<autre> b/<autre>
 *   …
 * On regroupe les lignes par bloc `diff --git` et on garde ceux dont le chemin
 * de destination correspond. Correspondance par SUFFIXE : l'entrée modèle peut
 * être partielle (basename), et les chemins du diff sont relatifs à la racine du
 * dépôt, pas forcément identiques au workspace.
 */
function filterDiffForFile(diff: string, file: string): string {
  const lines = diff.split("\n");
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  const needle = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const kept = blocks.filter((block) => {
    const header = block[0] ?? "";
    // Extrait les deux chemins du header `diff --git a/X b/Y`.
    const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) return false;
    const [, aPath, bPath] = match;
    return (
      aPath === needle ||
      bPath === needle ||
      aPath.endsWith(`/${needle}`) ||
      bPath.endsWith(`/${needle}`) ||
      aPath.endsWith(needle) ||
      bPath.endsWith(needle)
    );
  });
  return kept.map((b) => b.join("\n")).join("\n");
}
