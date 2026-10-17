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

import { resolve } from "node:path";

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
 * Compose la liste de dossiers à passer au SDK : nos dossiers `.mira` d'abord,
 * puis les chemins par défaut officiels (qui couvrent `.cline`, `.claude`, …).
 *
 * ⚠️ `directories` **REMPLACE** les défauts du SDK (opérateur `??`) au lieu de
 * les compléter : on DOIT donc réinjecter explicitement les défauts via le
 * helper officiel `resolveSkillsConfigSearchPaths(workspace)`, sinon Mira perdrait
 * la découverte des skills/plugins existants.
 */
function withMiraDirectories(workspace: string): string[] {
  const mira = MIRA_PROJECT_DIRS.map((rel) => resolve(workspace, rel));
  // Défauts officiels (chemins projet + globaux) — réinjectés pour ne rien perdre.
  const sdkDefaults = resolveSkillsConfigSearchPaths(workspace);
  return [...mira, ...sdkDefaults];
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

  // ── 4. MCP ───────────────────────────────────────────────────────────────
  // Le fichier de réglages MCP vit sous le `CLINE_DIR` d'Origin (imposé par
  // Rust). On le laisse résoudre par le SDK, puis on enregistre chaque serveur
  // et on convertit leurs outils. Un serveur injoignable n'invalide PAS les
  // autres : `registerMcpServersFromSettingsFile` est tolérant par entrée.
  let mcpTools: AgentTool[] = [];
  let mcpManager: McpManager | null = null;
  try {
    const settingsPath = resolveDefaultMcpSettingsPath();
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

  return { userInstructionService, pluginPaths, hooks, mcpTools, mcpManager, issues };
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
