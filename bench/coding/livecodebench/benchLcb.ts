/**
 * Origin — Hook de benchmark LiveCodeBench, DEV-ONLY, exécuté DANS la webview.
 *
 * POURQUOI CE MODULE (séparé de `benchWebview.ts`)
 * -----------------------------------------------
 * LiveCodeBench mesure la GÉNÉRATION de code : l'agent ne modifie PAS un dépôt,
 * il PRODUIT une solution. Le protocole est donc différent de SWE-bench :
 *   1. on donne à l'agent UN problème (énoncé + `starter_code`) ;
 *   2. l'agent répond par du code (idéalement dans un bloc ```python) ;
 *   3. on extrait ce code et on le NOTE dans un conteneur ISOLÉ (réseau coupé,
 *      limites mémoire/CPU/PID, utilisateur non root) — cf. `livecodebench/evaluator`.
 *
 * SÉCURITÉ
 * --------
 *  - DEV-ONLY (enregistré uniquement quand `import.meta.env.DEV`).
 *  - Le code généré par le modèle est NON FIABLE : il n'est jamais exécuté sur
 *    l'hôte, uniquement dans le sandbox Docker de l'évaluateur.
 *  - Aucune clé journalisée ; la clé ne transite que vers le sidecar.
 *  - Le pilotage de l'agent utilise le MÊME chemin que SWE/fixtures
 *    (`startClineHarness`) : la vraie boucle d'outils de production.
 *
 * NOTE : l'exécution des tests a lieu dans Docker via la commande DEV
 * `bench_bash_run` (l'évaluateur Node construit la commande ; ici on ne peut pas
 * l'importer, car ce module tourne dans la webview). On réimplémente donc
 * UNIQUEMENT l'appel docker verrouillé, à l'identique de `runSolution`.
 */

import { invoke } from "@tauri-apps/api/core";
import { startClineHarness } from "../../../src/lib/agent/clineHarness";
import { resolveClineProvider } from "../../../src/lib/agent/providers";
import { loadPermissionMode, savePermissionMode } from "../../../src/lib/agent/permissions";
import type { AgentEvent } from "../../../src/lib/agent/run";
import { buildSystemPrompt } from "../../../src/lib/agent/prompts";
import type { AttemptResult, TaskCategory } from "../types";

/** Callback d'export (voir `benchWebview`). Dupliqué ici pour éviter un import circulaire. */
export type ExportSink = (fileName: string, json: string) => void;

/** Commande Tauri `bench_bash_run` : exécution DEV bornée (timeout paramétrable). */
interface BenchBashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
}

interface DevAiConfig {
  provider: string | null;
  model: string | null;
  api_key: string | null;
  base_url: string | null;
  configured: boolean;
}

/** Un problème LiveCodeBench tel que fourni au pilote (JSON versionné). */
export interface LcbProblem {
  question_id: string;
  question_title: string;
  question_content: string;
  platform: string;
  contest_date: string;
  difficulty: string;
  starter_code: string;
  /** Nombre de cas de test (public+privé) — sert d'affichage, pas au pilotage. */
  caseCount: number;
}

/** Un cas de test LiveCodeBench (input/output = chaînes Python-littérales). */
export interface LcbCase {
  input: string;
  output: string;
}

export interface WebviewLcbOptions {
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** IDs de problèmes ; par défaut tous ceux fournis à `problems`. */
  questionIds?: string[];
  /** Problèmes chargés côté Node et injectés (la webview ne lit pas de fichier). */
  problems: LcbProblem[];
  /**
   * Cas de test par `question_id` (publics+privés, données du benchmark). Requis
   * pour noter : la webview ne peut pas lire le dataset elle-même.
   */
  cases: Record<string, LcbCase[]>;
  mode?: string;
  autoApprove?: boolean;
  maxIterations?: number;
  runs?: number;
  /** Timeout (ms) de la phase de notation Docker par problème (défaut : 60 s). */
  evalTimeoutMs?: number;
  /** Image Docker de notation (défaut : `python:3.11-slim`). */
  image?: string;
  onProgress?: (info: { questionId: string; run: number; index: number; total: number }) => void;
  /** Export optionnel des résultats bruts (harnais headless). */
  onExport?: ExportSink;
}

interface ResolvedLcbOptions {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  questionIds?: string[];
  problems: LcbProblem[];
  cases: Record<string, LcbCase[]>;
  caseCounts: Record<string, number>;
  mode: string;
  autoApprove: boolean;
  maxIterations: number;
  runs: number;
  evalTimeoutMs: number;
  image: string;
  onProgress?: WebviewLcbOptions["onProgress"];
  onExport?: ExportSink;
}

/** Complète les options manquantes depuis la config de dev Rust (`.env`). */
async function resolveLcbOptions(opts: WebviewLcbOptions): Promise<ResolvedLcbOptions> {
  const dev = await invoke<DevAiConfig>("dev_ai_config");
  const providerId = opts.providerId ?? dev.provider ?? "";
  const modelId = opts.modelId ?? dev.model ?? "";
  const apiKey = opts.apiKey ?? dev.api_key ?? "";
  const baseUrl = opts.baseUrl ?? dev.base_url ?? undefined;
  if (!providerId || !modelId || !apiKey) {
    throw new Error("config AI incomplète : renseigne providerId/modelId/apiKey ou un `.env` ORVYX_AI_*");
  }
  if (!Array.isArray(opts.problems) || opts.problems.length === 0) {
    throw new Error("aucun problème LiveCodeBench fourni (`problems`)");
  }
  if (!opts.cases || typeof opts.cases !== "object") {
    throw new Error("cas de test manquants (`cases`) : la notation est impossible");
  }
  // Le nombre de cas par problème est dérivé des cas fournis (source unique de
  // vérité) : évite toute divergence entre le pilotage et la notation.
  const caseCounts: Record<string, number> = {};
  for (const [id, cs] of Object.entries(opts.cases)) caseCounts[id] = Array.isArray(cs) ? cs.length : 0;
  return {
    providerId, modelId, apiKey, baseUrl,
    questionIds: opts.questionIds, problems: opts.problems,
    cases: opts.cases,
    caseCounts,
    mode: opts.mode ?? "act",
    autoApprove: opts.autoApprove === true,
    maxIterations: Math.max(1, opts.maxIterations ?? 8),
    runs: Math.max(1, opts.runs ?? 1),
    evalTimeoutMs: opts.evalTimeoutMs ?? 60_000,
    image: opts.image ?? "python:3.11-slim",
    onProgress: opts.onProgress,
    onExport: opts.onExport,
  };
}

/**
 * Construit l'instruction donnée à l'agent pour UN problème. Identique pour
 * tous les modèles : c'est le contrat LiveCodeBench (énoncé + starter).
 */
export function lcbInstruction(p: LcbProblem): string {
  const lines = [
    "Résous le problème de programmation suivant en Python.",
    "Réponds UNIQUEMENT avec un bloc de code Python complet (classe `Solution`).",
    "N'exécute aucune commande : donne juste la solution.",
    "",
    `Titre : ${p.question_title}`,
    "",
    p.question_content,
  ];
  if (p.starter_code.trim()) {
    lines.push("", "Code de départ :", "```python", p.starter_code, "```");
  }
  return lines.join("\n");
}

/** Extrait le code Python d'une réponse d'agent (premier bloc clôturé). */
function extractCode(response: string): string {
  const fence = /```(?:python|py)?\s*\n([\s\S]*?)```/m.exec(response);
  return (fence ? fence[1] : response).trim();
}

/**
 * Note une solution dans un conteneur Docker VERROUILLÉ via `bench_bash_run`.
 * On écrit `solution.py` et `runner.py` dans un dossier temporaire (créé par
 * `mktemp`), puis docker monte ce dossier en LECTURE SEULE.
 *
 * IMPORTANT : la construction du runner est dupliquée depuis
 * `livecodebench/evaluator.buildRunner` (même logique) car cet évaluateur est
 * Node et non importable dans la webview. Toute évolution doit être répercutée
 * des deux côtés (note de maintenance).
 */
/** Devine le nom de méthode attendu à partir du `starter_code`. */
export function lcbMethodName(starter: string): string {
  const m = /def\s+([A-Za-z_]\w*)\s*\(/.exec(starter);
  return m ? m[1] : "";
}

/** Cas de test d'un problème (fail-safe : liste vide si absents). */
function resolvedCasesFor(opts: ResolvedLcbOptions, questionId: string): LcbCase[] {
  const cs = opts.cases[questionId];
  return Array.isArray(cs) ? cs : [];
}

async function runSolutionInDocker(
  p: LcbProblem,
  code: string,
  total: number,
  opts: ResolvedLcbOptions,
): Promise<{ passed: number; total: number; error?: string }> {
  const cases = resolvedCasesFor(opts, p.question_id);
  const runner = buildLcbRunnerWithCases(cases, lcbMethodName(p.starter_code));
  // Le code généré est écrit dans un fichier temporaire isolé ; le dossier est
  // monté EN LECTURE SEULE dans le conteneur. `--network none` coupe tout accès
  // réseau ; l'utilisateur 65534 (nobody) n'a aucun privilège.
  const setupCmd = [
    "set -e",
    'd=$(mktemp -d "${TMPDIR:-/tmp}/orvyx-lcb-XXXXXX")',
    `cat > "$d/solution.py" <<'ORVYX_SOLUTION_EOF'\n${code}\nORVYX_SOLUTION_EOF`,
    `cat > "$d/runner.py" <<'ORVYX_RUNNER_EOF'\n${runner}\nORVYX_RUNNER_EOF`,
    'printf "%s" "$d"',
  ].join("\n");
  const setup = await invoke<BenchBashResult>("bench_bash_run", { command: setupCmd, cwd: ".", timeoutMs: 30_000 });
  const dir = setup.stdout.trim();
  if (!dir) return { passed: 0, total, error: `écriture solution échouée : ${(setup.stderr || setup.stdout).slice(0, 200)}` };

  const dockerCmd = [
    "docker", "run", "--rm",
    "--network", "none",
    "--memory", "512m", "--memory-swap", "512m",
    "--cpus", "1", "--pids-limit", "128",
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--user", "65534:65534",
    "-v", `"${dir}:/work:ro"`, "-w", "/work",
    `"${opts.image}"`, "python", "-u", "runner.py",
  ].join(" ");
  try {
    const res = await invoke<BenchBashResult>("bench_bash_run", { command: dockerCmd, cwd: ".", timeoutMs: opts.evalTimeoutMs });
    const parsed = parseLcbOutput(res.stdout, total);
    return parsed;
  } finally {
    // Nettoyage systématique du dossier temporaire (best-effort).
    await invoke<BenchBashResult>("bench_bash_run", { command: `rm -rf "${dir}"`, cwd: "." }).catch(() => undefined);
  }
}

/** Extrait `{passed,total,error}` de la sortie du runner (ligne `__LCB__`). */
export function parseLcbOutput(stdout: string, total: number): { passed: number; total: number; error?: string } {
  const line = stdout.split("\n").reverse().find(l => l.startsWith("__LCB__"));
  if (!line) return { passed: 0, total, error: "sortie du runner illisible" };
  try {
    const o = JSON.parse(line.slice("__LCB__".length)) as { passed?: number; total?: number; error?: string };
    return { passed: Number.isFinite(o.passed) ? (o.passed as number) : 0, total: o.total ?? total, error: o.error || undefined };
  } catch {
    return { passed: 0, total, error: "JSON de résultat invalide" };
  }
}

/**
 * Construit le runner Python à partir des cas RÉELS d'un problème. Le code de la
 * solution est importé depuis `solution.py` (JAMAIS interpolé). Seul le contenu
 * des cas (données du benchmark, de confiance) est embarqué.
 *
 * ATTENTION : miroir de `livecodebench/evaluator.buildRunner` (Node). Toute
 * évolution de la logique de notation doit être répercutée des deux côtés.
 */
export function buildLcbRunnerWithCases(cases: LcbCase[], method: string): string {
  const total = cases.length;
  const payload = JSON.stringify(cases.map(c => ({ input: c.input, output: c.output })));
  return `import ast, json
def _equal(a, b):
    if a == b:
        return True
    try:
        return sorted(a) == sorted(b)
    except Exception:
        return False

def _run():
    try:
        from solution import Solution
        inst = Solution()
    except Exception as e:
        return {"passed": 0, "total": ${total}, "failed": list(range(${total})), "error": f"import: {e}"}
    cases = json.loads(r'''${payload}''')
    method = ${JSON.stringify(method)}
    names = ([method] if method else []) + [n for n in ("twoSum", "solve", "longestEqualSubarray") if n]
    names += [n for n in dir(inst) if not n.startswith("_") and callable(getattr(inst, n))]
    fn = None
    for n in names:
        f = getattr(inst, n, None)
        if callable(f):
            fn = f
            break
    if fn is None:
        return {"passed": 0, "total": len(cases), "failed": list(range(len(cases))), "error": "aucune méthode callable"}
    passed = 0
    failed = []
    for i, c in enumerate(cases):
        try:
            args = ast.literal_eval(c["input"]) if c["input"].strip() else ()
            if not isinstance(args, tuple):
                args = (args,)
            got = fn(*args)
            want = ast.literal_eval(c["output"]) if c["output"].strip() else None
            if _equal(got, want):
                passed += 1
            else:
                failed.append(i)
        except Exception:
            failed.append(i)
    return {"passed": passed, "total": len(cases), "failed": failed, "error": ""}

print("__LCB__" + json.dumps(_run()))
`;
}

/**
 * Exécute UNE tentative LiveCodeBench : VRAI agent (sidecar) pour produire le
 * code, puis notation Docker. Ne lève jamais : erreur → `AttemptResult` classé.
 */
async function runOneLcb(p: LcbProblem, opts: ResolvedLcbOptions, run: number): Promise<AttemptResult> {
  const total = opts.caseCounts[p.question_id] ?? p.caseCount;
  const base: AttemptResult = {
    taskId: p.question_id, modelId: `cline:${opts.modelId}`, run,
    outcome: "harness-error", agentMs: 0, testMs: 0, failToPass: [], passToPass: [],
  };
  let errorMessage: string | undefined;
  let responseText = "";
  const diagnostics: string[] = [];
  try {
    const clineProvider = resolveClineProvider(opts.providerId);
    let done: () => void = () => {};
    const finished = new Promise<void>((r) => { done = r; });
    let turns = 0, toolCalls = 0, inputTokens = 0, outputTokens = 0;

    const onEvent = (e: AgentEvent): void => {
      if (e.type === "approval-required") {
        if (opts.autoApprove) e.approve();
        else e.reject("bench: approbation non accordée (canal absent)");
        return;
      }
      if (e.type === "tool-call") toolCalls++;
      else if (e.type === "step-finish") turns++;
      // Le TEXTE de l'assistant arrive par deltas de `token` (aucun événement
      // `message`/`text` n'existe dans ce runtime) : on accumule.
      else if (e.type === "token") responseText += e.delta;
      else if (e.type === "finish") {
        inputTokens += e.usage?.inputTokens ?? 0;
        outputTokens += e.usage?.outputTokens ?? 0;
      } else if (e.type === "error") errorMessage = e.message;
      else if (e.type === "terminal-output") diagnostics.push(e.chunk);
      else if (e.type === "notice") diagnostics.push(`${e.kind}: ${e.detail}`);
      if (e.type === "finish" || e.type === "error") done();
    };

    const handle = await startClineHarness({
      workspace: ".",
      providerId: clineProvider.providerId,
      baseUrl: clineProvider.baseUrl,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      systemPrompt: buildSystemPrompt("agent", true),
      mode: opts.mode,
      maxIterations: opts.maxIterations,
      onEvent,
      onBeforeWrite: () => {},
    });
    if (!handle) throw new Error("sidecar Cline indisponible (démarrage échoué)");

    const tAgent = Date.now();
    const timer = setTimeout(() => {
      errorMessage = errorMessage ?? "timeout de génération";
      void handle.abort().finally(done);
    }, 5 * 60 * 1000);
    try {
      // `engine.send` n'acquitte qu'en fin de tour (> 30 s) → on n'attend QUE la
      // fin réelle (`finish`/`error`), jamais l'ack du SDK.
      void handle.send(lcbInstruction(p)).catch((e) => {
        diagnostics.push(`send-ack: ${e instanceof Error ? e.message : String(e)}`);
      });
      await finished;
    } finally {
      clearTimeout(timer);
      handle.dispose();
    }
    base.agentMs = Date.now() - tAgent;
    base.turns = turns;
    base.toolCalls = toolCalls;
    base.inputTokens = inputTokens;
    base.outputTokens = outputTokens;

    const code = extractCode(responseText);
    if (!code) {
      base.outcome = "agent-error";
      base.error = "aucun code extrait de la réponse";
      return base;
    }

    const tEval = Date.now();
    const evalRes = await runSolutionInDocker(p, code, total, opts);
    base.testMs = Date.now() - tEval;
    // Un seul « test » logique par problème : tous les cas publics+privés.
    base.failToPass = [{ name: `${p.question_id} (${total} cas)`, passed: evalRes.total > 0 && evalRes.passed === evalRes.total }];
    base.outcome = base.failToPass[0].passed ? "resolved" : "unresolved";
    if (base.outcome !== "resolved" && evalRes.error) base.error = evalRes.error;
    if (base.outcome !== "resolved" && errorMessage) base.error = base.error ?? errorMessage;
    return base;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    base.outcome = "agent-error";
    return base;
  }
}

/**
 * Exécute les problèmes LiveCodeBench demandés, `runs` fois chacun. L'agent
 * génère le code (sidecar), l'évaluateur le note dans Docker. Aucun patch de
 * dépôt : chaque problème est indépendant.
 */
export async function runWebviewLcb(opts: WebviewLcbOptions): Promise<AttemptResult[]> {
  const resolved = await resolveLcbOptions(opts);
  const selected = resolved.questionIds
    ? resolved.problems.filter(p => resolved.questionIds!.includes(p.question_id))
    : resolved.problems;
  const total = selected.length * resolved.runs;

  const previousMode = loadPermissionMode();
  savePermissionMode("full");
  try {
    const results: AttemptResult[] = [];
    let index = 0;
    for (const p of selected) {
      for (let r = 1; r <= resolved.runs; r++) {
        index++;
        resolved.onProgress?.({ questionId: p.question_id, run: r, index, total });
        results.push(await runOneLcb(p, resolved, r));
      }
    }
    resolved.onExport?.("lcb-results.json", JSON.stringify(results, null, 2));
    return results;
  } finally {
    savePermissionMode(previousMode);
  }
}

/** Catégorie de tâche pour l'agrégation (LCB = génération pure). */
export const LCB_KIND: TaskCategory = "feature";

/**
 * Lit un lot de payload LiveCodeBench depuis le DISQUE via `read_file` (chemin
 * validé côté Rust par `workspaceRoot`). La webview ne peut pas lire de fichier
 * directement et le dataset complet est trop volumineux pour le bundle : on
 * injecte donc UN LOT à la fois (cf. `livecodebench/cli.ts --shard-size`).
 *
 * Le JSON contient `{problems, cases}` produits hors ligne par la CLI — jamais
 * de décodage pickle ici (sécurité : le pickle est traité en Python jetable).
 */
export async function loadLcbShardViaTauri(
  path: string,
  workspaceRoot: string,
): Promise<{ problems: LcbProblem[]; cases: Record<string, LcbCase[]> }> {
  const text = await invoke<string>("read_file", { path, workspaceRoot });
  const data = JSON.parse(text) as {
    problems: LcbProblem[];
    cases: Record<string, LcbCase[]>;
  };
  if (!Array.isArray(data.problems) || typeof data.cases !== "object") {
    throw new Error(`lot LiveCodeBench invalide : ${path}`);
  }
  return { problems: data.problems, cases: data.cases };
}
