/**
 * Point d'entrée historique des prompts système d'Origin.
 *
 * Les prompts vivent désormais dans `src/lib/agent/prompts.ts` (module central :
 * blocs déclaratifs + composeur `composeSystemPrompt` + presets par mode). Ce
 * fichier ne fait plus que RÉ-EXPORTER pour ne pas casser les imports existants
 * et rester la façade publique du module d'IA.
 */
export {
  DELEGATION_GUIDANCE,
  STYLE_GUARDRAIL,
  composeSystemPrompt,
  buildSystemPrompt,
  identity,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_LITE,
  DEFAULT_ASK_PROMPT,
  DEFAULT_ASK_PROMPT_LITE,
  DEFAULT_PLAN_PROMPT,
  DEFAULT_PLAN_PROMPT_LITE,
} from "./agent/prompts";

export interface UsageData {
  inputTokens:          number;
  outputTokens:         number;
  cacheReadTokens?:     number;
  cacheCreationTokens?: number;
}
