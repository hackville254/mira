/**
 * Configuration des tâches « Run ».
 *
 * Modèle inspiré de VS Code (`tasks.json`) mais restreint pour la sécurité :
 *  - une tâche est une commande passée en **argv** (`program` + `args[]`),
 *    jamais une chaîne shell → aucune injection possible ;
 *  - `program` doit appartenir à l'allowlist côté Rust (`terminal.rs`).
 *
 * Deux niveaux, par ordre de précédence :
 *  1. **Global**  — préférences utilisateur (localStorage).
 *  2. **Workspace** — fichier `.origin/run.json` (versionnable avec le projet).
 *
 * Confiance : les tâches issues du **workspace** ne s'exécutent qu'après
 * confirmation explicite de l'utilisateur (voir `runTasksTrust.ts`). Les tâches
 * définies localement (global) sont de confiance par construction.
 */
import { z } from 'zod';

/** Caractères autorisés dans un libellé de tâche (borne + évite le bruit). */
const LABEL_PATTERN = /^[\w .+/#()-]{1,64}$/;

export const RunTaskSchema = z.object({
  /** Identifiant stable et unique dans le fichier (ex. "run", "test"). */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** Libellé affiché dans le menu / le sélecteur. */
  label: z.string().regex(LABEL_PATTERN),
  /**
   * Programme à lancer : nom nu (`python3`, `cargo`) ou chemin absolu vers un
   * interpréteur de l'allowlist. JAMAIS interprété par un shell.
   */
  program: z.string().min(1).max(1024),
  /** Arguments passés tels quels (argv). */
  args: z.array(z.string().max(1024)).max(64).optional(),
  /** Dossier de travail, relatif à la racine du workspace (défaut : "."). */
  cwd: z.string().max(512).optional(),
  /** Extension du fichier courant qui déclenche cette tâche (ex. "py"). */
  extension: z.string().regex(/^[a-z0-9]+$/).optional(),
});

export const RunConfigSchema = z.object({
  version: z.literal(1),
  tasks: z.array(RunTaskSchema).max(64),
});

export type RunTask = z.infer<typeof RunTaskSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** Tâches par défaut, prêtes à l'emploi pour les langages courants. */
export const DEFAULT_RUN_CONFIG: RunConfig = {
  version: 1,
  tasks: [
    { id: 'python', label: 'Python: Run current file', program: 'python3', args: ['$file'], extension: 'py' },
    { id: 'node', label: 'Node: Run current file', program: 'node', args: ['$file'], extension: 'js' },
    { id: 'tsx', label: 'Node: Run TypeScript file', program: 'npx', args: ['tsx', '$file'], extension: 'ts' },
    { id: 'cargo', label: 'Cargo: Run', program: 'cargo', args: ['run'], extension: 'rs' },
    { id: 'go', label: 'Go: Run current file', program: 'go', args: ['run', '$file'], extension: 'go' },
  ],
};

/**
 * Substitue les placeholders d'un argument par le contexte d'exécution.
 *
 * Placeholders :
 *  - `${file}` / `$file`               → chemin absolu du fichier courant
 *  - `${dir}`  / `$dir`                → dossier du fichier courant
 *  - `${workspaceFolder}` / `$workspaceFolder` → racine du workspace
 *  - `${fileBasenameNoExtension}`       → nom du fichier sans extension
 *
 * La substitution est **littérale** : le résultat est passé en argv, jamais
 * réinterprété par un shell.
 */
export function substituteArgs(
  arg: string,
  ctx: { file: string; workspaceFolder: string },
): string {
  const sep = ctx.file.includes('\\') ? '\\' : '/';
  const dir = ctx.file.slice(0, ctx.file.lastIndexOf(sep));
  const base = ctx.file.slice(ctx.file.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf('.');
  const basenameNoExt = dot > 0 ? base.slice(0, dot) : base;

  return arg
    .replace(/\$\{file\}|\$file\b/g, ctx.file)
    .replace(/\$\{dir\}|\$dir\b/g, dir)
    .replace(/\$\{workspaceFolder\}|\$workspaceFolder\b/g, ctx.workspaceFolder)
    .replace(/\$\{fileBasenameNoExtension\}/g, basenameNoExt);
}

/**
 * Trouve la tâche la mieux adaptée à un fichier donné.
 * Priorité : correspondance d'extension explicite, sinon la première tâche sans
 * contrainte d'extension (générique).
 */
export function pickTaskForFile(tasks: RunTask[], filePath: string): RunTask | null {
  const base = filePath.replace(/\\/g, '/');
  const name = base.slice(base.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const byExt = tasks.find(t => t.extension && t.extension === ext);
  if (byExt) return byExt;
  return tasks.find(t => !t.extension) ?? null;
}
