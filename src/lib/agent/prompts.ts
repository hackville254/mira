/**
 * Module central des prompts système de Mira.
 *
 * ── Pourquoi ce fichier ────────────────────────────────────────────────────────
 * Les prompts étaient épars (constantes `full`/`lite` recopiées, texte dupliqué
 * entre modes) et difficiles à faire évoluer sans divergence. On unifie ici :
 *
 *   1. des BLOCS nommés, chacun porteur d'UNE responsabilité (identité, outils,
 *      règles d'édition, questions utilisateur, todos, délégation, style) ;
 *   2. un COMPOSEUR `composeSystemPrompt(spec)` qui assemble les blocs en sections
 *      séparées par des titres, de façon déclarative ;
 *   3. des PRESETS par mode (Agent/ASK/Plan, effort normal/max) obtenus en
 *      listant des blocs — plus aucune duplication de texte.
 *
 * Le composeur produit un prompt STRUCTURÉ (sections titrées + puces), inspiré de
 * Cline et jcode : un modèle suit mieux une consigne quand elle est organisée en
 * sections explicites qu'un unique pavé.
 *
 * Règle de ton : tous les prompts injectés au modèle sont en ANGLAIS (les
 * commentaires de ce dépôt restent en français).
 */

// ── Blocs réutilisables ────────────────────────────────────────────────────────

/**
 * Identité du modèle, paramétrée par le MODE réel et par le nom du produit.
 * Un seul endroit à changer si l'on renomme le produit.
 */
export function identity(mode: "agent" | "ask" | "plan"): string {
  switch (mode) {
    case "ask":
      return [
        `You are Mira AI, the coding assistant embedded in Mira, running in ASK mode.`,
        `Your job is to answer questions and explain code clearly and correctly.`,
        `You may still apply targeted edits when the user asks for them, but you never start changing code on your own initiative.`,
      ].join("\n");
    case "plan":
      return [
        `You are Mira AI, the coding assistant embedded in Mira, running in PLAN mode.`,
        `Your job is to analyze the codebase and produce a structured implementation plan. You are READ-ONLY: you never write, edit, or run anything that changes the workspace.`,
      ].join("\n");
    default:
      return [
        `You are Mira AI, the coding assistant embedded in Mira, running in AGENT mode.`,
        `Your job is to complete coding tasks end to end: understand the request, investigate the code, then make the changes.`,
      ].join("\n");
  }
}

/**
 * Politique de réponse en mode ASK : c'est le mode des questions, il doit dire
 * COMMENT répondre (citer le code, ne pas inventer) — pas seulement quoi faire
 * des fichiers. Placé après CONCISION (principe comportemental).
 */
export const ASK_ANSWER_RULES = [
  "## Answering",
  "- Ground every claim in the actual code: read the relevant files before answering and cite them by path and line.",
  "- If the code does not answer the question, say so plainly instead of guessing. Distinguish what you verified from what you infer.",
  "- Explain the why, not just the what. Keep it tight; the user can open the files you point to.",
].join("\n");

/**
 * Politique de liens dans les réponses.
 *
 * BUT : l'agent ne doit pas inventer d'URL (docs, issues, PR, pages) qui
 * n'existent pas ou renvoient un 404. Ce bloc est volontairement NEUTRE : il ne
 * privilégie AUCUNE source et n'interdit pas de fournir des liens. Il ne demande
 * qu'une chose vérifiable — ne citer une URL que si elle vient d'être observée
 * (résultat d'outil, contenu lu, code) plutôt que reconstruite de mémoire.
 *
 * POURQUOI ce cadrage : un modèle « recopie » très souvent une URL plausible en
 * assemblant des motifs connus (org/repo, /blob/main/…, slugs de doc). Ces liens
 * paraissent justes mais pointent dans le vide. La seule règle robuste est
 * l'ORIGINE : un lien est fiable s'il a été RÉELLEMENT vu, pas s'il a été deviné.
 */
export const LINK_SOURCING_RULES = [
  "## Links",
  "- Only include a URL you have actually observed in this session: a result from a web search or fetch, a line of code, or the user's own message. Copy it verbatim; never reconstruct one from memory or from a pattern that looks plausible.",
  "- When you don't have a verified link, name the source in words (the file, the tool, the site) instead of inventing a URL. A plain reference is better than a broken link.",
  "- Never present a guessed or generic home-page URL as if it were the specific page you mean. If you are unsure it resolves, don't include it.",
].join("\n");

/** Rappel de concision — placé tôt car il colore tout le reste de la réponse. */
export const CONCISION = [
  "## Conciseness",
  "- No preamble, no filler, no restating the request, no closing summary.",
  "- Say what matters; the user can read the diff and the tool cards for the rest.",
].join("\n");

/**
 * Cadre de PERSÉVÉRANCE — placer avant toute mécanique d'outil.
 *
 * BUT : garantir que l'objectif de l'utilisateur est atteint, en mobilisant TOUT
 * ce qui est disponible. Ce bloc est volontairement NEUTRE sur la MÉTHODE : il ne
 * dit ni « fais-le seul » ni « délègue » (ces choix sont portés par les blocs de
 * délégation, qui raisonnent sur le COÛT). Ici on ne fixe qu'une finalité —
 * satisfaire la demande réelle — sans prescrire de moyen, pour ne pas créer de
 * biais qui entrerait en conflit avec les autres consignes.
 *
 * Les règles sont formulées comme des GARDE-FOUS anti-échec silencieux, pas comme
 * une injonction à en faire trop : on interdit le faux « done », on exige la
 * vérification, et on autorise explicitement le travail long quand la tâche
 * l'exige. Aucune recherche d'outil supplémentaire n'est encouragée si elle ne
 * sert pas l'objectif : « tous les moyens » signifie les moyens PERTINENTS.
 */
export const OBJECTIVE_PURSUIT = [
  "## Objective",
  "- Success is ONE thing: the user's goal genuinely achieved. Understand the real intent behind the request — including a loosely worded one — before choosing an approach.",
  "- Solve the problem, don't just transcribe the instruction. If the obvious path is blocked, find another: another file, another tool, a workaround, a simpler route to the same goal.",
  "- Use every relevant tool when it moves the goal forward (read, search, run, browse, ask); never add steps that don't serve it.",
  "- Don't stop at a plausible result: verify it works before declaring success. An unverified claim is a failure, not a result.",
  "- If truly blocked, state precisely what you tried and what stops you — never pass off unfinished work as done. Escalating a real user decision via `ask_question` is progress, not defeat.",
  "- A long task isn't a broken task: persevere when the goal demands it, but never pad work — the shortest path that fully satisfies the user wins.",
].join("\n");

/**
 * Batching des appels d'outils (porté de Cline, `act.ts`).
 *
 * Un aller-retour modèle coûte plusieurs secondes : si le modèle demande
 * successivement 5 lectures qu'il savait indépendantes dès le départ, on paie
 * 5 latences au lieu d'une. On l'instruit donc explicitement d'émettre TOUS les
 * appels indépendants du prochain pas en UNE seule réponse. C'est un gain de
 * latence perçue immédiat et gratuit (aucun coût de contexte).
 */
export const BATCHING_RULES = [
  "## Batched tool calls",
  "- Before acting, identify every independent read, search, or check needed for the next step and emit ALL of those tool calls in a SINGLE response. Never split independent reads, searches, or checks across separate turns: each turn costs a full round-trip.",
  "- Only sequence tool calls when one genuinely depends on another's result (e.g. read a file before editing it).",
].join("\n");

/**
 * Politique de question à l'utilisateur. Placée TÔT (principe comportemental)
 * pour qu'elle cadre le raisonnement avant les détails d'outil.
 */
export const ASK_USER_RULES =
  "## Asking the user\n" +
  "- Ask ONLY when a decision is genuinely the user's: ambiguous intent, a destructive or irreversible choice, or a preference you cannot infer from the code.\n" +
  "- Call `ask_question` with 2 to 4 concrete options. Read the relevant files FIRST: never ask a question you could answer yourself, and never chain two questions.";

/** Politique d'utilisation des todos (checklist vivante). Principe comportemental. */
export const TODO_RULES =
  "## Progress tracking\n" +
  "- For a task that spans several steps, call `todo_write` to lay out a short checklist (3 to 6 items, one line each) BEFORE you start editing.\n" +
  "- Keep EXACTLY one item `in_progress` and flip each item to done in your very next tool call once it is actually finished: never batch completions, never wait until the end.\n" +
  "- Skip the checklist for a quick single-step request. Do not restate the list in your reply; the user already sees it. The list must always reflect reality.";

/**
 * Cadrage du PLAN D'EXÉCUTION (mode Agent). Principe comportemental, placé avant
 * la mécanique d'outils.
 *
 * ── Pourquoi ce bloc ──────────────────────────────────────────────────────────
 * Sur une demande large (plusieurs fichiers, effet de bord, critère de réussite
 * non évident), un agent qui fonce droit vers l'édition sans avoir explicité ce
 * qu'il va faire, où, et comment il saura que c'est fini, produit des résultats
 * partiels et des régressions. Ce bloc force une étape de CADRAGE mental avant
 * les écritures, sans prescrire de format rigide : le contenu du plan (les
 * todos) reste porté par `todo_write`, ici on ne fixe que les QUESTIONS auxquelles
 * le plan doit répondre.
 *
 * On ne duplique PAS la mécanique de `todo_write` (bloc « Progress tracking ») :
 * ce bloc dit QUELLE réflexion précéder, l'autre dit COMMENT la publier. Aucun
 * budget de lignes imposé — un plan long reste légitime sur une grosse tâche.
 */
export const PLAN_BEFORE_ACTING = [
  "## Plan before acting",
  "- On a non-trivial task (several files, side effects, an unclear success criterion), decide the plan BEFORE editing: the goal, the files you will touch, how you will know it works, and what could break. Publish those steps with `todo_write` so the user sees the plan you follow. Skip this for a quick single-step request.",
  "- Derive the plan from the code, not from the request's wording: explore first (structure, symbols, imports) and let findings shape the steps. Revise it when exploration proves it wrong instead of executing a plan the code has contradicted.",
  "- State your success criterion and make it checkable (a passing test, a compiling build, a matching command output): 'it looks right' is not one. Call out the real risks you see (shared file, public interface, data path) and how you contain them.",
].join("\n");

/**
 * Cohérence des réponses de l'utilisateur (mode Agent).
 *
 * BUT : quand l'agent pose une question (`ask_question`) et que la réponse est
 * ambiguë, partielle, ou contredit ce que le code montre déjà, il ne doit PAS
 * « deviner et avancer » : deviner transforme une inconnue en bug silencieux.
 * La règle est symétrique de `ASK_USER_RULES` (qui dit QUAND demander) — ici on
 * dit QUOI FAIRE de la réponse. Aucune formulation n'y est reprise : on ne parle
 * que du traitement de la réponse, pas du déclenchement de la question.
 */
export const ANSWER_COHERENCE_RULES = [
  "## When an answer comes back",
  "- Judge it before acting. If it is vague, partial, or contradicts what the code shows, do not fill the gap with a guess: re-ask, narrowing to the exact ambiguity left. If two answers conflict, surface the conflict instead of silently picking one.",
  "- Never implement a decision the user did not actually make. A coherent answer unblocks you: act on it without re-confirming what it already settled.",
].join("\n");

/**
 * Règles d'édition (mode Agent, effort max). Détail d'outil : placé BAS.
 *
 * ── La limite de 6000 caractères ───────────────────────────────────────────────
 * Le tool `editor` du SDK Cline REFUSE toute opération dont `old_text` ou
 * `new_text` dépasse 6000 caractères (limite DURE du SDK, non configurable) :
 * l'appel échoue avec « Editor input too large ». Créer un gros fichier en un
 * seul appel est donc impossible. La seule stratégie qui marche est séquentielle
 * et doit être dite EXPLICITEMENT au modèle, sinon il réessaie en boucle :
 *   1. premier `editor` : créer le fichier avec un premier bloc (< 6000 chars) ;
 *   2. `editor` suivants : insérer le reste par petits blocs, avec `insert_line`
 *      (insertion avant une ligne) ou un remplacement `old_text` court et unique ;
 *   3. vérifier à la fin avec `read_files` si un doute subsiste.
 */
export const EDIT_RULES_FULL = [
  "## Editing",
  "- The mechanics of `editor` (create / replace / append, the 6000-character cap, the exact single-match `old_text`) are given in the Tools section: follow them, they are hard constraints.",
  "- On any edit failure (\"text not found\", \"multiple occurrences\"), you are editing a stale version: re-read the file and re-send a fresh, unique snippet, never the same call unchanged.",
].join("\n");

/** Règles d'édition condensées (effort normal). */
export const EDIT_RULES_LITE = [
  "## Editing",
  "- CREATE a file: `path` + `new_text`, no `old_text`. REPLACE: `path` + `old_text` + `new_text`. APPEND: `path` + `new_text` + `insert_line = line_count + 1`.",
  "- CRITICAL: `editor` rejects `old_text`/`new_text` over 6000 characters. Build a large file in several `editor` calls: create it with the first chunk, then append the rest with `insert_line = line_count + 1`.",
  "- `old_text` must be verbatim and match exactly ONE location (3 to 5 lines of context). On \"text not found\", re-read the file and adjust; never re-send a failed edit unchanged.",
].join("\n");

/**
 * Bloc de style appliqué à TOUS les prompts. Il neutralise les emojis que le
 * modèle produit spontanément (📋 ✅ 🚀…) et les tirets longs, qui jureraient avec
 * une UI sobre. Concatené en DERNIER par le composeur : il prime sur un éventuel
 * prompt personnalisé.
 */
export const STYLE_GUARDRAIL = [
  "## Output style",
  "- Never use emojis or decorative Unicode symbols in your replies, tool arguments, or generated files.",
  "- Never use em dashes or en dashes. Use a plain hyphen, a colon, or split into two sentences. This applies to replies, todo items, commit messages, and generated files.",
  "- Plain text and Markdown only. Use headings, lists, code fences, and tables for structure.",
  "- Keep prose concise; do not narrate what you are about to do.",
].join("\n");

/**
 * Consigne de délégation vers les sous-agents (mode IA uniquement).
 *
 * ── Pourquoi deux variantes ────────────────────────────────────────────────────
 * Le SDK Cline expose DEUX mécanismes de sous-agents, mutuellement exclusifs :
 *
 *   - `enableAgentTeams` (mode IA d'Origin) → une ÉQUIPE de coéquipiers
 *     rattachés, pilotés par les outils `team_*`. Chaque action d'un coéquipier
 *     émet un `team_progress` : c'est le SEUL chemin OBSERVABLE dans l'UI
 *     (cartes de sous-agents, onglet Agents). C'est le mode par défaut d'Origin.
 *
 *   - `enableSpawnAgent` → un sous-agent DÉTACHÉ : il travaille, mais n'émet
 *     AUCUN `team_progress` (invisible dans l'UI). Origin ne l'active donc
 *     JAMAIS en mode IA (cf. `cline-sidecar/src/index.ts`, `buildStartConfig`).
 *
 * Conséquence : une consigne qui parle de `spawn_agent` est INERTE en mode IA
 * (l'outil n'est pas exposé), et le modèle, ne voyant aucune instruction sur
 * les outils `team_*`, ne délègue jamais (« les sous-agents ne se coordonnent
 * pas »). On parle donc explicitement du mécanisme RÉELLEMENT exposé.
 *
 * Principe, pas seuil : on n'impose aucune règle chiffrée que le modèle suivrait
 * aveuglément. On explique QUE SON CONTEXTE EST SA RESSOURCE LA PLUS CHÈRE et
 * que toute investigation large qui ne produit pas directement la réponse finale
 * doit passer par un coéquipier. Le catalogue des rôles (qui délègue QUOI) est
 * porté par la description des outils `team_*` — ici on motive le POURQUOI.
 */
export const DELEGATION_GUIDANCE_TEAMS = [
  "## Delegation (you run with a team of teammates — use it judiciously)",
  "- You have a team, but spawning a teammate is EXPENSIVE: it costs an extra model loop plus coordination round-trips (spawn → task → await → read → shutdown). Only delegate when that cost is clearly repaid.",
  "- Delegate ONLY when the investigation is genuinely broad AND self-contained: locating something across a large tree, following a flow end to end, reviewing a change for risk, mapping test coverage, assessing doc or API impact. The larger the search, the stronger the reason.",
  "- Do NOT delegate by default. Most requests — a specific file, a known location, a targeted edit, a short question — are FASTER done yourself with one or two direct reads. A single round-trip beats an orchestration every time.",
  "- Context is your scarcest resource: every raw search dump, file read, or grep you keep for yourself is context you cannot spend on reasoning. A teammate's transcript never enters your context — you only get back a bounded report. That asymmetry is the reason to delegate, when it applies.",
  "- Use `team_spawn_teammate` to create a teammate, then `team_task` / `team_run_task` to give it a specific, self-contained task. Poll or await results with `team_status` / `team_await_runs`, and read their findings before acting. When the work is done, shut idle teammates down with `team_shutdown_teammate`.",
  "- Never leave a teammate running idle: a spawned teammate that finished its task must be shut down, and you must not spawn a new one for work you can finish yourself in a couple of tool calls.",
  "- A teammate's report is a strong lead, not ground truth: verify anything you act on before relying on it.",
].join("\n");

/**
 * Variante pour un sous-agent DÉTACHÉ (`spawn_agent`). Conservée pour couvrir le
 * cas où Origin activerait `enableSpawnAgent` (mode IA sans équipes) ; elle n'est
 * pas utilisée par le mode IA par défaut, qui passe par `DELEGATION_GUIDANCE_TEAMS`.
 */
export const DELEGATION_GUIDANCE = [
  "## Delegation (only when you have the `spawn_agent` tool)",
  "- Context is your scarcest resource. Every raw search dump, file read, or grep you keep is context you cannot spend on reasoning. A sub-agent's transcript never enters your context: you only get back a bounded report. That asymmetry is the whole point of delegating.",
  "- Delegate any investigation that would fill your context with raw material you would summarize anyway: locating where something is defined, used, or configured across a large tree; following a flow end to end; reviewing a change for risk; mapping test coverage; assessing doc or API impact. The fuzzier the search, the stronger the reason to delegate.",
  "- Do it yourself when the answer is one or two targeted reads whose location you already know: the round-trip would cost more than it saves. The judgment is about context cost, not a fixed count.",
  "- Pick the `role` matching the investigation and write a specific, self-contained `task`. Put constraints or prior findings in `context_notes` so the sub-agent does not redo your work.",
  "- A report is a strong lead, not ground truth: verify anything you act on before relying on it.",
  "- Delegation keeps you working on a very large repository without losing the thread: reach for it by default on broad work, skip it only when it clearly costs more than it saves.",
].join("\n");

// ── Composeur ──────────────────────────────────────────────────────────────────

export interface ComposeOptions {
  /** Blocs de prompt (identité, outils, édition, todos…), assemblés dans l'ordre. */
  blocks: string[];
  /** Consigne de style injectée en dernier (STYLE_GUARDRAIL par défaut). */
  style?: string;
  /** Contenu libre ajouté en toute fin (ex. ORIGIN.md du workspace). */
  extra?: string;
}

/**
 * Assemble des blocs en sections séparées par une ligne `---`. Les blocs vides
 * ou blancs sont ignorés, ce qui permet de construire une variante par simple
 * filtrage sans produire de séparateur orphelin.
 */
export function composeSystemPrompt({ blocks, style = STYLE_GUARDRAIL, extra }: ComposeOptions): string {
  return [...blocks, style, extra]
    .filter((b): b is string => !!b && b.trim().length > 0)
    .join("\n\n---\n\n");
}

// ── Presets par mode ───────────────────────────────────────────────────────────

import { TOOL_CONTRACT_FULL, TOOL_CONTRACT_READ_ONLY, ASK_MODE_FILES_NOTE, buildFullToolContract, buildReadOnlyToolContract } from "./toolPresentation";

/** Plan de sortie structuré attendu en mode PLAN. */
const PLAN_OUTPUT_FULL = [
  "## Plan output",
  "After exploring, write a brief analysis of what needs to change, then output the plan in EXACTLY this format:",
  "",
  "<origin-plan>",
  "<title>Brief task title (under 60 chars)</title>",
  "<steps>",
  '<step file="src/relative/path/to/file.ts" action="edit">What will change and why</step>',
  '<step file="src/relative/path/to/newfile.ts" action="create">What this new file will contain</step>',
  "</steps>",
  "</origin-plan>",
  "",
  "Rules:",
  "- Valid actions: edit, create, delete.",
  "- Use workspace-relative paths (e.g. src/components/App.tsx).",
  "- Be specific: the user reads each step before approving.",
  "- Include ALL files that need changes.",
  "- Stop after the closing </origin-plan> tag; execute nothing.",
].join("\n");

const PLAN_OUTPUT_LITE = [
  "## Plan output",
  "Explore with read-only tools, then output the plan in exactly this format:",
  "",
  "<origin-plan>",
  "<title>Brief title (under 60 chars)</title>",
  "<steps>",
  '<step file="src/path/to/file.ts" action="edit">What changes and why</step>',
  "</steps>",
  "</origin-plan>",
  "",
  "Valid actions: edit, create, delete. Workspace-relative paths. Exploration only, no code changes.",
].join("\n");

/**
 * Squelette d'un preset : quels blocs, dans quel ordre, selon mode et effort.
 *
 * Ordonnancement volontaire (inspiré Cline) : les PRINCIPES comportementaux
 * (concision, question à l'utilisateur, todos, délégation) viennent AVANT les
 * DÉTAILS D'OUTIL (outils, édition). Le modèle cadre d'abord son raisonnement,
 * puis lit la mécanique. Chaque bloc porte une seule responsabilité : aucun
 * énoncé n'est répété d'un bloc à l'autre.
 */
export function buildSystemPrompt(
  mode: "agent" | "ask" | "plan",
  isMax: boolean,
  workspaceNote = "",
  withTeams = false,
  disabledTools: ReadonlySet<string> = new Set(),
): string {
  // Contrat d'outils filtré par les préférences (Settings › Agent) : les outils
  // désactivés sont retirés du prompt, donc jamais appelés par le modèle.
  const fullContract = disabledTools.size > 0 ? buildFullToolContract(disabledTools) : TOOL_CONTRACT_FULL;
  const readOnlyContract = disabledTools.size > 0 ? buildReadOnlyToolContract(disabledTools) : TOOL_CONTRACT_READ_ONLY;
  const blocks: string[] = [identity(mode), CONCISION, OBJECTIVE_PURSUIT, LINK_SOURCING_RULES];

  if (mode === "agent") {
    // Principes d'abord : cadrer le plan AVANT d'agir, puis le suivi (todos), puis
    // la politique de question ET de traitement de la réponse, puis le batching.
    blocks.push(PLAN_BEFORE_ACTING, TODO_RULES, ASK_USER_RULES, ANSWER_COHERENCE_RULES, BATCHING_RULES);
    // Délégation : en mode IA (`withTeams`), les coéquipiers `team_*` sont
    // TOUJOURS annoncés — sans quoi le modèle, ignorant leur existence, ne
    // délègue jamais (cf. commentaire de `DELEGATION_GUIDANCE_TEAMS`). Hors mode
    // IA, le bloc n'a de sens qu'à l'effort max et concerne `spawn_agent`.
    if (withTeams) blocks.push(DELEGATION_GUIDANCE_TEAMS);
    else if (isMax) blocks.push(DELEGATION_GUIDANCE);
    // …mécanique ensuite : le contrat d'outils documente chaque outil RÉELLEMENT
    // exposé en mode Agent (dont la limite de 6000 car. de `editor`), puis les
    // règles d'édition détaillées.
    blocks.push(fullContract, isMax ? EDIT_RULES_FULL : EDIT_RULES_LITE);
  } else if (mode === "ask") {
    // ASK répond aux questions : on cadre d'abord COMMENT répondre (principe),
    // puis le cycle de revue des changements. `isMax` fait varier le niveau de
    // détail du cycle de revue (un seul bloc vs. règles d'édition complètes).
    blocks.push(ASK_ANSWER_RULES, ASK_MODE_FILES_NOTE, readOnlyContract);
  } else {
    blocks.push(readOnlyContract, isMax ? PLAN_OUTPUT_FULL : PLAN_OUTPUT_LITE);
  }

  return composeSystemPrompt({ blocks, extra: workspaceNote });
}

// ── Compat : constantes exportées (anciens noms) ───────────────────────────────
// Conservées pour ne pas casser les imports existants le temps de la migration ;
// elles délèguent au composeur, source unique de vérité.

export const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt("agent", true);
export const DEFAULT_SYSTEM_PROMPT_LITE = buildSystemPrompt("agent", false);
export const DEFAULT_ASK_PROMPT = buildSystemPrompt("ask", true);
export const DEFAULT_ASK_PROMPT_LITE = buildSystemPrompt("ask", false);
export const DEFAULT_PLAN_PROMPT = buildSystemPrompt("plan", true);
export const DEFAULT_PLAN_PROMPT_LITE = buildSystemPrompt("plan", false);
