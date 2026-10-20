import { generateText } from 'ai';
import { buildLanguageModel } from './agent/providers';
import { resolveActiveModelTarget, type LlmActionResult } from './agent/activeModel';

/**
 * Prompt système d'optimisation d'un brouillon de prompt.
 *
 * Objectif : produire un prompt réellement ACTIONNABLE, pas une simple
 * reformulation. On demande au modèle de lever les ambiguïtés en les rendant
 * explicites (jamais en inventant un choix arbitraire), de structurer la demande
 * (objectif, périmètre, livrable, critères de réussite) et de conserver
 * strictement l'intention et le périmètre d'origine.
 *
 * Nuance importante par rapport à un simple « rewriter » : on AUTORISE l'ajout de
 * structure, de critères d'acceptation et d'étapes — c'est précisément ce qui
 * rend le prompt exploitable — tout en INTERDISANT l'invention de technologies,
 * contraintes, chemins ou spécificités que l'utilisateur n'a pas exprimés. La
 * ligne rouge : reformuler et structurer = oui ; décider à la place de
 * l'utilisateur = non.
 */
const IMPROVE_SYSTEM_PROMPT = [
  'You are a senior prompt engineer for a coding assistant IDE.',
  'Your job is to turn a rough user draft into an actionable, well-structured',
  'instruction for an autonomous coding agent. Improve the SETUP, not just the wording.',
  '',
  'Rules:',
  '1. Preserve the original intent, scope and language. Never change what the user wants.',
  '2. Structure the result when it helps execution: start with a one-line objective,',
  '   then the deliverable / expected outcome, then constraints or acceptance criteria.',
  '   Use short lines or a minimal list. Do NOT force a rigid template for a trivial ask.',
  '3. Make implicit goals explicit ONLY by rephrasing what the draft already implies.',
  '   If something is genuinely ambiguous, state the open question explicitly instead of',
  '   picking an arbitrary interpretation.',
  '4. You MAY add structural scaffolding (steps, acceptance criteria, done-condition).',
  '   You MUST NOT invent technologies, libraries, file paths, APIs, versions or',
  '   requirements the user did not state.',
  '5. Remove filler, redundancy and vague words (things, stuff, something, maybe, etc.).',
  '6. Be concise and specific. No preamble, no meta commentary about the rewrite.',
  '7. Output ONLY the improved prompt. No quotes, no markdown fences,',
  '   no "improved prompt:" prefix.',
  '8. If project context (file tree) is provided, use it ONLY to make paths or scope',
  '   references realistic. Never assume a file exists just because a similar one does.',
].join('\n');

/**
 * Optimise un brouillon de prompt à partir du modèle configuré par l'utilisateur.
 *
 * Retour TYPÉ (`LlmActionResult`) pour distinguer les causes d'échec — l'ancien
 * `null` muet empêchait de savoir si le problème venait du provider ou du modèle.
 *
 * `providerId`/`modelId` proviennent du modèle actuellement SÉLECTIONNÉ dans la
 * barre de saisie, pour que l'optimisation se fasse avec le même modèle que celui
 * qui traitera la demande. `projectContext` (facultatif) est un extrait du projet
 * (arborescence, dossier courant) qui aide à rendre les références réalistes.
 */
export async function optimizePrompt(
  draft: string,
  providerId?: string,
  modelId?: string,
  projectContext?: string,
): Promise<LlmActionResult> {
  if (!draft.trim()) return { ok: false, reason: "empty-input" };

  // Résolution centralisée : mêmes priorités que le chat (sélection > .env >
  // défaut). Le modèle est TOUJOURS un vrai id de modèle résolu — l'ancien
  // `modelId ?? pid` passait l'id du provider en guise de modèle et cassait
  // l'appel.
  const target = await resolveActiveModelTarget(providerId, modelId);
  if (!target.usable) return { ok: false, reason: "no-provider" };

  const model = buildLanguageModel(target.providerId, target.modelId, target.apiKey ?? '');
  const contextBlock = projectContext?.trim()
    ? `\n\nProject context (use to ground references, do not assume unstated files exist):\n${projectContext.trim()}`
    : '';

  let text: string;
  try {
    ({ text } = await generateText({
      model,
      system: IMPROVE_SYSTEM_PROMPT,
      prompt: `Rewrite this draft into an improved, actionable prompt:\n\n${draft}${contextBlock}`,
    }));
  } catch (e: unknown) {
    return { ok: false, reason: "call-failed", detail: e instanceof Error ? e.message : String(e) };
  }

  // Nettoyage défensif : le modèle peut ajouter préfixe, guillemets ou fence.
  const improved = text
    .trim()
    .replace(/^```\w*\s*|\s*```$/g, '')
    .replace(/^(?:improved prompt|prompt|rewritten prompt):\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return improved ? { ok: true, text: improved } : { ok: false, reason: "call-failed", detail: "empty model output" };
}
