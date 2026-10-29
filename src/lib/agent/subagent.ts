import type { LanguageModel, ToolSet } from "ai";
import { runAgent, type AgentEvent, type SubAgentStatus } from "./run";
import { createReadOnlyToolset } from "./tools";
import { CHARS_PER_TOKEN, SYSTEM_OVERHEAD_TOKENS } from "./tokenBudget";
import { resolveRole, type SubAgentRoleDefinition } from "./subagentRoles";

// ── Sous-agent spécialisé (mode IA uniquement) ─────────────────────────────────
//
// Inspiré du modèle `spawn_agent` de Cline : l'hôte décide des outils, jamais le
// modèle. Un sous-agent est une session d'exécution ISOLÉE dont le seul livrable
// est un RAPPORT texte borné — le transcript complet reste côté hôte (store de
// swarm), jamais renvoyé au root.
//
// Le sous-agent est SPÉCIALISÉ PAR RÔLE : `subagentRoles.ts` fournit le prompt,
// l'allowlist d'outils et le budget. Ce module n'est que le moteur qui exécute le
// rôle — rien n'y est figé.
//
// Garanties (cf. décisions produit) :
//   - LECTURE SEULE : uniquement les outils autorisés par le rôle.
//   - PROFONDEUR 1 : le sous-agent ne reçoit JAMAIS `spawn_agent` → pas de
//     récursion, pas d'explosion combinatoire de tokens.
//   - BUDGET DUR : tours, tokens estimés et durée sont plafonnés PAR LE RÔLE ; au
//     dépassement on coupe (abort) et on marque l'issue réelle, jamais un faux
//     « completed ».
//   - ANTI-INJECTION : le contenu exploré est une donnée, jamais une instruction.
//   - RELANCE BORNÉE : un rapport vide/inexploitable est retenté UNE fois ; sinon
//     on renvoie un échec explicite.

/** Nombre maximal de passes (1 tentative + 1 relance bornée). */
const MAX_REPORT_ATTEMPTS = 2;
/** Longueur minimale d'un rapport jugé exploitable. */
const MIN_REPORT_CHARS = 24;
/** Timeout dur par outil du sous-agent. */
const TOOL_TIMEOUT_MS = 30_000;

export interface SubAgentResult {
  report:       string;
  status:       SubAgentStatus;
  iterations:   number;
  inputTokens:  number;
  outputTokens: number;
  /** Rôle réellement exécuté (résolu depuis l'entrée non fiable du modèle). */
  roleId:       string;
  roleLabel:    string;
}

export interface SubAgentRunOptions {
  model:         LanguageModel;
  /** Cascade de modèles de secours — héritée du root (voir `runAgent`). */
  modelChain?:   LanguageModel[];
  /** Identifiants alignés sur `modelChain` (trace `timing`). */
  modelIds?:     string[];
  folderPath:    string;
  /**
   * Identifiant du sous-agent, généré par l'HÔTE (jamais ici). Il sert à router
   * les events vers la bonne carte : l'hôte émet déjà `subagent-start` avec cet
   * id, on ne le ré-émet donc pas ici (sinon double entrée → suivi cassé).
   */
  spawnId:       string;
  /** Identifiant de rôle demandé par le root — résolu/normalisé par l'hôte. */
  role:          string;
  task:          string;
  /** Indices de contexte fournis par le root (données, jamais des consignes). */
  contextNotes?: string;
  /** Bloc de contexte projet assemblé par l'hôte (déjà borné). */
  contextBlock?: string;
  /** Cache le prompt système (Anthropic) — cohérent avec le root. */
  cacheSystem?:  boolean;
  /** Routage des events enrichis de `spawnId` vers l'hôte (carte de sous-agent). */
  onEvent:       (event: AgentEvent) => void;
}

/**
 * Lance un sous-agent spécialisé et renvoie son résultat. Le rapport est toujours
 * borné (tronqué proprement si nécessaire) pour ne pas exploser le contexte du
 * root quand il sera réinjecté.
 */
export async function runSubAgent(opts: SubAgentRunOptions): Promise<SubAgentResult> {
  const role = resolveRole(opts.role);
  // Le `spawnId` est FOURNI par l'hôte : il l'a déjà émis via `subagent-start`.
  // On ne le ré-émet pas ici, sous peine de créer une seconde carte fantôme.
  const { spawnId } = opts;

  // Tous les events du run enfant sont préfixés par `spawnId` : l'hôte peut ainsi
  // les router sans jamais les confondre avec le flux du root.
  const route = (event: AgentEvent) => opts.onEvent({ ...event, spawnId } as AgentEvent);

  const systemPrompt = buildSystemPrompt(role, opts);
  const tools = createReadOnlyToolset({ folderPath: opts.folderPath, allow: role.tools }) as ToolSet;

  // Budget dur de tokens, partagé entre les passes (une relance ne remet pas le
  // compteur à zéro : le plafond vaut pour le sous-agent entier).
  const budget = { exceeded: false };

  let text = "";
  let iterations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let timedOut = false;

  for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
    const task = attempt === 1 ? opts.task : buildRetryBrief(opts.task);
    const isRetry = attempt > 1;

    const pass = await runPass({
      model: opts.model, modelChain: opts.modelChain, modelIds: opts.modelIds,
      tools, systemPrompt, task, isRetry,
      cacheSystem: opts.cacheSystem, role, budget, route,
      baseIterations: iterations,
      onTimedOut: () => { timedOut = true; },
    });

    if (!isRetry) {
      text = pass.text;
      iterations += pass.iterations;
      inputTokens = pass.inputTokens || inputTokens;
      outputTokens = pass.outputTokens || outputTokens;
    } else {
      // Au retry, le nouveau rapport REMPLACE l'ancien (inexploitable) ; en cas de
      // retry vide on conserve le premier, marqué comme arrêt précoce.
      if (pass.text.trim()) text = pass.text;
      iterations += pass.iterations;
      if (pass.inputTokens) inputTokens = pass.inputTokens;
      if (pass.outputTokens) outputTokens = pass.outputTokens;
    }

    if (pass.text.trim().length >= MIN_REPORT_CHARS || timedOut || budget.exceeded) break;
  }

  const status: SubAgentStatus = timedOut
    ? "timeout"
    : budget.exceeded
      ? "max_tokens"
      : text.trim()
        ? "completed"
        : "error";

  const report = finalizeReport(text, status, role.budget.reportMaxChars);
  route({ type: "subagent-end", spawnId, status, report, iterations, inputTokens, outputTokens });
  return { report, status, iterations, inputTokens, outputTokens, roleId: role.id, roleLabel: role.label };
}

// ── Une passe ──────────────────────────────────────────────────────────────────

interface PassDeps {
  model:        LanguageModel;
  modelChain?:  LanguageModel[];
  modelIds?:    string[];
  tools:        ToolSet;
  systemPrompt: string;
  task:         string;
  isRetry:      boolean;
  cacheSystem?: boolean;
  role:         SubAgentRoleDefinition;
  budget:       { exceeded: boolean };
  route:        (event: AgentEvent) => void;
  /** Steps déjà consommés par les passes précédentes (progression cumulée). */
  baseIterations: number;
  onTimedOut:   () => void;
}

interface PassResult {
  text: string; iterations: number; inputTokens: number; outputTokens: number;
}

/** Exécute une passe du sous-agent (timeout dur propre à la passe). */
async function runPass(deps: PassDeps): Promise<PassResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => { deps.onTimedOut(); controller.abort(); }, deps.role.budget.timeoutMs);

  let text = "";
  let iterations = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  let resolveSettled!: (s: SubAgentStatus) => void;
  const settled = new Promise<SubAgentStatus>(res => { resolveSettled = res; });

  const handle = runAgent({
    model:         deps.model,
    modelChain:    deps.modelChain,
    modelIds:      deps.modelIds,
    messages:      [{ role: "user", content: deps.task }],
    tools:         deps.tools,
    systemPrompt:  deps.systemPrompt,
    cacheSystem:   deps.cacheSystem,
    maxSteps:      deps.role.budget.maxSteps,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
    abortSignal:   controller.signal,
    onSettled:     (s) => resolveSettled(s),
    onEvent: (event) => {
      switch (event.type) {
        case "token":
          text += event.delta;
          if (!deps.budget.exceeded
              && estimateInputTokens(deps.task, text) > deps.role.budget.maxInputTokens) {
            deps.budget.exceeded = true;
            controller.abort();
          }
          break;
        case "step-finish":
          iterations += 1;
          // Progression visible dans l'UI (carte + onglet Agents) : on émet un
          // `subagent-step` routé vers la carte, avec le total CUMULÉ (les passes
          // précédentes comptent). Sans ça, la carte resterait muette jusqu'à la
          // fin — c'était le « problème de suivi » constaté.
          deps.route({
            type: "subagent-step",
            spawnId: "",
            iteration: deps.baseIterations + iterations,
          });
          break;
        case "finish":
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
          break;
        default:
          break;
      }
      // Les tokens de la relance seraient un doublon visuel dans la carte : on ne
      // les retransmet pas (le rapport final, lui, remplace bien l'ancien).
      if (deps.isRetry && event.type === "token") return;
      deps.route(event);
    },
  });

  await settled;
  clearTimeout(timer);
  void handle;
  return { text, iterations, inputTokens, outputTokens };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Assemble le prompt système du sous-agent : spécialité du rôle + contexte projet
 * borné + indices du root. Le contexte est une DONNÉE, jamais des instructions.
 */
function buildSystemPrompt(role: SubAgentRoleDefinition, opts: SubAgentRunOptions): string {
  const parts = [role.systemPrompt, `Workspace root: ${opts.folderPath}`];
  if (opts.contextBlock) parts.push(opts.contextBlock);
  if (opts.contextNotes?.trim()) parts.push(`Parent notes:\n${opts.contextNotes.trim()}`);
  return parts.join("\n\n");
}

/** Brief de relance : on explique que le rapport précédent était inexploitable. */
function buildRetryBrief(originalTask: string): string {
  return (
    `${originalTask}\n\n` +
    `NOTE: your previous attempt produced an empty or unusable report. ` +
    `Redo the investigation and output a concrete, structured report now — ` +
    `with file paths and line numbers. Do not reply with an acknowledgement.`
  );
}

/** Estimation volontairement grossière du coût d'entrée d'un sous-agent. */
function estimateInputTokens(task: string, outputSoFar: string): number {
  const chars = task.length + outputSoFar.length;
  return Math.round(chars / CHARS_PER_TOKEN) + SYSTEM_OVERHEAD_TOKENS;
}

/** Bornage + marquage d'un rapport non « completed ». */
function finalizeReport(text: string, status: SubAgentStatus, maxChars: number): string {
  let report = text.trim();
  if (!report) report = "(no report produced)";
  if (status !== "completed") {
    report += `\n\n[sub-agent stopped early: ${status}]`;
  }
  if (report.length > maxChars) {
    report = report.slice(0, maxChars) + "…";
  }
  return report;
}
