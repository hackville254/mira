import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { loadApiKey } from './secrets';
import { gitDiff } from './git';

const LOCAL_IDS = ['ollama', 'lmstudio', 'vllm'];

/**
 * Génère un message de commit à partir du diff réel du dépôt en appelant le
 * modèle configuré par l'utilisateur. Retourne `null` si aucun provider n'est
 * configuré (pas de clé API pour un provider distant) afin que l'appelant
 * puisse prévenir l'utilisateur plutôt que d'envoyer un diff au réseau.
 */
export async function generateCommitMessage(repoPath: string): Promise<string | null> {
  const providerId = localStorage.getItem('origin-ai-provider') ?? 'anthropic';
  const modelId    = localStorage.getItem('origin-ai-model')    ?? 'claude-haiku-4-5-20251001';
  const apiKey = await loadApiKey(providerId);
  if (!apiKey && !LOCAL_IDS.includes(providerId)) return null;

  const diff = await gitDiff(repoPath, 12_000);
  if (!diff.trim()) return null;

  const model = buildLanguageModel(providerId, modelId, apiKey ?? '');
  const { text } = await generateText({
    model,
    system: [
      'You write concise, high-quality git commit messages following the Conventional Commits spec.',
      'You are given a unified diff of the staged and unstaged changes.',
      'Rules:',
      '1. Output a single subject line, imperative mood, max 72 chars, no trailing period.',
      '2. Format: `<type>(<scope>): <subject>` where type ∈ feat|fix|refactor|docs|style|test|chore|perf|build|ci.',
      '3. Infer the scope from the changed files when obvious; omit the scope if unclear.',
      '4. Output ONLY the subject line. No body, no markdown, no quotes, no commentary.',
    ].join('\n'),
    prompt: `Here is the diff:\n\n${diff}\n\nWrite the commit subject line.`,
  });

  const subject = text.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim();
  return subject || null;
}
