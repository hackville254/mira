// ── Génération de fonctions — extraction et notation isolée (EvalPlus) ────────
//
// On exécute le PROGRAMME DE TEST OFFICIEL fourni par EvalPlus (`task.test`).
// Ce programme contient la fonction `check(candidate)` et, à sa fin, l'appel
// `check(<entry_point>)` : il n'y a donc PAS de « harness de test » à
// réimplémenter. C'est la garantie d'être aligné sur le protocole officiel
// décrit dans la mission (« ne pas réimplémenter un évaluateur officiel quand
// son usage direct est possible »).
//
// SÉCURITÉ
// --------
// Le code produit par le modèle est NON FIABLE : il n'est JAMAIS exécuté sur
// l'hôte. On monte un dossier temporaire en lecture seule dans un conteneur
// Docker verrouillé (réseau coupé, mémoire/CPU/PID bornés, filesystem read-only,
// utilisateur non root, capacités retirées, timeout dur).

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GenerationTask } from "./types";

const exec = promisify(execFile);

/**
 * Image d'exécution : Python 3.11 avec numpy, EXIGÉ par les programmes de test
 * EvalPlus (les helpers de comparaison importent numpy). Aucune dépendance du
 * projet ORVYX n'y est présente.
 */
export const GEN_IMAGE = "python:3.11-slim";

/** Paquets installés dans l'image dérivée (réseau requis UNE fois, à la construction). */
export const GEN_IMAGE_PIP = ["numpy"];

/** Tag local de l'image dérivée contenant les dépendances de test. */
export const GEN_DERIVED_IMAGE = "orvyx-gen-eval:latest";

/**
 * Construit (une seule fois) l'image dérivée `GEN_IMAGE + pip install numpy`.
 *
 * POURQUOI UNE IMAGE DÉRIVÉE ET PAS UN `docker run -- pip install`
 * ---------------------------------------------------------------
 * Un `docker run --rm python pip install numpy` installe numpy dans un
 * conteneur JETABLE : l'étape suivante (exécution des tests) ne le voit jamais.
 * Le bug produisait des `ModuleNotFoundError: numpy` — donc des échecs
 * ATTRIBUÉS À TORT au modèle. Une image dérivée persistante garantit que
 * numpy est bien présent à l'exécution, tout en gardant le code candidat
 * définitivement privé de réseau (`--network none` à l'exécution).
 */
export async function ensureEvalImage(
  image: string = GEN_IMAGE,
  packages: string[] = GEN_IMAGE_PIP,
): Promise<{ image: string; error?: string }> {
  if (packages.length === 0) return { image };

  const t0 = Date.now();
  // Idempotent : si l'image existe déjà, on la réutilise (pas de rebuild).
  const probe = await exec("docker", ["image", "inspect", GEN_DERIVED_IMAGE], {
    timeout: 15_000,
  }).catch(() => null);
  if (probe && probe.stdout) return { image: GEN_DERIVED_IMAGE };

  // Construction via un Dockerfile éphémère (stdin) : réseau actif uniquement ici.
  const dockerfile = `FROM ${image}\nRUN pip install --no-cache-dir ${packages.join(" ")}\n`;
  const dir = await mkdtemp(join(tmpdir(), "orvyx-gen-img-"));
  try {
    await writeFile(join(dir, "Dockerfile"), dockerfile, "utf8");
    await exec("docker", ["build", "-t", GEN_DERIVED_IMAGE, dir], {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    void t0;
    return { image: GEN_DERIVED_IMAGE };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      image,
      error: `construction de l'image d'évaluation impossible : ${(err.stderr ?? err.message ?? "").slice(0, 400)}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenEvalResult {
  /** Vrai si le programme de test officiel est sorti en code 0 (tous les cas). */
  passed: boolean;
  /** Sortie standard (bornée) — diagnostic. */
  stdout: string;
  /** Sortie d'erreur (bornée) — diagnostic. */
  stderr: string;
  /** Message d'erreur si l'exécution n'a pas pu aboutir correctement. */
  error?: string;
}

/**
 * Extrait le code Python d'une réponse de modèle/agent. On privilégie le
 * PREMIER bloc clôturé ```python … ``` ; à défaut, on retombe sur toute la
 * réponse. On ne « répare » JAMAIS le code : tel quel ou rien (une réparation
 * automatique fausserait la mesure).
 */
export function extractCode(response: string): string {
  const fence = /```(?:python|py)?\s*\n([\s\S]*?)```/m.exec(response);
  if (fence) return fence[1].trim();
  return response.trim();
}

/**
 * Construit le fichier Python qui assemble : imports de test + code candidat +
 * programme de test OFFICIEL. L'ordre importe peu ici car le programme de test
 * définit `check()` puis l'appelle en fin de fichier.
 */
export function buildTestFile(task: GenerationTask, candidateCode: string): string {
  const imports = task.testImports.filter(s => s.trim() !== "");
  return [
    "# ── Imports requis par le programme de test EvalPlus ──",
    ...imports,
    "",
    "# ── Code candidat (produit par le modèle/agent) ──",
    candidateCode,
    "",
    "# ── Programme de test OFFICIEL EvalPlus (check + appel final) ──",
    task.test,
    "",
  ].join("\n");
}

export interface RunGenOptions {
  /** Timeout (ms) de l'exécution Docker. Défaut : 60 s. */
  timeoutMs?: number;
  /** Image Docker (défaut : `GEN_IMAGE`). */
  image?: string;
  /**
   * Paquets pip requis par les tests (défaut : `GEN_IMAGE_PIP`). Ils sont
   * installés dans une IMAGE DÉRIVÉE construite une seule fois ; l'exécution du
   * code candidat se fait ensuite TOUJOURS avec `--network none`.
   */
  pipPackages?: string[];
}

/** Borne une sortie pour ne pas polluer les résultats. */
function bound(s: string, n = 4000): string {
  return s.length > n ? `${s.slice(0, n)}\n…[tronqué]` : s;
}

/**
 * Exécute le programme de test officiel contre le code candidat, DANS DOCKER.
 * Le dossier temporaire est TOUJOURS nettoyé.
 *
 * Le réseau est nécessaire UNIQUEMENT pour installer numpy ; on l'active pour
 * cette étape courte, puis on exécute les tests avec `--network none` de sorte
 * que le code candidat ne puisse jamais atteindre le réseau.
 */
export async function runGeneration(
  task: GenerationTask,
  candidateCode: string,
  opts: RunGenOptions = {},
): Promise<GenEvalResult> {
  const baseImage = opts.image ?? GEN_IMAGE;
  const pkg = opts.pipPackages ?? GEN_IMAGE_PIP;

  // 0) Garantir l'image d'évaluation (dépendances des tests). Échec = erreur de
  //    HARNAIS : on ne l'impute jamais au modèle.
  const img = await ensureEvalImage(baseImage, pkg);
  if (img.error) {
    return { passed: false, stdout: "", stderr: "", error: img.error };
  }

  const dir = await mkdtemp(join(tmpdir(), "orvyx-gen-"));
  try {
    await writeFile(join(dir, "test_solution.py"), buildTestFile(task, candidateCode), "utf8");

    // Exécution des tests (réseau COUPÉ). Le code candidat ne peut rien exfiltrer.
    const run = [
      "run", "--rm",
      "--network", "none",
      "--memory", "1g", "--memory-swap", "1g",
      "--cpus", "1",
      "--pids-limit", "256",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--user", "65534:65534",
      "-v", `${dir}:/work:ro`,
      "-w", "/work",
      img.image,
      "python", "-u", "test_solution.py",
    ];
    try {
      const { stdout, stderr } = await exec("docker", run, {
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { passed: true, stdout: bound(stdout), stderr: bound(stderr) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      return {
        passed: false,
        stdout: bound(err.stdout ?? ""),
        stderr: bound(err.stderr ?? ""),
        error: err.killed ? "timeout/limite d'exécution" : undefined,
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Classe l'issue d'une tentative de génération à partir du résultat de test et
 * des signaux du mode (erreur fournisseur, timeout, réponse tronquée, aucun
 * texte). C'est ici que se joue la VENTILATION honnête : une erreur du
 * fournisseur n'est jamais imputée au modèle.
 */
export function classifyOutcome(input: {
  evalResult: GenEvalResult;
  hadCode: boolean;
  providerErrorClass?: "provider" | "timeout" | "truncated" | "orchestration" | "tool";
  providerError?: string;
}): { resolved: boolean; errorClass?: import("./types").ErrorClass; error?: string } {
  const { evalResult, hadCode, providerErrorClass, providerError } = input;

  // 1) Erreur du fournisseur / harnais AVANT même de juger le code.
  if (providerErrorClass && !evalResult.passed) {
    return { resolved: false, errorClass: providerErrorClass, error: providerError };
  }

  // 2) Le modèle/agent n'a rien produit d'exploitable.
  if (!hadCode) {
    return { resolved: false, errorClass: "no-output", error: providerError ?? "aucun code produit" };
  }

  // 3) Tests officiels : réussis => résolu.
  if (evalResult.passed) return { resolved: true };

  // 4) Échec de tests : si le harnais lui-même a échoué (Docker, image), on ne
  //    l'impute pas au modèle.
  if (evalResult.error && /^construction de l'image/.test(evalResult.error)) {
    return { resolved: false, errorClass: "harness", error: evalResult.error };
  }
  if (evalResult.error === "timeout/limite d'exécution") {
    return { resolved: false, errorClass: "timeout", error: evalResult.error };
  }

  // 5) Sinon : le code a été exécuté et a échoué => échec du MODÈLE.
  const detail = (evalResult.stderr || evalResult.stdout).trim().split("\n").slice(-8).join("\n");
  return {
    resolved: false,
    errorClass: "model",
    error: detail.slice(0, 500) || "tests EvalPlus échoués",
  };
}
