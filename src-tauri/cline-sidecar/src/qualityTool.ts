/**
 * Mira — Outil CUSTOM de CONTRÔLE QUALITÉ (sidecar Cline).
 *
 * RÔLE
 * ----
 * Donner à l'agent un moyen de DÉCOUVRIR les vérifications réelles d'un projet
 * (typecheck, tests, lint, build) sans deviner. Sur un dépôt qu'il ne connaît
 * pas, l'agent ignore s'il doit lancer `npm test`, `pytest`, `cargo test` ou
 * `go test ./...` ; sans cette information il saute la vérification (et déclare
 * un succès non prouvé) ou invente une commande qui échoue.
 *
 * POURQUOI UN OUTIL DE DÉTECTION, PAS D'EXÉCUTION
 * -----------------------------------------------
 * Le SDK Cline expose DÉJÀ `run_commands`, qui exécute le shell. Réimplémenter
 * l'exécution ici créerait un second chemin d'exécution (surface d'attaque,
 * politiques d'approbation divergentes, sorties non alignées). On ne fait donc
 * QU'UNE chose : LIRE les manifestes du projet et en DÉDUIRE les commandes de
 * vérification. Le modèle appelle ensuite `run_commands` avec la commande
 * retournée — un seul chemin d'exécution, une seule politique.
 *
 * SÉCURITÉ
 * --------
 *   - **Lecture seule** : l'outil ne fait que `read_file` sur une liste FIGÉE
 *     de manifestes (aucun nom de fichier choisi par le modèle). Auto-approuvé.
 *   - **Chemins FIGÉS** : le modèle ne passe AUCUN chemin ; la liste des
 *     manifestes est constante dans ce module. Rien à injecter.
 *   - **Workspace FIGÉ** : `read_file` est borné au workspace par le Rust
 *     (`assert_in_workspace`) — un manifeste qui pointerait ailleurs échoue.
 *   - **Aucune exécution** : la sortie est du TEXTE (commandes suggérées), pas
 *     un effet de bord. Le modèle reste maître de lancer ou non.
 *   - **Entrées bornées** : contenus de manifestes plafonnés avant parsing pour
 *     qu'un fichier énorme ne sature pas la mémoire du sidecar.
 */

import { createTool } from "@cline/core";
import { z } from "zod";

/** Pont vers les commandes Tauri (cf. `projectTools.OriginInvoke`). */
export type OriginInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Manifeste candidat : nom de fichier FIGÉ et écosystème associé. On tente de
 * les lire un par un ; un manifeste absent est simplement ignoré.
 */
const MANIFEST_CANDIDATES: ReadonlyArray<{ file: string; kind: ProjectKind }> = [
  { file: "package.json", kind: "node" },
  { file: "Cargo.toml", kind: "rust" },
  { file: "pyproject.toml", kind: "python" },
  { file: "requirements.txt", kind: "python" },
  { file: "go.mod", kind: "go" },
];

type ProjectKind = "node" | "rust" | "python" | "go";

/** Taille maximale d'un manifeste qu'on accepte de parser. */
const MAX_MANIFEST_BYTES = 200_000;

/** Une vérification détectée : un rôle, une commande, sa provenance. */
interface DetectedCheck {
  /** Rôle normalisé de la vérification. */
  role: "typecheck" | "test" | "lint" | "build";
  /** Commande shell suggérée (à lancer via `run_commands`). */
  command: string;
  /** D'où vient la détection (fichier + champ), pour la transparence. */
  source: string;
}

/** Lit un manifeste via le pont Tauri ; renvoie `null` s'il est absent/illisible. */
async function readManifest(
  originInvoke: OriginInvoke,
  workspace: string,
  file: string,
): Promise<string | null> {
  try {
    const raw = await originInvoke("read_file", {
      path: `${workspace.replace(/[\\/]+$/, "")}/${file}`,
      workspaceRoot: workspace,
    });
    if (typeof raw !== "string" || raw.length === 0) return null;
    return raw.slice(0, MAX_MANIFEST_BYTES);
  } catch {
    // Fichier absent ou hors workspace : ce n'est pas une erreur, juste un
    // manifeste candidat qui ne s'applique pas à ce projet.
    return null;
  }
}

/** Parse un `package.json` et en déduit les vérifications Node. */
function checksFromNode(raw: string, checks: DetectedCheck[]): void {
  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }
  const scripts = pkg.scripts ?? {};
  // Priorité aux scripts DÉCLARÉS : ce que le projet définit est la vérité.
  if (typeof scripts.typecheck === "string") {
    checks.push({ role: "typecheck", command: "npm run typecheck", source: "package.json › scripts.typecheck" });
  } else if (typeof scripts["type-check"] === "string") {
    checks.push({ role: "typecheck", command: "npm run type-check", source: "package.json › scripts.type-check" });
  } else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
    // Pas de script dédié mais TypeScript est présent : on suggère la commande
    // standard. `--noEmit` évite d'écrire des fichiers de sortie.
    checks.push({ role: "typecheck", command: "npx tsc --noEmit", source: "package.json › typescript dependency" });
  }
  if (typeof scripts.test === "string" && !scripts.test.includes("no test specified")) {
    checks.push({ role: "test", command: "npm test", source: "package.json › scripts.test" });
  }
  if (typeof scripts.lint === "string") {
    checks.push({ role: "lint", command: "npm run lint", source: "package.json › scripts.lint" });
  }
  if (typeof scripts.build === "string") {
    checks.push({ role: "build", command: "npm run build", source: "package.json › scripts.build" });
  }
}

/** Parse un `Cargo.toml` : Rust a des commandes canoniques stables. */
function checksFromRust(raw: string, checks: DetectedCheck[]): void {
  // On ne fait PAS un vrai parse TOML : les commandes Rust (`cargo check/test/
  // clippy`) sont canoniques dès qu'un `Cargo.toml` existe. Le contenu ne sert
  // qu'à confirmer la présence d'un crate.
  if (!/\[package\]|\[workspace\]/.test(raw)) return;
  checks.push({ role: "typecheck", command: "cargo check", source: "Cargo.toml" });
  checks.push({ role: "test", command: "cargo test", source: "Cargo.toml" });
}

/** Parse un `pyproject.toml` / `requirements.txt` : détecte l'outillage Python. */
function checksFromPython(raw: string, checks: DetectedCheck[]): void {
  if (/\bpytest\b/.test(raw)) {
    checks.push({ role: "test", command: "pytest", source: "pytest detected" });
  }
  if (/\bruff\b/.test(raw)) {
    checks.push({ role: "lint", command: "ruff check", source: "ruff detected" });
  }
  if (/\bmypy\b/.test(raw)) {
    checks.push({ role: "typecheck", command: "mypy .", source: "mypy detected" });
  }
}

/** Un `go.mod` implique les commandes Go canoniques. */
function checksFromGo(checks: DetectedCheck[]): void {
  checks.push({ role: "build", command: "go build ./...", source: "go.mod" });
  checks.push({ role: "test", command: "go test ./...", source: "go.mod" });
}

/**
 * Construit l'outil de détection des vérifications pour une session.
 *
 * @param workspace racine du workspace (chemin absolu, FIGÉ à la construction).
 * @param originInvoke pont vers les commandes Tauri (voir `OriginInvoke`).
 */
export function buildQualityTools(workspace: string, originInvoke: OriginInvoke) {
  const detectChecks = createTool({
    name: "detect_checks",
    description:
      "Detect the project's own verification commands (typecheck, tests, lint, build) " +
      "from its manifests (package.json, Cargo.toml, pyproject.toml, go.mod). Returns " +
      "ready-to-run commands with their source. Call this to learn HOW to verify your " +
      "work, then run the relevant command with `run_commands`. Read-only.",
    inputSchema: z.object({}),
    lifecycle: { completesRun: false },
    async execute() {
      try {
        const checks: DetectedCheck[] = [];
        const found: string[] = [];
        const seen = new Set<ProjectKind>();

        for (const candidate of MANIFEST_CANDIDATES) {
          const raw = await readManifest(originInvoke, workspace, candidate.file);
          if (raw === null) continue;
          found.push(candidate.file);
          // On ne traite chaque écosystème qu'UNE fois (ex. pyproject + requirements).
          const firstOfKind = !seen.has(candidate.kind);
          switch (candidate.kind) {
            case "node":
              if (firstOfKind) checksFromNode(raw, checks);
              break;
            case "rust":
              if (firstOfKind) checksFromRust(raw, checks);
              break;
            case "python":
              // Python : pyproject ET requirements peuvent chacun révéler un outil.
              checksFromPython(raw, checks);
              break;
            case "go":
              if (firstOfKind) checksFromGo(checks);
              break;
          }
          seen.add(candidate.kind);
        }

        if (found.length === 0) {
          return {
            output:
              "No project manifest found (package.json, Cargo.toml, pyproject.toml, go.mod). " +
              "Determine the verification commands from the project layout yourself.",
            isError: false,
          };
        }

        // Dédoublonnage par commande (pyproject + requirements peuvent redire la même).
        const unique: DetectedCheck[] = [];
        const seenCmd = new Set<string>();
        for (const c of checks) {
          if (seenCmd.has(c.command)) continue;
          seenCmd.add(c.command);
          unique.push(c);
        }

        const header = `Manifests found: ${found.join(", ")}`;
        if (unique.length === 0) {
          return {
            output: `${header}\nNo standard verification command could be inferred. Inspect the manifest to find the right command.`,
            isError: false,
          };
        }
        // Regroupement par rôle, dans l'ordre de vérification logique.
        const order: DetectedCheck["role"][] = ["typecheck", "build", "test", "lint"];
        const lines: string[] = [];
        for (const role of order) {
          const group = unique.filter((c) => c.role === role);
          if (group.length === 0) continue;
          lines.push(`${role}:`);
          for (const c of group) lines.push(`  - \`${c.command}\`  (${c.source})`);
        }
        return {
          output: `${header}\nRun the relevant one with \`run_commands\` before declaring the task done:\n${lines.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `detect_checks failed: ${message}`, isError: true };
      }
    },
  });

  return [detectChecks];
}
