import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { resolveActiveModelTarget, type LlmActionResult } from './agent/activeModel';

/**
 * Prompt système d'édition inline (« Edit inline »).
 *
 * Le modèle reçoit un EXTRAIT de code (la sélection) et une INSTRUCTION
 * utilisateur, et doit renvoyer le code RÉÉCRIT de la sélection — rien d'autre.
 *
 * Contrat strict, pour que le résultat soit directement applicable comme diff :
 *   - Sortie = code uniquement (aucune fence, aucun commentaire, aucun préambule).
 *   - On ne touche PAS au reste du fichier : le modèle ne voit que la sélection.
 *   - On ne saute PAS de lignes ni ne réindente tout le bloc arbitrairement : on
 *     préserve le style (indentation, quotes, conventions) du code fourni.
 *   - Si l'instruction est impossible ou dangereuse (ex. supprimer du code sans
 *     rapport), renvoyer la sélection INCHANGÉE plutôt qu'inventer.
 */
const INLINE_EDIT_SYSTEM_PROMPT = [
  'You rewrite a SELECTED CODE EXCERPT according to a user instruction.',
  'You only see the selection — never assume the rest of the file.',
  '',
  'Rules:',
  '1. Apply the user instruction to the provided code and return the REWRITTEN code.',
  '2. Output ONLY the new code for the selection. No markdown fences, no prose,',
  '   no explanations, no "here is" preamble.',
  '3. Preserve the existing indentation, quoting style and naming conventions,',
  '   unless the instruction explicitly asks to change them.',
  '4. Keep the surrounding code valid: do not add imports or code that belongs',
  '   elsewhere in the file.',
  '5. If the instruction cannot be safely applied, return the original code unchanged.',
  '6. Never invent APIs, libraries or symbols the instruction did not mention.',
].join('\n');

/**
 * Réécrit une sélection de code selon une instruction utilisateur, avec le même
 * modèle que le chat (résolution centralisée : sélection UI > `.env` > défaut).
 *
 * Retour TYPÉ (`LlmActionResult`) : l'appelant distingue « provider non
 * configuré », « sélection vide » et « échec d'appel », au lieu d'un `null` muet.
 *
 * `language` est un simple indice de coloration pour le modèle (ex. `typescript`).
 */
export async function editSelectionInline(
  code: string,
  instruction: string,
  language: string,
  providerId?: string,
  modelId?: string,
): Promise<LlmActionResult> {
  if (!code.trim()) return { ok: false, reason: 'empty-input' };
  if (!instruction.trim()) return { ok: false, reason: 'empty-input' };

  const target = await resolveActiveModelTarget(providerId, modelId);
  if (!target.usable) return { ok: false, reason: 'no-provider' };

  const model = buildLanguageModel(target.providerId, target.modelId, target.apiKey ?? '');

  let text: string;
  try {
    ({ text } = await generateText({
      model,
      system: INLINE_EDIT_SYSTEM_PROMPT,
      prompt: [
        `Language: ${language}`,
        `Instruction: ${instruction.trim()}`,
        '',
        'Code to rewrite (verbatim, between the markers):',
        '<<<CODE',
        code,
        'CODE>>>',
        '',
        'Return only the rewritten code.',
      ].join('\n'),
    }));
  } catch (e: unknown) {
    return { ok: false, reason: 'call-failed', detail: e instanceof Error ? e.message : String(e) };
  }

  // Nettoyage défensif : le modèle peut envelopper la réponse dans une fence.
  const rewritten = text
    .trim()
    .replace(/^```[\w-]*\s*\n?/, '')
    .replace(/\n?```$/, '');
  return rewritten.trim()
    ? { ok: true, text: rewritten }
    : { ok: false, reason: 'call-failed', detail: 'empty model output' };
}
