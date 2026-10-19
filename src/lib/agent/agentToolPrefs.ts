// Préférences de la section Agent (Settings › Agent).
//
// Liste des outils d'agent activables/désactivables, façon Trae. Les outils
// DÉSACTIVÉS sont réellement retirés du contrat système injecté au modèle
// (voir lib/agent/prompts.ts › buildSystemPrompt) : le modèle n'en entend donc
// plus parler et ne les appelle plus. Chaque outil est activé par défaut.

export const AGENT_TOOLS_EVENT = "origin-agent-tools-changed";

const STORAGE_KEY = "origin-agent-disabled-tools";

/**
 * Catalogue des outils exposés, groupés par famille. `id` est l'identifiant
 * stable persisté ; `label`/`description` alimentent l'UI ; `prompt` liste les
 * puces du contrat système à retirer quand l'outil est désactivé.
 *
 * Les outils NON désactivables (todo_*, ask_question, skills) sont volontairement
 * absents : ce sont des mécanismes du protocole d'agent, pas des capacités
 * optionnelles (les couper casserait la boucle de l'agent).
 */
export interface AgentToolDef {
  id: string;
  label: string;
  description: string;
  /** Préfixes d'outils réels concernés (pour le contrat et l'affichage). */
  tools: string[];
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    id: "read_files",
    label: "Read files",
    description: "Read one or more files from the workspace.",
    tools: ["read_files"],
  },
  {
    id: "search_codebase",
    label: "Search codebase",
    description: "Search the workspace by pattern or meaning.",
    tools: ["search_codebase", "codebase_search"],
  },
  {
    id: "editor",
    label: "Edit files",
    description: "Create and edit files in the workspace.",
    tools: ["editor"],
  },
  {
    id: "run_commands",
    label: "Run commands",
    description: "Run shell commands (builds, tests, git, package managers).",
    tools: ["run_commands"],
  },
  {
    id: "fetch_web_content",
    label: "Fetch web content",
    description: "Fetch and read content from URLs.",
    tools: ["fetch_web_content"],
  },
  {
    id: "browser",
    label: "Browser control",
    description: "Drive the built-in browser to inspect and interact with web pages.",
    tools: ["browser_navigate", "browser_query", "browser_read_text", "browser_read_dom", "browser_click", "browser_type", "browser_press_key", "browser_screenshot", "browser_status", "browser_reload"],
  },
];

function readDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeDisabled(disabled: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabled]));
    window.dispatchEvent(new CustomEvent(AGENT_TOOLS_EVENT));
  } catch {
    /* stockage indisponible */
  }
}

/** Vrai si l'outil est ACTIVÉ (défaut). */
export function isToolEnabled(id: string): boolean {
  return !readDisabled().has(id);
}

export function setToolEnabled(id: string, enabled: boolean): void {
  const disabled = readDisabled();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writeDisabled(disabled);
}

/** Renvoie l'ensemble des ids désactivés (pour la section Agent). */
export function getDisabledTools(): Set<string> {
  return readDisabled();
}

/** Vrai si au moins un outil de la famille est activé. */
export function isFamilyEnabled(tools: string[]): boolean {
  const disabled = readDisabled();
  // Une famille est active tant qu'au moins un de ses outils l'est.
  for (const def of AGENT_TOOLS) {
    if (def.tools.some(t => tools.includes(t)) && !disabled.has(def.id)) return true;
  }
  return false;
}
