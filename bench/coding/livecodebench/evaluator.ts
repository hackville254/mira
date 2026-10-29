// ── LiveCodeBench — extraction, exécution isolée et notation ──────────────────
//
// Pipeline d'évaluation d'UNE réponse d'agent pour un problème LiveCodeBench :
//   1. EXTRAIRE le code Python de la réponse (bloc ```python … ``` ou texte brut) ;
//   2. ÉCRIRE un runner Python qui, pour CHAQUE cas de test, appelle
//      `Solution().<method>(*args)` et compare la sortie attendue ;
//   3. EXÉCUTER ce runner dans un conteneur Docker VERROUILLÉ :
//        `--network none`, `--memory 512m`, `--cpus 1`, `--pids-limit 128`,
//        `--read-only` (sauf /tmp), utilisateur non root, timeout dur ;
//      le code généré par le modèle est NON FIABLE : il ne doit jamais toucher
//      l'hôte ni le réseau ;
//   4. NOTER : résolu seulement si TOUS les cas passent (publics ET privés).
//
// Le contrat de sortie du runner est un JSON sur la dernière ligne :
//   {"passed": <int>, "total": <int>, "failed": [<indices>], "error": "<msg|>"}
// On ne fait jamais confiance à un code de sortie seul : seul ce JSON compte.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LcbInstance } from "./instance";
import { detectContract } from "./contract";

const exec = promisify(execFile);

/** Image d'exécution : Python nu, aucune dépendance du projet ORVYX. */
export const LCB_IMAGE = "python:3.11-slim";

export interface LcbEvalResult {
  /** Nombre de cas réussis. */
  passed: number;
  /** Nombre total de cas exécutés. */
  total: number;
  /** Indices des cas échoués (diagnostic). */
  failed: number[];
  /** Message d'erreur d'exécution éventuel (compilation, runtime global…). */
  error?: string;
  /**
   * Contrat réellement appliqué. Permet de VÉRIFIER dans les résultats qu'un
   * problème a bien été noté selon sa convention (et de repérer une exclusion).
   */
  contract?: "functional" | "stdin" | "interactive";
  /** Vrai si le problème a été EXCLU (non évaluable), et non « échoué ». */
  skipped?: boolean;
}

/**
 * Extrait le code Python d'une réponse d'agent. On privilégie le PREMIER bloc
 * clôturé ```python … ``` (ou ``` … ```) ; à défaut, on considère toute la
 * réponse comme du code. On ne « répare » pas le code : tel quel ou rien.
 */
export function extractCode(response: string): string {
  const fence = /```(?:python|py)?\s*\n([\s\S]*?)```/m.exec(response);
  if (fence) return fence[1].trim();
  return response.trim();
}

/**
 * Construit le script Python `runner.py` qui exécute la solution contre les cas,
 * SELON LE CONTRAT du problème (cf. `contract.ts`) :
 *
 *   - `functional` : `Solution().<method>(*args)` — LeetCode ;
 *   - `stdin`      : le code est un programme complet ; pour chaque cas on lui
 *                    fournit `input` sur stdin et on compare sa stdout au
 *                    `output` attendu — AtCoder/Codeforces.
 *
 * POURQUOI c'était faux avant : l'ancien runner imposait `import Solution` à
 * tous les problèmes. Les 6 AtCoder (starter vide) échouaient aussitôt
 * (`cannot import name 'Solution'`) alors qu'un programme stdin valide était
 * possible → 6 faux négatifs. Le contrat est désormais déterminé par
 * `detectContract()`, jamais deviné à l'exécution.
 *
 * Les entrées LiveCodeBench fonctionnelles sont des littéraux Python
 * (`[1,2,3]\n2`) évalués via `ast.literal_eval` DANS le conteneur sandboxé.
 */
export function buildRunner(instance: LcbInstance): string {
  return detectContract(instance) === "stdin"
    ? buildStdinRunner(instance)
    : buildFunctionalRunner(instance);
}

/** Runner pour un programme complet : stdin → stdout. */
function buildStdinRunner(instance: LcbInstance): string {
  const cases = instance.cases.map(c => ({ input: c.input, output: c.output }));
  return `import io, json, sys, traceback, subprocess

# Le code candidat est un PROGRAMME complet (AtCoder) : on l'exécute dans un
# sous-processus Python, une fois par cas, en lui fournissant l'input sur stdin.
cases = json.loads(r'''${JSON.stringify(cases)}''')

def _judge_equal(got, want):
    # Comparaison "juge" : on ignore les espaces de fin de ligne et les lignes
    # vides finales (tolérance standard des juges de concours).
    def norm(s):
        lines = [ln.rstrip() for ln in s.replace("\\r\\n", "\\n").split("\\n")]
        while lines and lines[-1] == "":
            lines.pop()
        return "\\n".join(lines)
    return norm(got) == norm(want)

passed = 0
failed = []
error = ""
for i, c in enumerate(cases):
    try:
        proc = subprocess.run(
            [sys.executable, "solution.py"],
            input=c["input"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if _judge_equal(proc.stdout, c["output"]):
            passed += 1
        else:
            failed.append(i)
    except subprocess.TimeoutExpired:
        failed.append(i)
    except Exception as e:
        failed.append(i)
        if not error:
            error = str(e)[:200]
print("__LCB__" + json.dumps({"passed": passed, "total": len(cases), "failed": failed, "error": error}))
`;
}

/** Runner pour `class Solution` : arguments littéraux → valeur de retour. */
function buildFunctionalRunner(instance: LcbInstance): string {
  const method = methodName(instance.starter_code);
  const cases = instance.cases.map(c => ({ input: c.input, output: c.output }));
  // `solutionCode` est injecté dans un module séparé (solution.py) puis importé :
  // on évite toute interpolation de code généré dans une f-string.
  return `import ast, json, sys, traceback

def _run_all():
    try:
        from solution import Solution
    except Exception as e:
        return {"passed": 0, "total": ${cases.length}, "failed": list(range(${cases.length})),
                "error": f"import: {e}"}
    cases = json.loads(r'''${JSON.stringify(cases)}''')
    method = ${JSON.stringify(method)}
    inst = None
    try:
        inst = Solution()
    except Exception as e:
        return {"passed": 0, "total": len(cases), "failed": list(range(len(cases))),
                "error": f"Solution(): {e}"}
    names = [method] if method else []
    names += [n for n in ("twoSum", "solve", "longestEqualSubarray", "solution") if n not in names]
    names += [n for n in dir(inst) if not n.startswith("_") and callable(getattr(inst, n))]
    fn = None
    for n in names:
        f = getattr(inst, n, None)
        if callable(f):
            fn = f
            break
    if fn is None:
        return {"passed": 0, "total": len(cases), "failed": list(range(len(cases))),
                "error": "aucune méthode callable trouvée sur Solution"}
    passed = 0
    failed = []
    for i, c in enumerate(cases):
        try:
            args = _parse_args(c["input"])
            got = fn(*args)
            want = ast.literal_eval(c["output"]) if c["output"].strip() else None
            if _equal(got, want):
                passed += 1
            else:
                failed.append(i)
        except Exception:
            failed.append(i)
    return {"passed": passed, "total": len(cases), "failed": failed, "error": ""}

def _equal(a, b):
    if a == b:
        return True
    # Tolérance usuelle de LiveCodeBench : listes triées identiques.
    try:
        return sorted(a) == sorted(b)
    except Exception:
        return False

def _parse_args(raw):
    # Convention LiveCodeBench : les arguments sont séparés par des retours à la
    # ligne ; un input multi-lignes = PLUSIEURS arguments positionnels. On
    # littéralise donc chaque ligne indépendamment (et non la chaîne entière,
    # qui ne serait pas un littéral Python valide).
    lines = [ln for ln in raw.split("\\n") if ln.strip() != ""]
    if not lines:
        return ()
    return tuple(ast.literal_eval(ln) for ln in lines)

if __name__ == "__main__":
    try:
        out = _run_all()
    except Exception as e:
        out = {"passed": 0, "total": ${cases.length}, "failed": [], "error": traceback.format_exc()[:400]}
    print("__LCB__" + json.dumps(out))
`;
}

/** Devine le nom de méthode attendu à partir du `starter_code`. */
export function methodName(starter: string): string {
  const m = /def\s+([A-Za-z_]\w*)\s*\(/.exec(starter);
  return m ? m[1] : "";
}

/**
 * Extrait le JSON de résultat depuis la sortie du conteneur. On ne lit QUE la
 * ligne préfixée `__LCB__` (marqueur non falsifiable depuis le code évalué car
 * ce dernier ne connaît pas le préfixe… et de toute façon il est sandboxé).
 */
export function parseRunnerOutput(stdout: string, total: number): LcbEvalResult {
  const line = stdout.split("\n").reverse().find(l => l.startsWith("__LCB__"));
  if (!line) return { passed: 0, total, failed: [], error: "sortie du runner illisible" };
  try {
    const o = JSON.parse(line.slice("__LCB__".length)) as LcbEvalResult;
    return {
      passed: Number.isFinite(o.passed) ? o.passed : 0,
      total: Number.isFinite(o.total) ? o.total : total,
      failed: Array.isArray(o.failed) ? o.failed : [],
      error: o.error || undefined,
    };
  } catch {
    return { passed: 0, total, failed: [], error: "JSON de résultat invalide" };
  }
}

export interface RunSolutionOptions {
  /** Timeout (ms) de l'exécution Docker. Défaut : 60 s. */
  timeoutMs?: number;
  /** Image Docker (défaut : `LCB_IMAGE`). */
  image?: string;
}

/**
 * Exécute une solution contre tous les cas d'une instance, DANS DOCKER, et
 * renvoie le résultat de notation. Le dossier temporaire est TOUJOURS nettoyé.
 *
 * Sécurité : réseau coupé, mémoire/CPU/PID bornés, système de fichiers en
 * lecture seule (hors /tmp monté en tmpfs), utilisateur non privilégié, pas de
 * capacités, timeout dur. Le code évalué ne peut ni exfiltrer ni persister.
 */
export async function runSolution(
  instance: LcbInstance,
  solutionCode: string,
  opts: RunSolutionOptions = {},
): Promise<LcbEvalResult> {
  const total = instance.cases.length;
  const contract = detectContract(instance);

  // Problème INTERACTIF : aucun cas hors ligne ne peut le valider. On l'EXCLUT
  // explicitement (`skipped`) au lieu de le compter comme un échec du modèle.
  if (contract === "interactive") {
    return {
      passed: 0, total, failed: [], contract,
      skipped: true,
      error: "problème interactif : non évaluable avec des cas hors ligne (exclu du score)",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "orvyx-lcb-"));
  try {
    await writeFile(join(dir, "solution.py"), solutionCode, "utf8");
    await writeFile(join(dir, "runner.py"), buildRunner(instance), "utf8");
    const args = [
      "run", "--rm",
      "--network", "none",
      "--memory", "512m", "--memory-swap", "512m",
      "--cpus", "1",
      "--pids-limit", "128",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--user", "65534:65534",
      "-v", `${dir}:/work:ro`,
      "-w", "/work",
      opts.image ?? LCB_IMAGE,
      "python", "-u", "runner.py",
    ];
    try {
      const { stdout } = await exec("docker", args, {
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { ...parseRunnerOutput(stdout, total), contract };
    } catch (e) {
      const err = e as { stdout?: string; killed?: boolean; message?: string };
      // Timeout / OOM / crash : on retente une lecture de stdout (peut contenir
      // un résultat partiel) puis on renvoie un échec explicite.
      if (err.stdout) {
        const parsed = parseRunnerOutput(err.stdout, total);
        if (parsed.failed.length > 0 || parsed.passed > 0 || parsed.error) return { ...parsed, contract };
      }
      return {
        passed: 0, total, failed: [], contract,
        error: err.killed ? "timeout/limite d'exécution" : (err.message ?? "échec docker"),
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Un problème est RÉSOLU seulement si TOUS les cas passent (aucun échec) et
 * qu'aucune erreur d'exécution globale n'est survenue. Un problème EXCLU
 * (interactif) n'est jamais « résolu » — il est compté séparément.
 */
export function isResolved(r: LcbEvalResult): boolean {
  if (r.skipped) return false;
  return r.total > 0 && r.passed === r.total && r.failed.length === 0 && !r.error;
}
