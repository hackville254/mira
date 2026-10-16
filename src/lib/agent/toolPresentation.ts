/**
 * Contrat des outils dans le prompt système.
 *
 * ── Source de vérité : les flags RÉELS du SDK Cline ────────────────────────────
 * Le SDK Cline (`@cline/core`) n'embarque AUCUN prompt système natif : il fournit
 * les outils et laisse l'application écrire les consignes. Le prompt système
 * d'Origin est donc la SEULE description des outils que le modèle voit (aucune
 * extension n'est chargée : `getRegisteredRules()` est vide, cf. le sidecar).
 *
 * Les outils exposés dépendent du MODE SDK, sous forme de flags
 * (`@cline/core`, table `sn`) :
 *
 *   act  : read_files ✓ search_codebase ✓ run_commands ✓ fetch_web_content ✓
 *          editor ✓ skills ✓ ask_question ✓        | apply_patch ✗ submit_and_exit ✗
 *   plan : read_files ✓ search_codebase ✓ run_commands ✓ fetch_web_content ✓
 *          skills ✓ ask_question ✓                  | editor ✗ apply_patch ✗
 *
 * Conséquences DIRECTES sur le prompt (erreurs à ne jamais réintroduire) :
 *   - `apply_patch` est DÉSACTIVÉ par défaut dans TOUS les modes : l'annoncer
 *     ferait appeler un outil inexistant. On ne le mentionne donc PAS.
 *   - `editor` est DÉSACTIVÉ en mode `plan` (read-only) : l'annoncer en mode
 *     Plan/ASK ferait appeler un outil absent et échouer. Il n'apparaît QUE dans
 *     le contrat du mode Agent.
 *   - `todo_write`/`todo_read` sont des outils CUSTOM injectés par Origin via
 *     `extraTools` : on les documente ici, avec leur format.
 *
 * Comportement RÉEL de `editor` (vérifié dans le bundle `@cline/core`, fonction
 * `wa`), dont le prompt doit rendre compte car il n'est pas devinable :
 *   - fichier ABSENT                → crée le fichier avec `new_text` (`old_text` ignoré) ;
 *   - fichier PRÉSENT + `old_text`  → remplace, à condition que `old_text` matche
 *     EXACTEMENT UNE fois (0 = "text not found", 2+ = "multiple occurrences") ;
 *   - fichier PRÉSENT, sans `old_text` → erreur "already exists, but `old_text` was omitted" ;
 *   - `insert_line` (1-based, plafonné à `line_count + 1`) → insère `new_text`
 *     AVANT cette ligne, sans exiger `old_text`. `line_count + 1` = ajout en fin.
 *   - `old_text` / `new_text` plafonnés à 6000 caractères chacun (limite dure).
 *
 * Couplage : ces listes doivent rester alignées sur les flags du SDK. Le test
 * `__tests__/prompts.test.ts` verrouille l'invariant « apply_patch jamais
 * annoncé, editor annoncé uniquement en mode Agent ».
 */

/** Statuts valides d'une entrée de la todo list (cf. `todoStore.TodoItem`). */
type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

/** Statuts rendus dans le prompt, dans l'ordre canonique. */
const TODO_STATUSES: TodoStatus[] = ["pending", "in_progress", "done", "cancelled"];

/** Outils exposés en mode Agent (act), dans l'ordre de présentation. */
export const FULL_TOOL_NAMES =
  "read_files, search_codebase, editor, run_commands, fetch_web_content, skills, ask_question, todo_write, todo_read";

/** Outils exposés en mode Plan / ASK (read-only) : aucune écriture possible. */
export const READ_ONLY_TOOL_NAMES =
  "read_files, search_codebase, run_commands, fetch_web_content, skills, ask_question, todo_write, todo_read";

/**
 * Contrat d'outils du mode Agent. Chaque puce documente UN outil : son rôle et
 * son usage. C'est ce qui apprend au modèle la mécanique RÉELLE (notamment la
 * limite de 6000 caractères de `editor`, qui n'est pas devinable).
 */
export const TOOL_CONTRACT_FULL = [
  "## Tools",
  "- `read_files`: read one or more files. Prefer one call with several paths over one call per file.",
  "- `search_codebase`: search the workspace by pattern or meaning. Use it before opening files to locate what matters.",
  "- `editor`: the primary way to create or edit files. Match the call to your intent:",
  "  - CREATE a file: `path` + `new_text`, and NO `old_text`.",
  "  - REPLACE in an existing file: `path` + `old_text` + `new_text` (omitting `old_text` on an existing file fails).",
  "  - APPEND at end: `path` + `new_text` + `insert_line = line_count + 1`.",
  "  - `insert_line` is a one-based boundary (1 to `line_count + 1`); `new_text` is inserted BEFORE that line.",
  "  - HARD LIMIT: `old_text` and `new_text` are each capped at 6000 characters. Never send a whole large file at once: create it with a first chunk, then append the rest via `insert_line = line_count + 1`.",
  "  - `old_text` must be copied VERBATIM (indentation included) and match EXACTLY ONE location (3 to 5 lines of unique context): 0 matches fail with \"text not found\", more than 1 with \"multiple occurrences\".",
  "- `run_commands`: run shell commands in the workspace (builds, tests, git, package managers).",
  "- `fetch_web_content`: fetch and read content from URLs (documentation, references).",
  "- `skills`: invoke a configured skill by name when it matches the task.",
  `- \`todo_write\`: publish the live task checklist. Call it with the FULL list; each item has an \`id\`, a \`content\` (one line), and a \`status\` (${TODO_STATUSES.join(" | ")}).`,
  "- `todo_read`: re-read the current checklist (rarely needed: the list is shown to the user).",
].join("\n");

/** Contrat d'outils du mode Plan / ASK : lecture seule, aucune écriture. */
export const TOOL_CONTRACT_READ_ONLY = [
  "## Tools (read-only)",
  "- `read_files`: read one or more files. Prefer one call with several paths.",
  "- `search_codebase`: search the workspace by pattern or meaning.",
  "- `run_commands`: run NON-mutating shell commands only (e.g. `git status`, listing). Never run anything that changes the workspace.",
  "- `fetch_web_content`: fetch and read content from URLs.",
  "- `skills`: invoke a configured skill by name when it matches the task.",
  `- \`todo_write\`: publish the live task checklist (items have \`id\`, \`content\`, \`status\` = ${TODO_STATUSES.join(" | ")}).`,
  "- `todo_read`: re-read the current checklist.",
  "- There is NO file-editing tool in this mode: do not attempt to write, create, or modify files. Produce an answer or a plan instead.",
].join("\n");

/** Rappel inséré en mode ASK : le mode est en lecture seule malgré la demande. */
export const ASK_MODE_FILES_NOTE = [
  "## Changes in ASK mode",
  "ASK mode is read-only: you have no editing tool here. When the user asks you to change code, explain WHAT to change and WHERE (file and lines) instead of writing it, so they can switch to Agent mode to apply it.",
].join("\n");
