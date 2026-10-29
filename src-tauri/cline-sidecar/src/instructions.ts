/**
 * Mira — Câblage des EXTENSIONS de session Cline (Skills, Plugins, Hooks, MCP).
 *
 * RÔLE
 * ----
 * Le SDK Cline expose quatre surfaces d'extension qu'un hôte DOIT brancher
 * lui-même : il ne les active pas automatiquement en mode `local`.
 *
 *   1. **Skills / Rules / Workflows** (`userInstructionConfigService`) : lit les
 *      dossiers `.cline/skills`, `~/.cline/skills`, etc., et fournit au modèle
 *      l'outil `skills` (chargement à la demande) + les slash-commands `/skill`.
 *   2. **Plugins** (`pluginPaths` / `agentPluginPaths`) : paquets Agent Plugins
 *      v1 (outils + skills packagés).
 *   3. **Hooks** (`hooks`) : scripts déclenchés sur des événements d'agent
 *      (`agent_start`, `pre_tool_use`, …) lus depuis `.cline/hooks`.
 *   4. **MCP** (`extraTools` MCP) : serveurs Model Context Protocol déclarés
 *      dans `cline_mcp_settings.json`, exposés comme outils `mcp__<server>__<tool>`.
 *
 * POURQUOI UN MODULE DÉDIÉ
 * ------------------------
 * `index.ts` porte le protocole NDJSON et la boucle d'agent : il doit rester
 * lisible. Ici on isole la RÉSOLUTION des extensions (chemins, découverte,
 * filtrage d'erreurs), ce qui rend chaque partie testable indépendamment.
 *
 * SÉCURITÉ
 * --------
 *   - **Aucun chemin fourni par le front n'est exécuté** : les dossiers de
 *     recherche sont DÉDUITS du `cwd` de la session (déjà validé côté Rust) via
 *     les helpers OFFICIELS du SDK (`resolveSkillsConfigSearchPaths`,
 *     `resolvePluginConfigSearchPaths`). Le front ne peut donc pas pointer une
 *     extension vers un dossier arbitraire.
 *   - **Les outils MCP sont exposés tels quels au modèle** : ils ne sont PAS
 *     auto-approuvés (le joker `"*"` de `TOOL_POLICIES` s'applique), donc chaque
 *     appel MCP passe par la politique d'approbation d'Origin. Un serveur MCP
 *     compromis ne peut pas écrire en silence.
 *   - **Toute erreur d'extension est NON FATALE** : un skill mal formé ou un
 *     serveur MCP injoignable ne doit jamais empêcher la session de démarrer. On
 *     collecte les problèmes et on les remonte à l'UI (`pluginIssues`).
 */

import { readFile, readdir, mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  InMemoryMcpManager,
  createDefaultMcpServerClientFactory,
  createHookConfigFileHooks,
  createMcpTools,
  createUserInstructionConfigService,
  resolveDefaultMcpSettingsPath,
  resolvePluginConfigSearchPaths,
  resolveSkillsConfigSearchPaths,
  registerMcpServersFromSettingsFile,
  type AgentHooks,
  type AgentTool,
  type McpManager,
  type UserInstructionConfigService,
} from "@cline/core";
import { neutralizeForClient } from "./brand";

/** Extensions résolues pour une session, prêtes à être injectées dans `start`. */
export interface SessionExtensions {
  /**
   * Service d'instructions utilisateur (skills/rules/workflows). À passer dans
   * `localRuntime.userInstructionService` : il fournit l'outil `skills` et
   * l'expansion des slash-commands.
   */
  userInstructionService: UserInstructionConfigService;
  /** Dossiers de plugins Cline (`pluginPaths` de la config de session). */
  pluginPaths: string[];
  /**
   * Hooks d'agent lus depuis `.cline/hooks` (scripts déclenchés sur
   * `TaskStart`, `PreToolUse`, …). `undefined` si aucun n'est configuré : on
   * évite alors d'enregistrer une extension sans effet.
   */
  hooks: AgentHooks | undefined;
  /**
   * Outils MCP (`mcp__<server>__<tool>`), à concaténer aux outils de session.
   * Vides si aucun serveur n'est configuré ou joignable.
   */
  mcpTools: AgentTool[];
  /** Gestionnaire MCP à conserver pour `dispose` en fin de session/process. */
  mcpManager: McpManager | null;
  /** Problèmes NON FATALS collectés (skills illisibles, MCP en échec…). */
  issues: ExtensionIssue[];
  /**
   * Slash-commands PERSONNALISÉES définies par l'utilisateur dans
   * `.mira/commands/*.md`. Le SDK Cline n'a pas de surface « commands » : c'est
   * une convention d'hôte propre à Mira (comme Trae). On les fusionne côté front
   * avec les commands dérivées des skills/workflows.
   */
  customCommands: CustomCommand[];
}

/** Slash-command utilisateur (`.mira/commands/<nom>.md`). */
export interface CustomCommand {
  /** Identifiant stable = nom sans extension (slug). */
  id: string;
  /** Nom exposé, sans le `/` initial. */
  name: string;
  /** Description courte (frontmatter `description`, sinon 1re ligne non vide). */
  description: string;
  /** Corps du prompt : ce qui est envoyé au modèle quand on invoque `/name`. */
  instructions: string;
}

export interface ExtensionIssue {
  /** Surface concernée, pour que l'UI classe proprement. */
  scope: "skills" | "plugins" | "mcp" | "hooks";
  /** Message lisible (jamais un secret : on ne recopie que des messages d'erreur). */
  message: string;
}

/** Nom du dossier de plugins Cline, utilisé pour ne PAS dupliquer la recherche. */
const CLINE_PLUGINS_FOLDER = "plugins";

/**
 * Dossiers `.mira` **projet** à ajouter à la découverte des instructions
 * utilisateur (skills/rules/workflows).
 *
 * Règle produit : Mira est notre marque, `.mira/` doit être reconnu au même titre
 * que les dossiers historiques du SDK. On les place EN TÊTE (priorité au plus
 * spécifique au projet).
 */
const MIRA_PROJECT_DIRS = [".mira/skills", ".mira/rules", ".mira/workflows"] as const;

/**
 * Sous-dossiers `.mira` **globaux** (sous `~/.mira`) à ajouter à la découverte.
 *
 * POURQUOI : les skills LIVRÉS avec l'app (HyperFrames, media-use, InsForge,
 * copywriting…) sont installés dans `~/.mira/skills` par le natif au démarrage.
 * Or `resolveSkillsConfigSearchPaths` ne connaît QUE `.cline` / `.claude` /
 * `.agents` — il ignore complètement `.mira`. Sans ces lignes, les skills par
 * défaut seraient visibles dans Réglages (qui lit `.mira`) mais JAMAIS proposés
 * au modèle : l'outil `skills` resterait vide pour eux. On aligne donc la
 * découverte du moteur sur notre marque.
 *
 * SÉCURITÉ : `homedir()` est fourni par Node (variable d'environnement de l'OS),
 * jamais par le front ; on ne fait qu'ajouter un chemin fixe sous le HOME.
 */
const MIRA_GLOBAL_DIRS = [".mira/skills", ".mira/rules", ".mira/workflows"] as const;

/**
 * Sous-dossier projet des slash-commands personnalisées (`<ws>/.mira/commands`).
 *
 * Le SDK ne connaît PAS de surface « commands » : on charge donc nous-mêmes ces
 * fichiers Markdown et on les expose au front comme commandes invocables. On ne
 * touche PAS au service d'instructions : une commande n'est PAS un skill, le
 * modèle ne doit pas la voir dans l'outil `skills`.
 */
const MIRA_COMMANDS_DIR = ".mira/commands";

/**
 * Compose la liste de dossiers à passer au SDK : nos dossiers `.mira` d'abord,
 * puis les chemins par défaut officiels (qui couvrent `.cline`, `.claude`, …).
 *
 * ⚠️ `directories` **REMPLACE** les défauts du SDK (opérateur `??`) au lieu de
 * les compléter : on DOIT donc réinjecter explicitement les défauts via le
 * helper officiel `resolveSkillsConfigSearchPaths(workspace)`, sinon Mira perdrait
 * la découverte des skills/plugins existants.
 */
function withMiraDirectories(workspace: string): string[] {
  const miraProject = MIRA_PROJECT_DIRS.map((rel) => resolve(workspace, rel));
  // Skills/règles/workflows GLOBAUX de notre marque : `~/.mira/...`. C'est là que
  // le natif installe les skills par défaut, et `resolveSkillsConfigSearchPaths`
  // ne les connaît pas (voir MIRA_GLOBAL_DIRS).
  const miraGlobal = MIRA_GLOBAL_DIRS.map((rel) => resolve(homedir(), rel));
  // Défauts officiels (chemins projet + globaux) — réinjectés pour ne rien perdre.
  const sdkDefaults = resolveSkillsConfigSearchPaths(workspace);
  return [...miraProject, ...miraGlobal, ...sdkDefaults];
}

/**
 * Résout TOUTES les extensions d'une session en une passe.
 *
 * Jamais bloquant pour le succès du démarrage : chaque bloc est encapsulé et
 * une erreur devient une `ExtensionIssue`. Le pire cas renvoie un service
 * d'instructions vide (aucun skill) et aucun outil MCP — la session reste
 * parfaitement utilisable.
 */
export async function resolveSessionExtensions(cwd: string): Promise<SessionExtensions> {
  const issues: ExtensionIssue[] = [];
  const workspace = resolve(cwd);

  // ── 1. Skills / rules / workflows ────────────────────────────────────────
  // On fournit EXPLICITEMENT `directories` (dossiers `.mira` projet + défauts
  // officiels du SDK) : sans ça, `.mira/` ne serait jamais découvert. On garde
  // aussi `workspacePath` pour que le runtime résolve correctement règles et
  // slash-commands relatifs au projet.
  let userInstructionService: UserInstructionConfigService;
  try {
    const directories = withMiraDirectories(workspace);
    userInstructionService = createUserInstructionConfigService({
      skills: { directories, workspacePath: workspace },
      rules: { directories, workspacePath: workspace },
      workflows: { directories, workspacePath: workspace },
    });
    // `start()` charge les fichiers et arme le watcher : sans lui, aucun skill
    // n'est visible du modèle (l'outil `skills` resterait vide).
    await userInstructionService.start();
  } catch (error) {
    issues.push({ scope: "skills", message: describe(error) });
    // Repli : un service vide, pour ne jamais casser le démarrage de session.
    userInstructionService = createUserInstructionConfigService({
      skills: { directories: [] },
      rules: { directories: [] },
      workflows: { directories: [] },
    });
  }

  // ── 2. Plugins (Agent Plugins v1) ────────────────────────────────────────
  // Les chemins viennent du SDK (jamais du front) : `.cline/plugins` du
  // workspace, puis les racines globales. On y AJOUTE `.mira/plugins` du projet
  // (notre marque) en tête. On ne les charge PAS ici : `start()` les résout à la
  // construction du runtime et renvoie ses diagnostics dans `pluginIssues` — on
  // évite ainsi un double chargement.
  let pluginPaths: string[] = [];
  try {
    const miraPlugins = resolve(workspace, ".mira", "plugins");
    pluginPaths = [
      miraPlugins,
      ...resolvePluginConfigSearchPaths(workspace).filter((p) =>
        p.includes(CLINE_PLUGINS_FOLDER),
      ),
    ];
  } catch (error) {
    issues.push({ scope: "plugins", message: describe(error) });
  }

  // ── 3. Hooks ─────────────────────────────────────────────────────────────
  // Les hooks sont des SCRIPTS locaux déclenchés par le SDK sur des événements
  // d'agent. Ils vivent dans `.cline/hooks` (projet) et `~/.cline/hooks`
  // (global). `createHookConfigFileHooks` NE permet PAS de dossiers personnalisés
  // (`cwd`/`workspacePath` seulement) : `.mira/hooks` n'est donc pas lu par le
  // SDK aujourd'hui. On s'appuie sur le chemin supporté ; un alias `.mira/hooks`
  // → `.cline/hooks` est un compromis à évaluer (voir ENGINEERING_LOG).
  let hooks: AgentHooks | undefined;
  try {
    hooks = createHookConfigFileHooks({ cwd: workspace, workspacePath: workspace });
  } catch (error) {
    issues.push({ scope: "hooks", message: describe(error) });
  }

  // ── 4. Slash-commands personnalisées (`.mira/commands/*.md`) ─────────────
  // Le SDK Cline n'expose AUCUNE surface « commands » (seuls skills et workflows
  // alimentent `listRuntimeCommands`). On charge donc nous-mêmes les fichiers
  // `.mira/commands/*.md` : ce sont des prompts réutilisables invoqués par
  // `/nom`. Jamais bloquant : un fichier illisible devient une issue.
  let customCommands: CustomCommand[] = [];
  try {
    customCommands = await loadCustomCommands(workspace);
  } catch (error) {
    issues.push({ scope: "skills", message: describe(error) });
  }

  // ── 5. MCP ───────────────────────────────────────────────────────────────
  // Le fichier de réglages MCP vit sous le `CLINE_DIR` d'Origin (imposé par
  // Rust). On le laisse résoudre par le SDK, puis on enregistre chaque serveur
  // et on convertit leurs outils. Un serveur injoignable n'invalide PAS les
  // autres : `registerMcpServersFromSettingsFile` est tolérant par entrée.
  let mcpTools: AgentTool[] = [];
  let mcpManager: McpManager | null = null;
  try {
    const settingsPath = resolveDefaultMcpSettingsPath();
    // Le SDK LIT ce fichier de façon non tolérante (ENOENT fatal sinon). Rust le
    // provisionne au démarrage, mais on garantit ici aussi un fichier vide valide
    // (défense en profondeur : sidecar lancé hors setup Tauri, dossier purgé…).
    // Idempotent : un fichier existant n'est jamais écrasé.
    await ensureMcpSettingsFile(settingsPath);
    mcpManager = new InMemoryMcpManager({
      clientFactory: createDefaultMcpServerClientFactory(),
    });
    const registrations = await registerMcpServersFromSettingsFile(mcpManager, {
      filePath: settingsPath,
    });
    for (const registration of registrations) {
      if (registration.disabled) continue;
      try {
        const tools = await createMcpTools({
          serverName: registration.name,
          provider: mcpManager,
          // Préfixe explicite : le modèle voit de quel serveur vient l'outil, et
          // deux serveurs exposant un même nom ne se masquent pas.
          nameTransform: ({ serverName, toolName }) => `mcp__${serverName}__${toolName}`,
        });
        mcpTools.push(...tools);
      } catch (error) {
        issues.push({ scope: "mcp", message: `${registration.name}: ${describe(error)}` });
      }
    }
  } catch (error) {
    issues.push({ scope: "mcp", message: describe(error) });
    mcpManager = null;
    mcpTools = [];
  }

  return { userInstructionService, pluginPaths, hooks, mcpTools, mcpManager, issues, customCommands };
}

/**
 * Garantit l'existence du fichier de réglages MCP, avec un contenu vide valide.
 *
 * Le SDK (`registerMcpServersFromSettingsFile`) LIT ce fichier sans tolérance à
 * l'absence : un fichier manquant lève `ENOENT` et fait échouer le démarrage de
 * la session (« erreur du moteur d'agent »). Rust provisionne déjà ce fichier au
 * démarrage de l'app ; ce garde-fou côté sidecar couvre les lancements hors
 * setup Tauri et un dossier `settings/` purgé. Idempotent : ne réécrit JAMAIS
 * un fichier existant (aucune perte de configuration utilisateur).
 */
async function ensureMcpSettingsFile(settingsPath: string): Promise<void> {
  try {
    await access(settingsPath);
    return; // déjà présent
  } catch {
    /* absent : on le crée ci-dessous */
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  try {
    // `wx` : n'écrase jamais un fichier apparu entre-temps (course avec le
    // provisioning Rust). EEXIST est un succès fonctionnel, on l'ignore.
    await writeFile(settingsPath, '{\n  "mcpServers": {}\n}\n', { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
}

/** Bornes de sécurité pour les commandes utilisateur (contenu hostile par défaut). */
const MAX_COMMAND_FILE_BYTES = 64 * 1024;
const MAX_COMMANDS = 200;

/**
 * Charge les slash-commands de `<workspace>/.mira/commands/*.md`.
 *
 * FORMAT : Markdown, frontmatter YAML optionnel.
 *
 * ```
 * ---
 * description: Relire la branche courante sans pousser
 * ---
 * Passe en revue les changements non commités et propose un plan.
 * ```
 *
 * SÉCURITÉ : on ne lit QUE des fichiers `.md` de premier niveau (jamais de
 * récursion, donc pas de symlink-chain), taille plafonnée, nombre plafonné. Le
 * contenu n'est jamais exécuté ni évalué : il est transmis au modèle comme
 * prompt, dans le même canal que ce que l'utilisateur tape lui-même.
 */
async function loadCustomCommands(workspace: string): Promise<CustomCommand[]> {
  const dir = resolve(workspace, MIRA_COMMANDS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Dossier absent = aucune commande : cas normal, pas une erreur.
    return [];
  }

  const commands: CustomCommand[] = [];
  for (const entry of entries.sort()) {
    if (commands.length >= MAX_COMMANDS) break;
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const name = entry.slice(0, -".md".length);
    if (!isSafeCommandName(name)) continue;
    const filePath = join(dir, basename(entry));
    try {
      const raw = await readFile(filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_COMMAND_FILE_BYTES) continue;
      const { description, body } = splitCommandFile(raw);
      commands.push({
        id: name,
        name,
        description: description || firstMeaningfulLine(body),
        instructions: body.trim(),
      });
    } catch {
      // Fichier illisible (permissions, course) : on l'ignore silencieusement,
      // une commande manquante ne doit jamais casser la session.
    }
  }
  return commands;
}

/** Un nom de commande reste un slug simple : `/` et espaces interdits. */
function isSafeCommandName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

/** Sépare un frontmatter `---` minimal du corps, et extrait `description`. */
function splitCommandFile(raw: string): { description: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { description: "", body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { description: "", body: normalized };
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1);
  const match = /^description:[ \t]*(.*)$/m.exec(frontmatter);
  const description = match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  return { description, body };
}

/** Première ligne non vide et non titrée, pour servir de description de repli. */
function firstMeaningfulLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const text = trimmed.replace(/^#+\s*/, "");
    if (text.length > 0) return text.slice(0, 140);
  }
  return "";
}

/** Normalise une erreur inconnue en message court (jamais un objet vivant). */
function describe(error: unknown): string {
  // On neutralise la marque interne : ces messages finissent dans `extensionIssues`
  // donc dans des toasts côté front (règle produit : jamais « cline » visible).
  return neutralizeForClient(rawDescribe(error));
}

/** Extraction brute du message, avant neutralisation. */
function rawDescribe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "erreur non sérialisable";
  }
}
