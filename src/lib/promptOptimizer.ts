import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { loadApiKey, resolveDefaultProvider } from './secrets';

const LOCAL_IDS = ['ollama', 'lmstudio', 'vllm'];

/**
 * Prompt système d'optimisation d'un brouillon de prompt.
 *
 * Objectif : transformer une demande brève ou ambiguë de l'utilisateur en un
 * énoncé clair, précis et actionnable, SANS inventer de contenu que
 * l'utilisateur n'a pas exprimé. On interdit explicitement toute exigence
 * supplémentaire, tout détail technique non fourni et toute reformulation qui
 * changerait l'intention.
 */
const IMPROVE_SYSTEM_PROMPT = [
  'You are a prompt editor for a coding assistant IDE.',
  'Rewrite the user draft into a clearer, more precise, more actionable instruction',
  'for the assistant, following these rules:',
  '',
  'Rules:',
  '1. Preserve the original intent and scope exactly. Never add requirements,',
  '   technologies, constraints or details the user did not state.',
  '2. If the draft is ambiguous, keep the ambiguity but phrase it as an explicit',
  '   question or a clearly stated goal. Do not pick an arbitrary interpretation.',
  '3. Make the goal explicit: state what should be produced and, when the draft',
  '   implies it, the expected outcome or acceptance criteria. Only infer from the draft.',
  '4. Remove filler, redundancy and vague words (things, stuff, something, maybe).',
  '5. Keep it concise. Prefer plain, direct sentences. No preamble, no explanation,',
  '   no meta commentary about the rewrite.',
  '6. Output ONLY the improved prompt text. No quotes, no markdown fences,',
  '   no "improved prompt:" prefix.',
  '7. Match the language of the draft.',
].join('\n');

/**
 * Optimise un brouillon de prompt à partir du modèle configuré par l'utilisateur.
 *
 * Retourne `null` si aucun provider exploitable n'est configuré (pas de clé API
 * pour un provider distant) : l'appelant prévient alors l'utilisateur plutôt que
 * d'envoyer du contenu au réseau. `providerId`/`modelId` proviennent du modèle
 * actuellement SÉLECTIONNÉ dans la barre de saisie, pour que l'optimisation se
 * fasse avec le même modèle que celui qui traitera la demande.
 */
export async function optimizePrompt(
  draft: string,
  providerId?: string,
  modelId?: string,
): Promise<string | null> {
  const pid = providerId ?? (await resolveDefaultProvider('anthropic'));
  const apiKey = await loadApiKey(pid);
  if (!apiKey && !LOCAL_IDS.includes(pid)) return null;

  const mid = modelId ?? pid;
  const model = buildLanguageModel(pid, mid, apiKey ?? '');
  const { text } = await generateText({
    model,
    system: IMPROVE_SYSTEM_PROMPT,
    prompt: `Rewrite this draft into an improved prompt:\n\n${draft}`,
  });

  // Nettoyage défensif : le modèle peut ajouter préfixe, guillemets ou fence.
  const improved = text
    .trim()
    .replace(/^```\w*\s*|\s*```$/g, '')
    .replace(/^(?:improved prompt|prompt|rewritten prompt):\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return improved || null;
}
