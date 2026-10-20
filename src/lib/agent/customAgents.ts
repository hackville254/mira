// Agents personnalisés (Settings › Agents + sélecteur de l'input).
//
// Un agent = un prompt de rôle + une sélection d'outils + une sélection de
// serveurs MCP. Il est **persisté globalement** (`~/.mira/agents`, côté Rust) :
// il reste disponible pour toutes les conversations et tous les projets.
//
// Ce module est la source de vérité côté front : listing, création/édition,
// suppression, et résolution de la sélection courante (quel agent est actif dans
// l'input). Le moteur reçoit ensuite le prompt + le filtre d'outils + les MCP.

import { invoke } from "@tauri-apps/api/core";

/** Événement émis à chaque changement de la liste d'agents ou de la sélection. */
export const CUSTOM_AGENTS_EVENT = "origin-custom-agents-changed";

/** Clé de la sélection courante dans l'input (`null`/absent = agent par défaut). */
const SELECTED_AGENT_KEY = "origin-ai-agent";

/**
 * Un agent personnalisé, tel que persisté. `id` est un slug stable
 * (`[A-Za-z0-9._-]`) qui sert de clé d'édition/suppression.
 *
 * Sécurité : `prompt` est du texte inerte injecté dans le prompt système
 * (jamais exécuté) ; `tools`/`mcp` sont des listes d'identifiants ré-interprétés
 * côté front — une valeur inconnue est ignorée, jamais résolue en chemin ou
 * commande.
 */
export interface CustomAgent {
  id: string;
  name: string;
  prompt: string;
  /** Ids d'outils activés (cf. `agentToolPrefs.AGENT_TOOLS`). */
  tools: string[];
  /** Noms de serveurs MCP activés (clés de `mcpServers`). */
  mcp: string[];
  avatar?: string | null;
  createdAt: number;
}

/** Forme brute renvoyée par le backend Rust (snake_case). */
interface RawAgent {
  id: string;
  name: string;
  prompt?: string;
  tools?: string[];
  mcp?: string[];
  avatar?: string | null;
  created_at?: number;
}

function fromRaw(raw: RawAgent): CustomAgent {
  return {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt ?? "",
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    mcp: Array.isArray(raw.mcp) ? raw.mcp : [],
    avatar: raw.avatar ?? null,
    createdAt: raw.created_at ?? 0,
  };
}

/**
 * Slugifie un nom saisi par l'utilisateur en identifiant sûr `[A-Za-z0-9._-]`.
 * On minuscule, on remplace tout le reste par `-`, on borne à 64 caractères et
 * on évite un `-` initial (ambiguïté d'option côté Rust).
 */
export function slugifyAgentId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+/g, "-")
    .replace(/[-._]+$/, "")
    .slice(0, 64);
  return slug;
}

/** Liste tous les agents personnalisés (du plus ancien au plus récent). */
export async function listAgents(): Promise<CustomAgent[]> {
  try {
    const raw = await invoke<RawAgent[]>("list_agents");
    return Array.isArray(raw) ? raw.map(fromRaw) : [];
  } catch {
    // Backend indisponible (tests/navigateur) : pas d'agents, on ne casse rien.
    return [];
  }
}

/**
 * Crée ou remplace un agent. Si `id` est vide, un identifiant est dérivé du nom
 * (suffixé en cas de collision avec un agent existant). Renvoie l'agent écrit.
 */
export async function saveAgent(input: {
  id?: string;
  name: string;
  prompt: string;
  tools: string[];
  mcp: string[];
  avatar?: string | null;
}): Promise<CustomAgent> {
  const name = input.name.trim();
  if (!name) throw new Error("Agent name is required.");

  let id = input.id?.trim() || slugifyAgentId(name);
  if (!id) throw new Error("Agent name must contain at least one letter or digit.");

  // Anti-collision : si on crée (pas d'id fourni) et que l'id existe déjà, on
  // suffixe. Une édition (id fourni) garde son id.
  if (!input.id) {
    const existing = new Set((await listAgents()).map(a => a.id));
    let candidate = id;
    let n = 2;
    while (existing.has(candidate)) {
      candidate = `${id}-${n++}`;
    }
    id = candidate;
  }

  const raw = await invoke<RawAgent>("write_agent", {
    agent: {
      id,
      name,
      prompt: input.prompt,
      tools: input.tools,
      mcp: input.mcp,
      avatar: input.avatar ?? null,
      created_at: 0, // le backend conserve/pose l'horodatage
    },
  });
  notifyAgentsChanged();
  return fromRaw(raw);
}

/** Supprime un agent. S'il était sélectionné, la sélection est réinitialisée. */
export async function deleteAgent(id: string): Promise<void> {
  await invoke("delete_agent", { id });
  if (readSelectedAgentId() === id) setSelectedAgentId(null);
  notifyAgentsChanged();
}

// ─── Sélection courante (quel agent est actif dans l'input) ────────────────────

/** Vrai si une valeur est un identifiant d'agent plausible. */
function isPlausibleAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id);
}

/** Id de l'agent sélectionné dans l'input, ou `null`. */
export function readSelectedAgentId(): string | null {
  try {
    const v = localStorage.getItem(SELECTED_AGENT_KEY);
    return isPlausibleAgentId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persiste l'agent sélectionné (`null` = aucun / agent par défaut). */
export function setSelectedAgentId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(SELECTED_AGENT_KEY);
    else localStorage.setItem(SELECTED_AGENT_KEY, id);
    window.dispatchEvent(new CustomEvent(CUSTOM_AGENTS_EVENT));
  } catch {
    /* stockage indisponible */
  }
}

/** Notifie les composants (liste agents ou sélection) d'un changement. */
export function notifyAgentsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(CUSTOM_AGENTS_EVENT));
  } catch {
    /* pas de window */
  }
}

/**
 * Résout l'agent sélectionné à partir d'une liste déjà chargée. Renvoie `null`
 * si aucun n'est sélectionné ou si l'id ne correspond plus (agent supprimé).
 */
export function resolveSelectedAgent(
  agents: CustomAgent[],
  selectedId: string | null,
): CustomAgent | null {
  if (!selectedId) return null;
  return agents.find(a => a.id === selectedId) ?? null;
}
