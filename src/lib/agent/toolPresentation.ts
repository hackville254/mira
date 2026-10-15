/**
 * Présentation des outils dans le prompt système.
 *
 * Le nom des outils est une DONNÉE partagée : le prompt les décrit et le modèle
 * les appelle par ces noms EXACTS. Pour éviter qu'une liste recopiée à la main
 * ne dérive du code (renommage d'un outil → le modèle appelle un nom inexistant),
 * on dérive les libellés du MÊME objet que le prompt décrit. Ce fichier est la
 * source de vérité de présentation ; il ne contient aucune logique d'exécution.
 *
 * Note de couplage : ces listes doivent rester alignées sur les clés réellement
 * exposées par `createTools` / `createReadOnlyToolset` (src/lib/agent/tools.ts).
 * Un test d'invariant (voir __tests__/prompts.test.ts) verrouille les invariants
 * de forme ; l'alignement fonctionnel est vérifié à la lecture du prompt généré.
 */

/** Outils du mode Agent (lecture + écriture + édition + shell + todos + question). */
export const FULL_TOOLS_LIST =
  "`read_file`, `list_directory`, `grep`, `glob`, `write_file`, `edit`, `multi_edit`, `bash_run`, `todo_write`, `todo_read`, `ask_user`";

/** Outils read-only exposés en mode Plan (exploration) et aux sous-agents. */
export const READ_ONLY_TOOLS_LIST = "`read_file`, `list_directory`, `grep`, `glob`, `todo_read`";

/** Note expliquant le cycle de revue des changements en mode ASK. */
export const ASK_MODE_FILES_NOTE = [
  "## Changes in ASK mode",
  "When the user asks you to modify code, use `edit` or `multi_edit` to make targeted changes. Each change is shown in a diff view with per-hunk Accept/Reject buttons before anything is written to disk.",
  "- Use `edit` for a single change in one file; `multi_edit` for several changes in the same file (one call).",
  "- Never output full file contents: use the tools instead.",
  "- For changes across several files, call `edit` (or `multi_edit`) once per file.",
].join("\n");
