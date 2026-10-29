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

/**
 * Puce du contrat décrivant l'outil `skills`.
 *
 * POURQUOI cette puce est détaillée : le SDK Cline expose l'outil `skills` avec
 * sa propre description (qui inclut la liste `Available skills: …`), mais un
 * modèle d'agent a une forte tendance à répondre DIRECTEMENT sans aller
 * chercher l'aide disponible. La consigne doit donc être ACTIVE : vérifier la
 * liste d'abord, puis invoquer dès qu'une skill correspond, plutôt qu'une
 * formulation passive (« invoke … when it matches ») qui était ignorée.
 *
 * Le format d'appel est celui du SDK (vérifié dans `@cline/core`) :
 * `skill` = nom EXACT (requis), `args` = chaîne optionnelle (jamais un objet).
 * On ne cite PAS la liste ici : elle est injectée dynamiquement par le SDK dans
 * la description de l'outil, donc propre à chaque workspace.
 */
export const SKILLS_CONTRACT_LINE = [
  "- `skills`: run a configured skill when one fits the task. Check the `Available skills` list in this tool's description FIRST, then call `skills` with `skill` = the EXACT name (required) and optional `args` (a plain string, e.g. a glob or URL). A skill must win over improvising when its description matches; never claim a skill not in that list. One call runs one skill; chain several if needed.",
].join("\n");

/** Outils exposés en mode Agent (act), dans l'ordre de présentation. */
export const FULL_TOOL_NAMES =
  "read_files, search_codebase, codebase_search, project_overview, git_status, git_diff, search_symbols, find_imports, detect_checks, editor, run_commands, fetch_web_content, skills, ask_question, todo_write, todo_read, browser_navigate/query/read_text/read_dom/click/type/press_key/screenshot/status/reload, browser_list_tabs/open_tab/close_tab/activate_tab";

/** Outils exposés en mode Plan / ASK (read-only) : aucune écriture possible. */
export const READ_ONLY_TOOL_NAMES =
  "read_files, search_codebase, run_commands, fetch_web_content, skills, ask_question, todo_write, todo_read, browser_status/read_text/read_dom/query/screenshot, browser_list_tabs/activate_tab";

/**
 * Bloc du contrat décrivant le NAVIGATEUR PILOTÉ (parité Trae SOLO). Mutualisé
 * entre les deux modes : la navigation est une lecture du monde extérieur, mais
 * certaines actions (clic, saisie) modifient la page — elles restent donc
 * cantonnées au mode Agent.
 */
const BROWSER_CONTRACT_ACT = [
  "- Embedded preview (parity with Trae SOLO). `browser_navigate`: open an absolute http(s) URL (dev server, e.g. http://localhost:5173); external hosts may need confirmation.",
  "- `browser_query` lists interactive elements with a stable `ref` (`e0`, `e1`…): call it BEFORE `browser_click`/`browser_type` and target by `ref`, not CSS. `browser_press_key` sends `Enter`/`Tab`. Inspect with `browser_read_text`/`read_dom`/`screenshot`/`status`/`reload`.",
  "- Tabs: `browser_list_tabs` gives each tab an opaque `tabId`; the tools above act on the ACTIVE tab. `browser_open_tab`/`activate_tab`/`close_tab` manage them. Never invent a `tabId`.",
].join("\n");

/** Variante lecture seule du contrat navigateur (mode Plan / ASK). */
const BROWSER_CONTRACT_READ_ONLY = [
  "- Inspect the embedded preview only: `browser_status`, `browser_read_text`, `browser_read_dom`, `browser_query` (elements with `ref`), `browser_screenshot`. No `browser_navigate`/`click`/`type` here.",
  "- Tabs: `browser_list_tabs` lists them (opaque `tabId`); tools act on the ACTIVE tab, `browser_activate_tab` switches it. No opening/closing here.",
].join("\n");

/**
 * Contrat des outils de COMPRÉHENSION DU PROJET (mode Agent uniquement).
 *
 * POURQUOI : ces outils donnent une vision STRUCTURELLE (arborescence, git,
 * symboles, dépendances) que `read_files`/`search_codebase` n'offrent pas. Sur
 * un gros projet, ils évitent de lire les fichiers un par un. Tous en LECTURE
 * seule. On apprend au modèle QUAND les utiliser (reconnaissance d'abord).
 */
const PROJECT_CONTRACT_ACT = [
  "- Project comprehension (read-only; orient yourself on a large codebase BEFORE editing):",
  "  - `project_overview`: bounded file tree (`depth` 1-3). `search_symbols`: DEFINITION by name (sharper than grep).",
  "  - `git_status` / `git_diff` / `find_imports`: working tree, diff vs HEAD, import edges (optional `file`).",
].join("\n");

/**
 * Contrat du CONTRÔLE QUALITÉ (mode Agent uniquement).
 *
 * POURQUOI : sur un projet inconnu, le modèle ne devine pas les commandes de
 * vérification réelles (tel script npm, tel runner de tests). `detect_checks`
 * les DÉTECTE depuis les manifestes du projet. Il ne les EXÉCUTE PAS : le modèle
 * lance ensuite la commande choisie via `run_commands` (chemin d'exécution
 * unique). Insister sur « verify BEFORE reporting success » est le cœur de la
 * boucle de vérification.
 */
const QUALITY_CONTRACT_ACT = [
  "- Quality checks (read-only discovery; know how to VERIFY before claiming success):",
  "  - `detect_checks`: list the project's own verification commands (typecheck, tests, lint, build) read from its manifests.",
  "  - These are commands to RUN via `run_commands` — never assume a command exists. Verify the change BEFORE reporting it done.",
].join("\n");

/**
 * Contrat d'outils du mode Agent. Chaque puce documente UN outil : son rôle et
 * son usage. C'est ce qui apprend au modèle la mécanique RÉELLE (notamment la
 * limite de 6000 caractères de `editor`, qui n'est pas devinable).
 */
export const TOOL_CONTRACT_FULL = [
  "## Tools",
  "- `read_files`: read one or more files. Prefer one call with several paths over one call per file.",
  "- `search_codebase`: search the workspace by pattern or meaning. Use it before opening files to locate what matters.",
  "- `codebase_search`: search the LOCAL codebase index (fast, offline, ranked workspace-relative paths). Use it FIRST to locate code.",
  PROJECT_CONTRACT_ACT,
  QUALITY_CONTRACT_ACT,
  "- `editor`: the primary way to create or edit files. Match the call to your intent:",
  "  - CREATE a file: `path` + `new_text`, and NO `old_text`.",
  "  - REPLACE in an existing file: `path` + `old_text` + `new_text` (omitting `old_text` on an existing file fails).",
  "  - APPEND at end: `path` + `new_text` + `insert_line = line_count + 1`.",
  "  - `insert_line` is one-based (1 to `line_count + 1`); `new_text` is inserted BEFORE that line.",
  "  - HARD LIMIT: `old_text` and `new_text` are each capped at 6000 characters. Never send a whole large file at once: create it with a first chunk, then append the rest via `insert_line = line_count + 1`.",
  "  - `old_text` must be copied VERBATIM (indentation included) and match EXACTLY ONE location (3 to 5 lines of unique context): 0 matches fail with \"text not found\", more than 1 with \"multiple occurrences\".",
  "- `run_commands`: run shell commands in the workspace (builds, tests, git, package managers).",
  "- `fetch_web_content`: fetch and read content from URLs (documentation, references).",
  SKILLS_CONTRACT_LINE,
  `- \`todo_write\`: publish the live task checklist. Call it with the FULL list; each item has an \`id\`, a \`content\` (one line), and a \`status\` (${TODO_STATUSES.join(" | ")}).`,
  "- `todo_read`: re-read the current checklist (rarely needed: the list is shown to the user).",
  BROWSER_CONTRACT_ACT,
].join("\n");

/** Contrat d'outils du mode Plan / ASK : lecture seule, aucune écriture. */
export const TOOL_CONTRACT_READ_ONLY = [
  "## Tools (read-only)",
  "- `read_files`: read one or more files. Prefer one call with several paths.",
  "- `search_codebase`: search the workspace by pattern or meaning.",
  "- `run_commands`: run NON-mutating shell commands only (e.g. `git status`, listing). Never run anything that changes the workspace.",
  "- `fetch_web_content`: fetch and read content from URLs.",
  SKILLS_CONTRACT_LINE,
  `- \`todo_write\`: publish the live task checklist (items have \`id\`, \`content\`, \`status\` = ${TODO_STATUSES.join(" | ")}).`,
  "- `todo_read`: re-read the current checklist.",
  BROWSER_CONTRACT_READ_ONLY,
  "- There is NO file-editing tool in this mode: do not attempt to write, create, or modify files. Produce an answer or a plan instead.",
].join("\n");

/** Rappel inséré en mode ASK : le mode est en lecture seule malgré la demande. */
export const ASK_MODE_FILES_NOTE = [
  "## Changes in ASK mode",
  "ASK mode is read-only: you have no editing tool here. When the user asks you to change code, explain WHAT to change and WHERE (file and lines) instead of writing it, so they can switch to Agent mode to apply it.",
].join("\n");

// ── Contrats filtrés par les préférences d'outils (Settings › Agent) ──────────
//
// Chaque famille d'outils de la section Agent est associée à ses puces de
// contrat. Les puces sont retirées du prompt quand l'outil est désactivé : le
// modèle ne voit plus l'outil et ne l'appelle plus. Les entrées non
// désactivables (todo_*, skills, ask_question) ne figurent pas ici et restent
// TOUJOURS annoncées.

/** Puce(s) de contrat par famille d'outil désactivable. */
const CONTRACT_LINES_BY_TOOL: Record<string, string[]> = {
  read_files: [
    "- `read_files`: read one or more files. Prefer one call with several paths over one call per file.",
  ],
  search_codebase: [
    "- `search_codebase`: search the workspace by pattern or meaning. Use it before opening files to locate what matters.",
    "- `codebase_search`: search the LOCAL codebase index (fast, offline, ranked workspace-relative paths). Use it FIRST to locate code.",
  ],
  // Compréhension du projet : mode Agent UNIQUEMENT (cf. `buildFullToolContract`).
  // Jamais dans le contrat read-only — ces outils ne sont pas exposés en ask/plan.
  project: [PROJECT_CONTRACT_ACT],
  // Contrôle qualité : mode Agent UNIQUEMENT (cf. `buildFullToolContract`).
  quality: [QUALITY_CONTRACT_ACT],
  editor: [
    "- `editor`: the primary way to create or edit files. Match the call to your intent:",
    "  - CREATE a file: `path` + `new_text`, and NO `old_text`.",
    "  - REPLACE in an existing file: `path` + `old_text` + `new_text` (omitting `old_text` on an existing file fails).",
    "  - APPEND at end: `path` + `new_text` + `insert_line = line_count + 1`.",
    "  - `insert_line` is one-based (1 to `line_count + 1`); `new_text` is inserted BEFORE that line.",
    "  - HARD LIMIT: `old_text` and `new_text` are each capped at 6000 characters. Never send a whole large file at once: create it with a first chunk, then append the rest via `insert_line = line_count + 1`.",
    "  - `old_text` must be copied VERBATIM (indentation included) and match EXACTLY ONE location (3 to 5 lines of unique context): 0 matches fail with \"text not found\", more than 1 with \"multiple occurrences\".",
  ],
  run_commands: [
    "- `run_commands`: run shell commands in the workspace (builds, tests, git, package managers).",
  ],
  fetch_web_content: [
    "- `fetch_web_content`: fetch and read content from URLs (documentation, references).",
  ],
  browser: [], // géré à part (BROWSER_CONTRACT_ACT / READ_ONLY)
};

/**
 * Construit le contrat d'outils du mode Agent en omettant les familles
 * désactivées par l'utilisateur.
 */
export function buildFullToolContract(disabled: ReadonlySet<string> = new Set()): string {
  const lines: string[] = [
    "## Tools",
    ...flattenFamilies(["read_files", "search_codebase", "project", "quality", "editor", "run_commands", "fetch_web_content"], disabled),
    SKILLS_CONTRACT_LINE,
    `- \`todo_write\`: publish the live task checklist. Call it with the FULL list; each item has an \`id\`, a \`content\` (one line), and a \`status\` (${TODO_STATUSES.join(" | ")}).`,
    "- `todo_read`: re-read the current checklist (rarely needed: the list is shown to the user).",
  ];
  if (!disabled.has("browser")) lines.push(BROWSER_CONTRACT_ACT);
  return lines.join("\n");
}

/** Variante read-only (mode Plan / ASK) filtrée par les préférences d'outils. */
export function buildReadOnlyToolContract(disabled: ReadonlySet<string> = new Set()): string {
  const lines: string[] = [
    "## Tools (read-only)",
    ...flattenFamilies(["read_files", "search_codebase", "run_commands", "fetch_web_content"], disabled),
    SKILLS_CONTRACT_LINE,
    `- \`todo_write\`: publish the live task checklist (items have \`id\`, \`content\`, \`status\` = ${TODO_STATUSES.join(" | ")}).`,
    "- `todo_read`: re-read the current checklist.",
  ];
  if (!disabled.has("browser")) lines.push(BROWSER_CONTRACT_READ_ONLY);
  lines.push("- There is NO file-editing tool in this mode: do not attempt to write, create, or modify files. Produce an answer or a plan instead.");
  return lines.join("\n");
}

/** Concatène les puces de contrat des familles ACTIVES, dans l'ordre donné. */
function flattenFamilies(ids: string[], disabled: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (disabled.has(id)) continue;
    out.push(...(CONTRACT_LINES_BY_TOOL[id] ?? []));
  }
  return out;
}
