/**
 * Présentation des outils dans le prompt système.
 *
 * ── Source de vérité ───────────────────────────────────────────────────────────
 * Depuis la bascule vers le SDK Cline, le moteur d'agent est le SDK lui-même :
 * il expose ses PROPRES outils, dont les noms sont FIXES et documentés par le
 * SDK (`@cline/core`) :
 *
 *   read_files · search_codebase · run_commands · fetch_web_content ·
 *   apply_patch · editor · skills · ask_question · submit_and_exit
 *
 * Le prompt système doit décrire EXACTEMENT ces noms : un modèle qui lit un nom
 * inexistant (ex. `write_file`, `edit`, `bash_run` d'un ancien harness) appelle
 * un outil qui n'existe pas et échoue. Ce fichier est donc aligné sur les outils
 * réellement exposés par le SDK, et rien d'autre.
 *
 * Note de couplage : ces listes doivent rester alignées sur les outils du SDK
 * Cline (voir `cline-sidecar/node_modules/@cline/core`). Un test d'invariant
 * (voir __tests__/prompts.test.ts) verrouille les invariants de forme.
 */

/** Outils du mode Agent : lecture, recherche, édition, shell, web, skills, question. */
export const FULL_TOOLS_LIST =
  "`read_files`, `search_codebase`, `editor`, `apply_patch`, `run_commands`, `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit`";

/** Outils read-only exposés en mode Plan/ASK (exploration sans écriture). */
export const READ_ONLY_TOOLS_LIST =
  "`read_files`, `search_codebase`, `fetch_web_content`, `skills`, `ask_question`, `submit_and_exit`";

/** Note expliquant le cycle de revue des changements en mode ASK. */
export const ASK_MODE_FILES_NOTE = [
  "## Changes in ASK mode",
  "When the user asks you to modify code, use `editor` or `apply_patch` to make targeted changes. Each change is shown in a diff view with per-hunk Accept/Reject buttons before anything is written to disk.",
  "- Use `editor` for a targeted change in one file; use several `editor` calls for several files.",
  "- Never output full file contents in your reply: use the tools instead.",
  "- Split large writes across multiple `editor` calls (see the editing rules).",
].join("\n");
