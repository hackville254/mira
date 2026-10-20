// ── SWE-bench — préparation d'environnement d'une instance (Docker) ────────────
//
// Rôle : transformer une instance SWE-bench (dépôt réel + commit + test_patch)
// en un dépôt LOCAL prêt pour l'agent, dans un état initial VÉRIFIÉ, exécutable
// par un conteneur Docker dédié.
//
// POURQUOI DOCKER (et pas un venv local)
// --------------------------------------
// Les instances SWE-bench ciblent des dépôts de 2021-2023 (astropy 4.3,
// sympy 1.5, scikit-learn 1.3) qui NE COMPILENT PAS avec les Python récents
// (3.11/3.14) ni clang moderne sur macOS arm64. Le protocole officiel utilise
// une image Docker linux/amd64 par instance — reproduit ici. Docker tourne en
// émulation sur Apple Silicon.
//
// ÉTAPES :
//   1. clone superficiel du dépôt (blob:none) puis checkout du `base_commit` ;
//   2. génération d'un `Dockerfile` par instance (python3.9 + gcc/git + deps) ;
//   3. build de l'image ; le dépôt est monté au run (pas copié dans l'image) ;
//   4. le conteneur installe le dépôt (`pip install -e .`) une fois, à la
//      demande, via `docker run` ;
//   5. VÉRIFICATION : au moins un test FAIL_TO_PASS doit ÉCHOUER avant l'agent.
//      Sans cette preuve, l'instance est déclarée `not-ready`.
//
// Le dépôt n'est JAMAIS copié dans l'image : l'agent (webview Tauri) écrit dans
// le dossier HÔTE, et les tests tournent dans le conteneur sur ce même dossier
// monté — un seul état, partagé.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SweBenchInstance } from "./instance";

const exec = promisify(execFile);

/** Dépendances minimales par dépôt (issues des specs officielles SWE-bench). */
interface RepoSpec {
  /**
   * Image de base (Python 3.9). IMPORTANT : `bullseye` (Debian 11, gcc 10) et
   * non `slim`/`bookworm` — le protocole officiel SWE-bench utilise l'image
   * `swebench/sweb.eval.*` basée sur bullseye. Avec gcc 12 (bookworm), la
   * compilation des vieux C d'astropy 4.3 échoue car `-Wincompatible-pointer-types`
   * y est une ERREUR (cf. journal de développement).
   */
  baseImage: string;
  /** Paquets pip à installer AVANT le dépôt. */
  preinstall: string[];
  /** Version de setuptools qui build encore les vieux setup.py. */
  setuptools: string;
  /**
   * Outils de test spécifiques au dépôt. Par défaut `TEST_TOOLS`. Certains
   * dépôts anciens exigent une version MAJEURE de pytest incompatible avec la
   * version par défaut (ex. sympy 1.5 → `py.test` supprimé dans pytest 7).
   */
  pytestTools?: string[];
}

/**
 * Specs par dépôt. Ces listes proviennent des `environment.yml` officiels
 * (`swebench/resources/swebench-og/<repo>/<id>/environment.yml`) — voir la
 * documentation fournie dans `swebench/README.md`. Elles ne sont PAS inventées.
 */
const REPO_SPECS: Record<string, RepoSpec> = {
  "astropy/astropy": {
    baseImage: "python:3.9-bullseye",
    // Deps d'EXÉCUTION + de TEST d'astropy 4.3 (environment.yml officiel) :
    // `hypothesis` est requis dès la collecte (conftest.py racine l'importe).
    // `extension-helpers` + `setuptools_scm` sont les build-deps déclarés dans
    // le `pyproject.toml` d'astropy : sans eux, `pip install -e .` échoue sur
    // `SetupRequirementsError` (setuptools 68) et l'install est silencieusement
    // incomplète (pas de `astropy/_version.py` → « broken installation »).
    preinstall: [
      "numpy==1.25.2",
      "pyerfa==2.0.0.3",
      "packaging==23.1",
      "hypothesis==6.82.6",
      "PyYAML>=3.13",
      "setuptools_scm>=6.2",
      "extension-helpers",
      // Build-deps déclarés dans le `pyproject.toml` d'astropy 4.3. Sans Cython,
      // les `.c` générés (`astropy/table/_np_utils.c`, wrappers wcs) n'existent
      // pas et gcc échoue sur « No such file or directory ».
      "cython==0.29.22",
    ],
    setuptools: "68.0.0",
  },
  "sympy/sympy": {
    baseImage: "python:3.9-bullseye",
    // Sympy 1.5 (2019) appelle `py.test.mark` — l'API pytest a supprimé `py.test`
    // à partir de pytest 7. On reste donc sur pytest 5, avec le paquet `py` et
    // `mpmath` (dépendance d'exécution de sympy).
    preinstall: ["mpmath==1.3.0", "hypothesis==6.82.6"],
    setuptools: "68.0.0",
    pytestTools: ["pytest==5.4.3", "py==1.11.0"],
  },
  "scikit-learn/scikit-learn": {
    baseImage: "python:3.9-bullseye",
    // `pandas` est REQUIS : les FAIL_TO_PASS de l'instance 25570 sont paramétrés
    // `[list]`/`[bool]`/`[bool_int]` et ne sont collectés QUE si pandas est là.
    preinstall: ["numpy==1.25.2", "scipy==1.11.3", "cython==3.0.5", "joblib", "threadpoolctl",
      "pandas==2.0.3"],
    setuptools: "68.0.0",
  },
};

/** Spec par défaut si le dépôt n'est pas listé (jamais silencieux : cf. README). */
const DEFAULT_SPEC: RepoSpec = {
  baseImage: "python:3.9-bullseye",
  preinstall: [],
  setuptools: "68.0.0",
};

/**
 * Outils de test communs. `pytest-astropy` fournit les plugins que les
 * `setup.cfg` d'astropy EXIGENT (`--doctest-rst` → pytest-doctestplus,
 * `pytest_astropy_header`) : sans eux, pytest refuse de démarrer sur astropy.
 * C'est l'extra `test` déclaré par astropy lui-même.
 */
const TEST_TOOLS = ["pytest==7.4.0", "pytest-timeout", "pytest-astropy"];

/** Résultat de la préparation d'une instance. */
export interface PreparedInstance {
  instanceId: string;
  /** Dossier du dépôt prêt (l'agent travaille ici). */
  workdir: string;
  /** Nom de l'image Docker construite pour cette instance. */
  image: string;
  /** Vrai si la vérification préalable a prouvé l'échec des FAIL_TO_PASS. */
  ready: boolean;
  /** Raison si `ready === false` (dépendances obsolètes, patch…). */
  reason?: string;
}

export interface PrepareOptions {
  /** Racine de stockage des environnements préparés. */
  root: string;
  /** Profondeur du clone superficiel (doit couvrir base_commit). */
  cloneDepth?: number;
  /** Timeout (ms) par commande git / docker build (défaut : 30 min). */
  commandTimeoutMs?: number;
  /** Force la reconstruction de l'image même si elle existe. */
  rebuild?: boolean;
  /**
   * Utilise l'image officielle SWE-bench publiée par Princeton (`docker pull`)
   * au lieu de reconstruire une image locale. Défaut : `true`. Mettre `false`
   * uniquement pour reproduire l'ancien chemin (clone + build + `pip install -e .`).
   */
  officialImage?: boolean;
  /** Journalisation optionnelle (jamais de secret dans les messages). */
  log?: (msg: string) => void;
}

export function specFor(repo: string): RepoSpec {
  return REPO_SPECS[repo] ?? DEFAULT_SPEC;
}

/** Nom d'image Docker stable et lisible pour une instance. */
export function imageName(inst: SweBenchInstance): string {
  return `orvyx-swebench:${inst.instance_id.replace(/[^\w.-]/g, "-")}`;
}

/**
 * Nom de l'IMAGE OFFICIELLE SWE-bench publiée par Princeton sur Docker Hub.
 *
 * Le harness officiel NE construit PAS d'image par instance : il **pull** une
 * image pré-construite `swebench/sweb.eval.x86_64.<org>_<ver>_<repo>-<num>`, où
 * `<ver>` est un identifiant interne du harness (`1776` pour ce jeu). Cette image
 * contient le dépôt cloné au `base_commit`, installé en **editable** dans
 * `/testbed` (`pip install -e .`), avec TOUTES ses dépendances officielles.
 *
 * Utiliser ces images à la place de specs reconstruites est PLUS fidèle : c'est
 * exactement l'environnement de référence, sans deviner les dépendances.
 */
export function officialImageName(inst: SweBenchInstance): string {
  const m = /^(.+)__(.+-[0-9]+)$/.exec(inst.instance_id);
  if (!m) throw new Error(`instance_id inattendu : ${inst.instance_id}`);
  const [, org, rest] = m;
  return `swebench/sweb.eval.x86_64.${org}_1776_${rest}`;
}

/** Télécharge l'image officielle si absente. Idempotent (docker est cache-aware). */
async function ensureOfficialImage(inst: SweBenchInstance, timeout: number, log: (m: string) => void): Promise<string> {
  const image = officialImageName(inst);
  const have = await exec("docker", ["image", "inspect", image])
    .then(() => true)
    .catch(() => false);
  if (have) {
    log(`${inst.instance_id} : image officielle déjà présente`);
    return image;
  }
  log(`${inst.instance_id} : pull de l'image officielle ${image} (plusieurs Go possibles)`);
  await exec("docker", ["pull", "--platform", "linux/amd64", image],
    { timeout, maxBuffer: 128 * 1024 * 1024 });
  return image;
}

/**
 * Extrait `/testbed` de l'image officielle vers l'hôte. L'agent travaille sur
 * cette copie ; les tests remontent ce dossier sur `/testbed` dans le conteneur,
 * donc le paquet (installé en editable sur `/testbed`) prend les modifications
 * de l'agent sans réinstallation.
 */
async function extractTestbed(image: string, repoDir: string, _dir: string, timeout: number, log: (m: string) => void): Promise<void> {
  log(`extraction de /testbed depuis l'image officielle`);
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  // `docker create` + `docker cp` : ne lance pas la commande de l'image (plus sûr).
  const { stdout } = await exec("docker", ["create", "--platform", "linux/amd64", image], { timeout });
  const cid = stdout.trim();
  try {
    await exec("docker", ["cp", `${cid}:/testbed/.`, repoDir], { timeout, maxBuffer: 512 * 1024 * 1024 });
  } finally {
    await exec("docker", ["rm", "-f", cid], { timeout }).catch(() => {});
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Exécute une commande et renvoie stdout (lève sur exit non nul). */
async function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, timeout, maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

/** Construit le Dockerfile d'une instance (le dépôt est monté, pas copié). */
export function buildDockerfile(inst: SweBenchInstance): string {
  const spec = specFor(inst.repo);
  const lines = [
    `# Généré pour l'instance ${inst.instance_id} (${inst.repo}) — protocole SWE-bench.`,
    `FROM ${spec.baseImage}`,
    `# Debian 11 (bullseye) est EOL : les miroirs deb.debian.org ne servent plus`,
    `# les paquets. On repointe vers l'archive officielle AVANT tout apt-get.`,
    `RUN sed -i -e 's|deb.debian.org|archive.debian.org|g' \\`,
    `           -e 's|security.debian.org|archive.debian.org|g' \\`,
    `           -e '/bullseye-updates/d' /etc/apt/sources.list \\`,
    `    && printf 'Acquire::Check-Valid-Until "false";\\n' > /etc/apt/apt.conf.d/99no-check-valid-until`,
    `# Outils de build + git (le dépôt est monté sur /testbed au run).`,
    `# Les flags C permissifs sont NÉCESSAIRES : le C de 2021 (astropy wcs) émet des`,
    `# avertissements devenus bloquants sous gcc/g++ 11. Activer ces flags au lieu de`,
    `# descendre de compilateur garde l'image alignée sur le protocole SWE-bench.`,
    `ENV CFLAGS="-Wno-error -Wno-incompatible-pointer-types -Wno-implicit-function-declaration" \\`,
    `    CXXFLAGS="-Wno-error -Wno-incompatible-pointer-types -Wno-implicit-function-declaration" \\`,
    `    ASTRONOMY_USE_EXTERNAL_ERFA=0`,
    `RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \\`,
    `    git gcc g++ build-essential ca-certificates \\`,
    `    && rm -rf /var/lib/apt/lists/*`,
    `RUN pip install --no-cache-dir "setuptools==${spec.setuptools}" wheel`,
  ];
  const pre = [...spec.preinstall, ...(spec.pytestTools ?? TEST_TOOLS)];
  if (pre.length > 0) {
    lines.push(`RUN pip install --no-cache-dir ${pre.map(p => `"${p}"`).join(" ")}`);
  }
  lines.push(`WORKDIR /testbed`);
  lines.push(`# Le point d'entrée laisse le conteneur vivant : les tests sont lancés`);
  lines.push(`# par ` + "`docker exec`/`docker run`" + ` avec la commande de l'instance.`);
  lines.push(`CMD ["sleep", "infinity"]`);
  return `${lines.join("\n")}\n`;
}

/**
 * Chemin « image officielle » : pull de l'image Princeton puis extraction de
 * `/testbed` vers l'hôte. Aucun build, aucune installation Python locale — le
 * dépôt est DÉJÀ installé en editable dans l'image, donc les modifications de
 * l'agent (sur la copie hôte montée sur `/testbed`) sont prises en compte sans
 * réinstallation. C'est exactement l'environnement de référence du benchmark.
 */
async function prepareFromOfficialImage(
  inst: SweBenchInstance,
  ctx: PrepareOptions & { log: (m: string) => void; timeout: number; dir: string; repoDir: string; marker: string; image: string },
): Promise<PreparedInstance> {
  const { log, timeout, dir, repoDir, marker, image } = ctx;
  try {
    await ensureOfficialImage(inst, timeout, log);
    // Le marqueur ne vaut QUE si le dépôt extrait est réellement présent : sinon
    // on ré-extrait (le marqueur seul ne prouve rien).
    if (!(await exists(join(repoDir, ".git")))) {
      await extractTestbed(image, repoDir, dir, timeout, log);
    }

    // VÉRIFICATION : les FAIL_TO_PASS doivent échouer AVANT l'agent. `ensureArmed`
    // repart du base_commit propre (extrait) et applique le test_patch officiel.
    log(`${inst.instance_id} : vérification de l'échec préalable (image officielle)`);
    const armed = await verifyFailToPassFails(inst, repoDir, image, timeout);
    if (!armed.ok) {
      return { instanceId: inst.instance_id, workdir: repoDir, image, ready: false, reason: armed.reason };
    }

    await writeFile(marker, new Date().toISOString(), "utf8");
    return { instanceId: inst.instance_id, workdir: repoDir, image, ready: true };
  } catch (e) {
    return {
      instanceId: inst.instance_id,
      workdir: repoDir,
      image,
      ready: false,
      reason: String(e instanceof Error ? e.message : e).slice(0, 800),
    };
  }
}

/**
 * Prépare l'environnement d'UNE instance : clone + Dockerfile + image + venv
 * d'installation du dépôt. Idempotent : si `<root>/<instance_id>/.prepared`
 * existe et que l'image est présente, retourne directement.
 */
export async function prepareInstance(
  inst: SweBenchInstance,
  opts: PrepareOptions,
): Promise<PreparedInstance> {
  const log = opts.log ?? (() => {});
  const timeout = opts.commandTimeoutMs ?? 30 * 60 * 1000;
  const cloneDepth = opts.cloneDepth ?? 2000;
  const dir = join(opts.root, inst.instance_id);
  const repoDir = join(dir, "repo");
  const marker = join(dir, ".prepared");
  // Chemin PRIORITAIRE : image officielle SWE-bench (dépôt installé en editable
  // dans /testbed, dépendances de référence). Repli sur l'image reconstruite
  // uniquement si le pull est explicitement désactivé (`officialImage: false`).
  const useOfficial = opts.officialImage !== false;
  const image = useOfficial ? officialImageName(inst) : imageName(inst);

  if (!opts.rebuild && (await exists(marker))) {
    log(`${inst.instance_id} : déjà préparée`);
    return { instanceId: inst.instance_id, workdir: repoDir, image, ready: true };
  }

  await mkdir(dir, { recursive: true });

  if (useOfficial) {
    return prepareFromOfficialImage(inst, { ...opts, log, timeout, dir, repoDir, marker, image });
  }

  try {
    // 1. Clone superficiel + checkout du commit de base.
    if (!(await exists(join(repoDir, ".git")))) {
      log(`${inst.instance_id} : clone de ${inst.repo}`);
      await rm(repoDir, { recursive: true, force: true });
      await run("git", ["clone", "--filter=blob:none", "--no-checkout",
        `https://github.com/${inst.repo}.git`, repoDir], dir, timeout);
    }
    log(`${inst.instance_id} : checkout ${inst.base_commit.slice(0, 7)}`);
    await run("git", ["fetch", "--depth", String(cloneDepth), "origin", inst.base_commit], repoDir, timeout)
      .catch(() => "");
    await run("git", ["checkout", "--force", inst.base_commit], repoDir, timeout);
    await run("git", ["clean", "-fdx"], repoDir, timeout).catch(() => "");

    // 2. Dockerfile + build de l'image (linux/amd64, comme l'officiel).
    const dockerfile = join(dir, "Dockerfile");
    await writeFile(dockerfile, buildDockerfile(inst), "utf8");
    log(`${inst.instance_id} : docker build (${image}) — peut prendre plusieurs minutes`);
    await run("docker", ["build", "--platform", "linux/amd64", "-t", image, "-f", dockerfile, dir], dir, timeout);

    // 3. Application du test_patch ET installation du dépôt DANS le conteneur.
    //    On installe le dépôt en mode éditable sur la copie montée.
    if (inst.test_patch.trim() !== "") {
      const patchFile = join(dir, "test_patch.diff");
      await writeFile(patchFile, inst.test_patch, "utf8");
      log(`${inst.instance_id} : application du test_patch`);
      await run("git", ["apply", "--whitespace=nowarn", patchFile], repoDir, timeout);
    }

    // Installer le dépôt en mode éditable DANS le conteneur (dépôt monté).
    // `-e .` est OBLIGATOIRE pour les instances : un `pip install .` classique
    // créerait un paquet figé dans site-packages, que l'agent (qui écrit sur
    // l'hôte) ne modifierait jamais. On garde la sortie complète pour pouvoir
    // échouer avec le vrai message.
    log(`${inst.instance_id} : installation du dépôt dans le conteneur (pip install -e .)`);
    try {
      await exec("docker", ["run", "--rm", "--platform", "linux/amd64",
        "-v", `${repoDir}:/testbed`, "-w", "/testbed", image,
        "pip", "install", "--no-build-isolation", "-e", "."],
        { cwd: dir, timeout, maxBuffer: 128 * 1024 * 1024 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      const detail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ");
      return {
        instanceId: inst.instance_id,
        workdir: repoDir,
        image,
        ready: false,
        reason: `pip install -e . a échoué : ${detail.slice(0, 600)}`,
      };
    }

    // 4. VÉRIFICATION : un FAIL_TO_PASS doit échouer AVANT l'agent.
    log(`${inst.instance_id} : vérification de l'échec préalable`);
    const armed = await verifyFailToPassFails(inst, repoDir, image, timeout);
    if (!armed.ok) {
      return { instanceId: inst.instance_id, workdir: repoDir, image, ready: false, reason: armed.reason };
    }

    await writeFile(marker, new Date().toISOString(), "utf8");
    return { instanceId: inst.instance_id, workdir: repoDir, image, ready: true };
  } catch (e) {
    return {
      instanceId: inst.instance_id,
      workdir: repoDir,
      image,
      ready: false,
      reason: String(e instanceof Error ? e.message : e).slice(0, 800),
    };
  }
}

export interface PytestOutcome {
  /** Au moins une ligne `PASSED`. */
  passed: boolean;
  /** Au moins une ligne `FAILED`. */
  failed: boolean;
  /** Au moins une ligne `ERROR`. */
  errored: boolean;
  /** pytest n'a résolu aucun test (`no tests ran` / `not found`). */
  unresolved: boolean;
}

/**
 * Analyse la sortie `pytest -rA` de façon défensive.
 *
 * On neutralise d'abord les séquences ANSI (`\x1b[...m`) : bien que `runPytest`
 * passe `--color=no`, un plugin ou une version de pytest peut coloriser malgré
 * tout. Sans ce nettoyage, une ligne `\x1b[32mPASSED\x1b[0m` ne matcherait
 * jamais `^PASSED`, ce qui produisait de faux « environnement suspect ».
 */
export function parsePytestOutcome(stdout: string): PytestOutcome {
  const clean = stripAnsi(stdout);
  return {
    passed: /^PASSED\b/m.test(clean),
    failed: /^FAILED\b/m.test(clean),
    errored: /^(ERROR|XFAIL|XPASS)\b/m.test(clean),
    unresolved: /no tests ran|not found:/i.test(clean),
  };
}

/** Retire les séquences d'échappement ANSI (`ESC[ ... m`) d'une sortie console. */
function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

/**
 * Preuve d'« armement » : exécute les FAIL_TO_PASS sur l'état initial DANS le
 * conteneur. Ils DOIVENT échouer. Si tous passent déjà, l'instance n'a rien à
 * résoudre → `ready: false`.
 */
export async function verifyFailToPassFails(
  inst: SweBenchInstance,
  repoDir: string,
  image: string,
  timeout: number,
): Promise<{ ok: boolean; reason?: string }> {
  const tests = inst.FAIL_TO_PASS;
  if (tests.length === 0) return { ok: false, reason: "FAIL_TO_PASS vide" };
  // État armé GARANTI : base_commit propre + test_patch appliqué. Sans cela, les
  // noms de tests du `test_patch` n'existent pas dans le fichier et pytest répond
  // « not found » — ce qui ressemble à tort à un environnement cassé.
  await ensureArmed(inst, repoDir);
  const stdout = await runPytest(repoDir, image, tests, timeout);
  const o = parsePytestOutcome(stdout);
  const allPass = o.passed && !o.failed && !o.errored;
  // `no tests ran` / `not found` = les noms du test_patch ne sont pas résolus :
  // l'instance est inutilisable (on ne la déclare JAMAIS prête).
  if (o.unresolved && !o.passed && !o.failed) {
    const line = stdout.split("\n").find(l => /not found:|no tests ran/i.test(l)) ?? "";
    return { ok: false, reason: `noms de tests non résolus : ${line.slice(0, 200)}` };
  }
  if (allPass) {
    return { ok: false, reason: "les FAIL_TO_PASS passent déjà sur l'état initial" };
  }
  return { ok: true };
}

/**
 * Garantit l'état « armé » du dépôt : `base_commit` propre (test_patch non
 * appliqué) PUIS application du `test_patch`. Idempotent : si le test_patch est
 * déjà appliqué, `git apply --reverse --check` réussit et on ne fait rien.
 *
 * C'est indispensable car l'agent (et le runner d'oracle) écrivent dans le même
 * dossier hôte : chaque mesure doit repartir d'un état connu.
 */
export async function ensureArmed(inst: SweBenchInstance, repoDir: string): Promise<void> {
  const patchFile = join(dirname(repoDir), "test_patch.diff");
  if (inst.test_patch.trim() === "") return;
  await writeFile(patchFile, inst.test_patch, "utf8");

  // Déjà appliqué ? (`--reverse --check` réussit s'il est présent)
  const applied = await exec("git", ["apply", "--reverse", "--check", patchFile], { cwd: repoDir })
    .then(() => true)
    .catch(() => false);
  if (applied) return;

  // Sinon : repartir du base_commit propre, puis appliquer le test_patch.
  await run("git", ["checkout", "--force", inst.base_commit], repoDir, 120_000);
  await run("git", ["checkout", "--", "."], repoDir, 120_000).catch(() => {});
  await run("git", ["apply", "--whitespace=nowarn", patchFile], repoDir, 120_000);
}

/**
 * Lance pytest DANS le conteneur sur le dépôt monté.
 *
 * Deux subtilités du dataset officiel, découvertes empiriquement :
 *  - `--no-header` n'existe pas dans pytest 5 (sympy 1.5) → on ne l'utilise pas ;
 *  - les noms de tests sont FOURNIS PAR L'INSTANCE et peuvent être soit pleinement
 *    qualifiés (`pkg/tests/test_x.py::test_y[...]`), soit des noms « nus »
 *    (`test_imageset`) que SEUL le fichier de test cible peut résoudre. On extrait
 *    donc les fichiers de test concernés et on les passe explicitement à pytest.
 * `-p no:cacheprovider` évite d'écrire dans le dépôt (état hôte partagé).
 *
 * `--color=no` est INDISPENSABLE : par défaut pytest colore ses lignes de
 * résumé (`\033[32mPASSED\033[0m`), ce qui casserait nos regex d'analyse
 * ancrées en début de ligne. On neutralise aussi toute couleur résiduelle
 * (`FORCE_COLOR=0`) pour garantir une sortie texte stable et parsable.
 */
export async function runPytest(
  repoDir: string,
  image: string,
  tests: string[],
  timeout: number,
): Promise<string> {
  const args = await pytestArgsFor(repoDir, tests);
  try {
    const { stdout } = await exec("docker", ["run", "--rm", "--platform", "linux/amd64",
      "-e", "FORCE_COLOR=0", "-e", "NO_COLOR=1",
      "-v", `${repoDir}:/testbed`, "-w", "/testbed", image,
      "python", "-m", "pytest", ...args, "-rA", "-q", "-p", "no:cacheprovider", "--color=no"],
      { cwd: repoDir, timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout ?? "";
  }
}

/**
 * Détermine les arguments à passer à pytest.
 *
 * Le dataset officiel n'est PAS homogène sur les noms de tests :
 *  - la majorité des instances donnent des noms pleinement qualifiés
 *    (`pkg/tests/test_x.py::test_y[param]`) → on les passe tels quels ;
 *  - d'autres (sympy 1.5) donnent des noms « nus » (`test_imageset`) SANS
 *    fichier. pytest ne peut pas les résoudre depuis la racine : il répond
 *    « not found » et n'exécute rien. On les RÉSOUT donc en localisant le
 *    fichier de test qui définit `def <nom>(` — sans quoi l'instance serait
 *    faussement jugée « environnement cassé ».
 *
 * La résolution est fail-safe : un nom introuvable est conservé tel quel
 * (l'instance sera marquée non-résoluble, jamais un faux « prêt »).
 */
export async function pytestArgsFor(repoDir: string, tests: string[]): Promise<string[]> {
  const bare = tests.filter(t => !t.includes("::") && !t.includes("/"));
  if (bare.length === 0) return tests;

  const resolved = new Map<string, string>();
  // `git grep` est disponible dans tous les dépôts (et rapide, indexé).
  for (const name of bare) {
    const file = await locateTestFile(repoDir, name);
    if (file) resolved.set(name, `${file}::${name}`);
  }
  return tests.map(t => resolved.get(t) ?? t);
}

/** Localise le fichier qui définit `def <testName>(` dans le dépôt. */
async function locateTestFile(repoDir: string, testName: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["grep", "-l", "-E", `^def ${testName}\\(`, "--", "*/tests/*"],
      { cwd: repoDir, maxBuffer: 8 * 1024 * 1024 },
    );
    const first = stdout.split("\n").map(l => l.trim()).filter(Boolean)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** Relit le Dockerfile d'une instance déjà préparée (diagnostic). */
export async function readPreparedDockerfile(root: string, instanceId: string): Promise<string> {
  return readFile(join(root, instanceId, "Dockerfile"), "utf8");
}
