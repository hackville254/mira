/**
 * Mira — Outil CUSTOM `codebase_search` (sidecar Cline).
 *
 * RÔLE
 * ----
 * Exposer à l'agent **notre index local de codebase** (BM25, cf.
 * `src-tauri/src/indexing.rs`) sous forme d'outil qu'il appelle LUI-MÊME quand
 * il cherche où se trouve quelque chose. Sans cet outil, le modèle n'aurait
 * aucun moyen de formuler une requête « par sens » sur le projet : il ne
 * pourrait que lire les fichiers un par un.
 *
 * POURQUOI UN OUTIL CUSTOM (et pas `search_codebase` du SDK)
 * ---------------------------------------------------------
 * Le SDK Cline fournit DÉJÀ un `search_codebase`, mais son implémentation est
 * interne au SDK : on ne peut ni la router vers notre index local ni garantir
 * qu'elle reste hors-ligne. On ajoute donc notre propre outil, `codebase_search`,
 * dont on MAÎTRISE à 100 % l'exécution (requête → index Rust local).
 *
 * POURQUOI ICI (Node) ET PAS CÔTÉ FRONT
 * -------------------------------------
 * Les outils sont exécutés par le MOTEUR d'agent : leur définition doit vivre
 * dans le même process que lui. L'outil ne fait RIEN localement : il relaie la
 * requête vers la commande Tauri `search_index` via le pont `tool_invoke`
 * (cf. `originInvoke`), et le front répond avec la liste des fichiers trouvés.
 *
 * SÉCURITÉ
 * --------
 *   - **Lecture seule** : l'outil n'écrit jamais rien ; il interroge un index
 *     déjà construit. Auto-approuvé côté `TOOL_POLICIES` (comme les autres
 *     lectures), sinon une carte de confirmation à chaque recherche.
 *   - **Entrée bornée** : `query` non vide et longueur plafonnée, `limit` borné
 *     (`1..=MAX_LIMIT`). Un modèle hostile ne peut ni vider l'index ni saturer
 *     la mémoire de la webview.
 *   - **Aucune exécution** : on ne fait que transmettre des chaînes ; le nom de
 *     commande envoyé (`search_index`) est FIGÉ ici, jamais choisi par le modèle
 *     ni par le front.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Longueur maximale de la requête (borne anti-abus). */
const MAX_QUERY_LEN = 300;
/** Nombre de résultats renvoyés par défaut. */
const DEFAULT_LIMIT = 12;
/** Nombre maximal de résultats (aligné sur la borne Rust `MAX_LIMIT`). */
const MAX_LIMIT = 50;

/** Commande Tauri invoquée (figée : le modèle ne peut pas la choisir). */
const SEARCH_COMMAND = "search_index";

/** Forme d'un hit renvoyé par `search_index` (cf. `indexing.rs`). */
interface IndexHit {
  rel: string;
  score: number;
}

/**
 * Relaie une commande Tauri depuis le sidecar (pont `tool_invoke`).
 * Le front vérifie l'allowlist puis exécute `invoke` et renvoie la réponse.
 */
export type OriginInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Construit l'outil `codebase_search` pour une session.
 *
 * @param workspace racine du workspace indexé (chemin absolu).
 * @param originInvoke pont vers les commandes Tauri (voir `OriginInvoke`).
 */
export function buildCodeIndexTool(workspace: string, originInvoke: OriginInvoke) {
  const codebaseSearch = createTool({
    name: "codebase_search",
    description:
      "Search the project's LOCAL codebase index to find files relevant to a query. " +
      "Returns a ranked list of workspace-relative file paths (best first). Use it FIRST " +
      "when you need to locate where something is defined or mentioned, before reading " +
      "files one by one. The query is free text (identifiers, concepts, words).",
    inputSchema: z.object({
      query: z.string().min(1).max(MAX_QUERY_LEN),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
    // Recherche = outil de reconnaissance, il ne termine pas le run.
    lifecycle: { completesRun: false },
    async execute(input: { query: string; limit?: number }) {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      try {
        const raw = await originInvoke(SEARCH_COMMAND, {
          workspace,
          query: input.query.slice(0, MAX_QUERY_LEN),
          limit,
        });
        const hits = JSON.parse(raw) as IndexHit[];
        if (!Array.isArray(hits) || hits.length === 0) {
          return {
            output: `No file matched "${input.query}". Try broader keywords, or the index may not be built yet.`,
            isError: false,
          };
        }
        const lines = hits
          .map((h) => `- ${h.rel} (score ${Number(h.score).toFixed(2)})`)
          .join("\n");
        return {
          output: `Top ${hits.length} match(es) for "${input.query}":\n${lines}`,
          isError: false,
        };
      } catch (error) {
        // On remonte un ÉCHEC explicite : un outil qui « réussit » en ne
        // renvoyant rien tromperait le modèle (il croirait le projet vide).
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: `codebase_search failed: ${message}`,
          isError: true,
        };
      }
    },
  });

  return codebaseSearch;
}
