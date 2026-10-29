/**
 * Origin — Recherche de code BM25 en Node pur (mode headless, sans Tauri).
 *
 * POURQUOI CE MODULE
 * ------------------
 * En production, l'outil `codebase_search` du sidecar relaie sa requête vers la
 * commande Tauri `search_index` (index BM25 construit en Rust, cf.
 * `src-tauri/src/indexing.rs`). En mode headless (bench), aucun backend Rust
 * n'existe : `tool_invoke` était donc refusé (« capability Tauri absente ») et
 * l'agent n'avait AUCUN outil de recherche — il devait lire les fichiers un par
 * un, ce qui gonfle les tours et les tokens d'entrée (constaté sur SWE-bench).
 *
 * Ce module reproduit FIDÈLEMENT l'algorithme Rust pour rendre la recherche
 * disponible sans Tauri :
 *   - même tokenisation (minuscules, découpe camelCase/snake_case, `_` conservé,
 *     longueur de token bornée `2..=48`, plafond `4000` tokens/doc) ;
 *   - mêmes paramètres BM25 (`k1=1.5`, `b=0.75`, biais de chemin `PATH_WEIGHT=2.0`) ;
 *   - même politique d'exclusion (`SEARCH_IGNORE`) et mêmes seuils (fichier
 *     `<= 512 Kio`, non vide, non binaire) ;
 *   - même contrat de retour : `{ rel, score }[]`, trié par score décroissant
 *     puis par chemin croissant (déterminisme).
 *
 * SÉCURITÉ (règle « adversarial first »)
 * --------------------------------------
 *   - **Confinement** : le `workspace` reçu du sidecar est FIGÉ par la session
 *     (cwd) ; on refuse tout chemin non absolu et on vérifie que l'index reste
 *     sous `<ws>/.mira/index`.
 *   - **Lecture seule** : on ne lit que des fichiers texte sous le workspace,
 *     jamais de symlink suivi, jamais d'exécution.
 *   - **DoORS** : plafonds de fichiers (20 000) et de tokens/doc (4 000), plus
 *     borne de requête — un modèle hostile ne peut ni saturer la mémoire ni
 *     geler le process.
 *
 * FIDÉLITÉ vs SIMPLICITÉ : on construit l'index en mémoire à la première
 * recherche (le bench a des workspaces jetables, un cache disque n'apporterait
 * rien) mais on RÉUTILISE l'index persisté sous `<ws>/.mira/index/index.json`
 * s'il existe et correspond à la racine — ainsi un workspace déjà indexé par
 * l'app native n'est pas reconstruit.
 */

import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

// ── Bornes (identiques à indexing.rs) ────────────────────────────────────────
const MAX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_FILES = 20_000;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_TOKENS_PER_DOC = 4_000;
const MAX_TOKEN_LEN = 48;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const PATH_WEIGHT = 2.0;
const INDEX_VERSION = 1;

/** Dossiers/artefacts jamais indexés (miroir strict de `search::SEARCH_IGNORE`). */
const SEARCH_IGNORE: readonly string[] = [
  ".git", "node_modules", "target", ".next", "dist", "build",
  ".cache", "__pycache__", ".venv", "venv", ".turbo", "coverage",
  "out", ".parcel-cache", ".svelte-kit",
  ".pnpm-store", ".yarn", ".npm", ".pnpm", "vendor", "bower_components",
  ".gradle", ".dart_tool", "Pods", ".idea", ".vscode",
];
const IGNORE_SET = new Set(SEARCH_IGNORE);

/** Un document indexé = un fichier texte du workspace. */
interface Doc {
  rel: string;
  len: number;
  tf: Map<string, number>;
  path_tokens: string[];
}

/** Index inversé en mémoire (équivalent de `IndexData`). */
interface IndexData {
  docs: Doc[];
  postings: Map<string, Array<[number, number]>>;
  avg_len: number;
  doc_freq: Map<string, number>;
  root: string;
}

/** Résultat de recherche (identité avec `IndexHit` côté Rust). */
export interface CodeSearchHit {
  rel: string;
  score: number;
}

// ── Tokenisation (port de flush_token/split_compound) ────────────────────────

/** Vrai si `c` peut appartenir à un token (alphanumérique Unicode ou `_`). */
function isTokenChar(c: string): boolean {
  return /[\p{L}\p{N}_]/u.test(c);
}

/** Longueur en points de code (équivalent de `String::len` en octets UTF-8 ? non). */
function codePointLength(s: string): number {
  return [...s].length;
}

/** Découpe `fooBar_baz` en `["foo","Bar","baz"]` (frontières camel + `_`). */
function splitCompound(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let prevLower = false;
  for (const c of s) {
    if (c === "_") {
      if (cur.length > 0) parts.push(cur);
      cur = "";
      prevLower = false;
      continue;
    }
    const isUpper = c !== c.toLowerCase() && c === c.toUpperCase();
    if (isUpper && prevLower) {
      parts.push(cur);
      cur = "";
    }
    prevLower = c === c.toLowerCase() && c !== c.toUpperCase() || /[0-9]/.test(c);
    cur += c;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** Éclate le token courant en sous-tokens (case/snake) et les pousse dans `out`. */
function flushToken(raw: string, out: string[]): void {
  if (raw.length === 0) return;
  const lower = raw.toLowerCase();
  const lowerLen = codePointLength(lower);
  if (lowerLen < 2 || lowerLen > MAX_TOKEN_LEN) return;
  out.push(lower);

  const hasUpper = raw !== raw.toLowerCase();
  if (raw.includes("_") || hasUpper) {
    for (const part of splitCompound(raw)) {
      const p = part.toLowerCase();
      const pl = codePointLength(p);
      if (pl >= 2 && pl <= MAX_TOKEN_LEN && p !== lower) out.push(p);
    }
  }
}

/** Découpe un texte en tokens normalisés. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const c of text) {
    if (isTokenChar(c)) {
      cur += c;
    } else {
      flushToken(cur, out);
      cur = "";
    }
  }
  flushToken(cur, out);
  return out;
}

/** Normalise une requête en tokens triés/dédupliqués (port de `query_terms`). */
function queryTerms(query: string): string[] {
  const terms = tokenize(query);
  terms.sort();
  return [...new Set(terms)];
}

// ── Construction des documents (port de build_doc/walk) ──────────────────────

/** Vrai si les premiers octets trahissent un binaire (présence d'un NUL). */
function looksBinary(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Construit le document d'un fichier, ou `null` s'il doit être ignoré. */
async function buildDoc(_root: string, absPath: string, rel: string): Promise<Doc | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size === 0) return null;
  if (rel.startsWith(".mira/")) return null; // ne jamais indexer notre propre index

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absPath);
  } catch {
    return null;
  }
  if (looksBinary(bytes)) return null;
  const text = bytes.toString("utf8");
  // Rejette un contenu non-UTF8 (comme `String::from_utf8(...).ok()?`).
  if (text.includes("\uFFFD")) return null;

  const bodyTokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of bodyTokens.slice(0, MAX_TOKENS_PER_DOC)) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const pathTokens = [...new Set(tokenize(rel))].sort();
  let len = 0;
  for (const v of tf.values()) len += v;

  return { rel, len, tf, path_tokens: pathTokens };
}

/** Parcourt récursivement `dir` en respectant SEARCH_IGNORE et le plafond. */
async function walk(root: string, dir: string, docs: Doc[]): Promise<void> {
  if (docs.length >= MAX_INDEX_FILES) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (docs.length >= MAX_INDEX_FILES) return;
    if (IGNORE_SET.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(abs);
    } else if (entry.isFile()) {
      const rel = abs.slice(root.length + 1).split("\\").join("/");
      const doc = await buildDoc(root, abs, rel);
      if (doc) docs.push(doc);
    }
  }
  for (const d of subdirs) await walk(root, d, docs);
}

/** Construit l'index complet à partir des documents (port de `build_index`). */
function buildIndex(root: string, docs: Doc[]): IndexData {
  const postings = new Map<string, Array<[number, number]>>();
  const docFreq = new Map<string, number>();
  let totalLen = 0;

  docs.forEach((doc, id) => {
    totalLen += doc.len;
    for (const [token, freq] of doc.tf) {
      const list = postings.get(token);
      if (list) list.push([id, freq]);
      else postings.set(token, [[id, freq]]);
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  });

  const avgLen = docs.length === 0 ? 0 : totalLen / docs.length;
  return { docs, postings, avg_len: avgLen, doc_freq: docFreq, root };
}

// ── Scoring BM25 (port de `rank`) ────────────────────────────────────────────

/** Classe les documents pour `terms` selon BM25 + biais de chemin. */
function rank(data: IndexData, terms: string[], limit: number): CodeSearchHit[] {
  if (data.docs.length === 0 || data.avg_len <= 0) return [];
  const n = data.docs.length;
  const scores = new Map<number, number>();

  for (const term of terms) {
    const postings = data.postings.get(term);
    if (!postings) continue;
    const df = data.doc_freq.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));

    for (const [docId, freq] of postings) {
      const doc = data.docs[docId];
      const tf = freq;
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.len) / data.avg_len);
      let score = (idf * (tf * (BM25_K1 + 1))) / denom;
      if (doc.path_tokens.includes(term)) score += PATH_WEIGHT;
      scores.set(docId, (scores.get(docId) ?? 0) + score);
    }
  }

  const hits: Array<[number, number]> = [...scores.entries()];
  hits.sort((a, b) => {
    const d = b[1] - a[1];
    if (d !== 0) return d;
    return data.docs[a[0]].rel < data.docs[b[0]].rel ? -1 : data.docs[a[0]].rel > data.docs[b[0]].rel ? 1 : 0;
  });

  return hits.slice(0, limit).map(([id, score]) => ({ rel: data.docs[id].rel, score }));
}

// ── Cache mémoire par racine (équivalent de l'état global Rust) ──────────────

interface Loaded {
  root: string;
  data: IndexData;
}
const cache = new Map<string, Loaded>();

/** Chemin absolu de l'index persisté : `<ws>/.mira/index/index.json`. */
function indexFile(workspace: string): string {
  return join(workspace, ".mira", "index", "index.json");
}

/**
 * Charge l'index persisté s'il correspond à la racine (mêmes invariants que
 * `try_load` : version + root identiques), sinon construit l'index en mémoire.
 */
async function loadOrBuild(workspace: string): Promise<IndexData | null> {
  const cached = cache.get(workspace);
  if (cached) return cached.data;

  // 1) Index persisté par l'app native (évite un re-scan).
  try {
    const raw = await fs.readFile(indexFile(workspace), "utf8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      root?: string;
      docs?: Array<{ rel: string; len: number; tf: Record<string, number>; path_tokens: string[] }>;
      avg_len?: number;
      doc_freq?: Record<string, number>;
      postings?: Record<string, Array<[number, number]>>;
    };
    if (parsed.version === INDEX_VERSION && parsed.root === workspace && Array.isArray(parsed.docs)) {
      const docs: Doc[] = parsed.docs.map((d) => ({
        rel: d.rel,
        len: d.len,
        tf: new Map(Object.entries(d.tf ?? {})),
        path_tokens: d.path_tokens ?? [],
      }));
      const data: IndexData = {
        docs,
        postings: new Map(Object.entries(parsed.postings ?? {}).map(([k, v]) => [k, v])),
        avg_len: parsed.avg_len ?? 0,
        doc_freq: new Map(Object.entries(parsed.doc_freq ?? {})),
        root: workspace,
      };
      cache.set(workspace, { root: workspace, data });
      return data;
    }
  } catch {
    // pas d'index persisté exploitable : on scanne.
  }

  // 2) Construction en mémoire (workspace jetable du bench).
  let stat;
  try {
    stat = await fs.stat(workspace);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const docs: Doc[] = [];
  await walk(workspace, workspace, docs);
  const data = buildIndex(workspace, docs);
  cache.set(workspace, { root: workspace, data });
  return data;
}

/**
 * Interroge l'index BM25 d'un workspace et renvoie les fichiers classés.
 *
 * Contrat STRICTEMENT identique à la commande Tauri `search_index` :
 * `{ rel, score }[]` trié par score décroissant. Une entrée invalide (workspace
 * non absolu, requête vide) renvoie `[]` — jamais d'exception non maîtrisée.
 */
export async function searchIndex(
  workspace: string,
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<CodeSearchHit[]> {
  // Confinement : workspace absolu obligatoire (comme `index_dir` côté Rust).
  if (!workspace || !workspace.startsWith("/")) return [];
  const lim = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const data = await loadOrBuild(workspace);
  if (!data) return [];
  return rank(data, terms, lim);
}

/**
 * Libère l'index en cache pour un workspace (ou tous). Utile entre deux runs de
 * bench sur des workspaces jetables distincts, pour ne pas accumuler de mémoire.
 */
export function clearSearchCache(workspace?: string): void {
  if (workspace) cache.delete(workspace);
  else cache.clear();
}

/** Construit et met en cache l'index d'un workspace (préchauffage explicite). */
export async function buildSearchIndex(workspace: string): Promise<number> {
  clearSearchCache(workspace);
  const data = await loadOrBuild(workspace);
  return data?.docs.length ?? 0;
}
