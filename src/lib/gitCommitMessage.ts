import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { loadApiKey, resolveDefaultModel, resolveDefaultProvider } from './secrets';
import { gitCommitDiff } from './git';

const LOCAL_IDS = ['ollama', 'lmstudio', 'vllm'];

/** Types Conventional Commits acceptés (ordre = fréquence indicative). */
const COMMIT_TYPES = 'feat|fix|refactor|perf|docs|test|build|ci|style|chore|revert';

/**
 * Prompt système de génération du message de commit.
 *
 * Rédigé selon les bonnes pratiques « Conventional Commits » :
 *   - un sujet à l'impératif, ≤ 50 caractères visés (72 max), sans point final ;
 *   - `<type>(<scope>)!: <sujet>` avec le `!` uniquement en cas de rupture ;
 *   - le scope inféré des fichiers touchés, omis s'il n'est pas évident ;
 *   - UNIQUEMENT le sujet en sortie (pas de corps ni de markdown), pour un
 *     remplissage direct du champ.
 *
 * Le prompt ne fixe aucune dépendance à un provider ou à une langue de projet :
 * la langue du message suit celle des messages de commit existants.
 */
const COMMIT_SYSTEM_PROMPT = [
  'You are a senior engineer writing a git commit subject line from a unified diff.',
  'Follow the Conventional Commits specification precisely.',
  '',
  'Rules:',
  `1. Output exactly ONE line: \`<type>(<scope>): <subject>\`.`,
  `   - <type> is one of: ${COMMIT_TYPES}. Pick the single most accurate one.`,
  '   - <scope> is the affected area (module, folder, or feature) inferred from the changed paths;',
  '     omit the parentheses entirely when no scope is clearly identifiable.',
  '   - <subject> starts with a lowercase verb in the imperative mood (add, fix, remove, rename…),',
  '     describes WHAT changed and, when useful, WHY. No trailing period. Aim for ≤ 50 characters, never exceed 72.',
  '2. Add a `!` right after the type/scope (e.g. `feat(api)!: …`) ONLY when the diff removes or changes',
  '   a public interface, a config key, or otherwise breaks backward compatibility.',
  '3. Summarize the diff as a whole. Do not list every file. Ignore lockfiles, vendored code,',
  '   formatting-only churn and generated artifacts when choosing the type.',
  '4. If the diff spans several unrelated concerns, write the subject for the dominant one.',
  '5. The subject language matches the language of pre-existing commit subjects when given; otherwise use English.',
  '6. Output the subject line and nothing else: no body, no markdown, no backticks, no quotes,',
  '   no "commit message:" prefix, no explanations.',
].join('\n');

/**
 * Génère un message de commit à partir du diff réel du dépôt en appelant le
 * modèle configuré par l'utilisateur. Retourne `null` si aucun provider n'est
 * configuré (pas de clé API pour un provider distant) afin que l'appelant
 * puisse prévenir l'utilisateur plutôt que d'envoyer un diff au réseau.
 *
 * Le diff provient de `gitCommitDiff` (et non `gitDiff`) car il doit inclure les
 * fichiers NON SUIVIS : un dossier rempli de nouveaux fichiers produit sinon un
 * diff vide → « No changes to describe ».
 */
export async function generateCommitMessage(repoPath: string): Promise<string | null> {
  const providerId = await resolveDefaultProvider('anthropic');
  const modelId    = await resolveDefaultModel('claude-haiku-4-5-20251001');
  const apiKey = await loadApiKey(providerId);
  if (!apiKey && !LOCAL_IDS.includes(providerId)) return null;

  const diff = await gitCommitDiff(repoPath, 12_000);
  if (!diff.trim()) return null;

  const model = buildLanguageModel(providerId, modelId, apiKey ?? '');
  const { text } = await generateText({
    model,
    system: COMMIT_SYSTEM_PROMPT,
    prompt: `Here is the unified diff of the changes to describe:\n\n${diff}\n\nWrite the commit subject line.`,
  });

  // Nettoyage défensif : on ne garde que la première ligne, sans balises de code
  // ni guillemets parasites qu'un modèle pourrait ajouter malgré la consigne.
  const subject = text
    .trim()
    .split('\n')[0]
    .replace(/^```\w*\s*|\s*```$/g, '')
    .replace(/^(?:commit message:|message:)\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return subject || null;
}
