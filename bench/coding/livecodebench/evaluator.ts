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
 * Construit le script Python `runner.py` qui exécute la solution contre les cas.
 *
 * Convention LiveCodeBench : la solution est une classe `Solution` dont la
 * méthode est déclarée dans le `starter_code` (ex. `def longestEqualSubarray(`).
 * On lit ce nom de méthode dans le starter ; si introuvable, on tente les noms
 * usuels (`twoSum`, `solve`, …) puis, en dernier recours, la seule méthode
 * publique de `Solution`.
 *
 * Les entrées LiveCodeBench sont des chaînes Python-littérales
 * (ex. `[1,2,3]\n2`) : on les évalue donc avec `ast.literal_eval` côté runner.
 * C'est un point délicat mais C'EST la convention du benchmark : le runner
 * tourne dans un conteneur jetable sandboxé, il n'y a aucun secret à y exposer.
 */
export function buildRunner(instance: LcbInstance, solutionCode: string): string {
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

def _equal(a, b):
    if a == b:
        return True
    # Tolérance usuelle de LiveCodeBench : listes triées identiques.
    try:
        return sorted(a) == sorted(b)
    except Exception:
        return False

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
  const dir = await mkdtemp(join(tmpdir(), "orvyx-lcb-"));
  try {
    await writeFile(join(dir, "solution.py"), solutionCode, "utf8");
    await writeFile(join(dir, "runner.py"), buildRunner(instance, solutionCode), "utf8");
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
      return parseRunnerOutput(stdout, total);
    } catch (e) {
      const err = e as { stdout?: string; killed?: boolean; message?: string };
      // Timeout / OOM / crash : on retente une lecture de stdout (peut contenir
      // un résultat partiel) puis on renvoie un échec explicite.
      if (err.stdout) {
        const parsed = parseRunnerOutput(err.stdout, total);
        if (parsed.failed.length > 0 || parsed.passed > 0 || parsed.error) return parsed;
      }
      return { passed: 0, total, failed: [], error: err.killed ? "timeout/limite d'exécution" : (err.message ?? "échec docker") };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Un problème est RÉSOLU seulement si TOUS les cas passent (aucun échec) et
 * qu'aucune erreur d'exécution globale n'est survenue.
 */
export function isResolved(r: LcbEvalResult): boolean {
  return r.total > 0 && r.passed === r.total && r.failed.length === 0 && !r.error;
}
