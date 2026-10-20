import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { resolveActiveModelTarget, type LlmActionResult } from './agent/activeModel';
import { gitCommitDiff } from './git';

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
 * modèle configuré par l'utilisateur.
 *
 * Le retour est TYPÉ (`LlmActionResult`) pour distinguer les causes d'échec :
 *   - `not-a-repo` → le dossier n'est pas un dépôt git (source : `gitCommitDiff`) ;
 *   - `empty-input` → dépôt valide mais aucun changement à décrire ;
 *   - `no-provider` → provider distant sans clé API (rien n'est envoyé au réseau) ;
 *   - `call-failed` → l'appel au provider a échoué (message dans `detail`).
 * L'ancien contrat renvoyait un `null` muet : impossible pour l'utilisateur de
 * savoir si le problème venait du dépôt ou de la configuration IA.
 *
 * Le diff provient de `gitCommitDiff` (et non `gitDiff`) car il doit inclure les
 * fichiers NON SUIVIS : un dossier rempli de nouveaux fichiers produit sinon un
 * diff vide → « No changes to describe ».
 *
 * `providerId`/`modelId` sont le modèle SÉLECTIONNÉ dans la barre de saisie du
 * chat, pour générer avec le même modèle que celui qui traite la conversation.
 * Sans eux, on retombe sur les mêmes priorités que le chat (`.env` puis défaut).
 */
export async function generateCommitMessage(
  repoPath: string,
  providerId?: string,
  modelId?: string,
): Promise<LlmActionResult> {
  const target = await resolveActiveModelTarget(providerId, modelId);
  // Aucun provider exploitable : l'appelant prévient plutôt que d'envoyer un
  // diff au réseau.
  if (!target.usable) return { ok: false, reason: "no-provider" };

  // Le diff est typé : « pas un dépôt », « git introuvable » et « dépôt propre »
  // sont trois causes distinctes, à ne PAS confondre avec un échec de génération.
  const diffResult = await gitCommitDiff(repoPath, 12_000);
  if (diffResult.kind === 'git-unavailable') return { ok: false, reason: "git-unavailable" };
  if (diffResult.kind === 'not-a-repo') return { ok: false, reason: "not-a-repo" };
  if (diffResult.kind === 'no-changes') return { ok: false, reason: "empty-input" };
  const diff = diffResult.value;

  const model = (() => {
    try {
      return buildLanguageModel(target.providerId, target.modelId, target.apiKey ?? '');
    } catch (e: unknown) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })();
  // Un `providerId` inconnu de `buildLanguageModel` (ex. sélection corrompue en
  // `localStorage`) lève ici : on le traite comme une configuration invalide,
  // sans jamais laisser l'exception remonter comme un échec git ou réseau.
  if (model instanceof Error) {
    return { ok: false, reason: "no-provider", detail: model.message };
  }
  let text: string;
  try {
    ({ text } = await generateText({
      model,
      system: COMMIT_SYSTEM_PROMPT,
      prompt: `Here is the unified diff of the changes to describe:\n\n${diff}\n\nWrite the commit subject line.`,
    }));
  } catch (e: unknown) {
    return { ok: false, reason: "call-failed", detail: e instanceof Error ? e.message : String(e) };
  }

  // Nettoyage défensif : on ne garde que la première ligne, sans balises de code
  // ni guillemets parasites qu'un modèle pourrait ajouter malgré la consigne.
  const subject = text
    .trim()
    .split('\n')[0]
    .replace(/^```\w*\s*|\s*```$/g, '')
    .replace(/^(?:commit message:|message:)\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  // Un modèle qui ne produit rien d'exploitable est un échec d'appel, pas un
  // « rien à décrire » : la cause est côté génération.
  return subject ? { ok: true, text: subject } : { ok: false, reason: "call-failed", detail: "empty model output" };
}
