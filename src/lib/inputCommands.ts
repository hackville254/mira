/**
 * Logique *pure* de l'input du ChatBox : modes d'agent, parsing des
 * slash-commands (`/plan …`), et catalogue des commandes / skills.
 *
 * But : sortir cette logique du composant React pour la rendre testable en
 * environnement `node` (pas de DOM), et éviter que `ChatBox` redevienne un
 * fourre-tout. Aucune dépendance React ici.
 */

// ── Modes d'agent ─────────────────────────────────────────────────────────────

export type Mode = "agent" | "ask" | "plan";

/** Identifiant de l'icône ; la résolution vers un composant reste côté UI. */
export type AgentIcon = "chat" | "agent" | "plan";

export interface AgentDescriptor {
  id: Mode;
  label: string;
  /** Libellé court de l'icône (mappé vers un composant lucide côté UI). */
  icon: AgentIcon;
  /** Texte d'aide affiché dans le menu. */
  hint: string;
}

/**
 * Agents intégrés. `plan` en fait partie : le menu de sélection doit exposer
 * les trois modes que le ChatBox sait réellement transmettre via `onSend`.
 * Auparavant `plan` manquait dans l'UI alors qu'il était supporté par `handleSend`.
 */
export const AGENTS: readonly AgentDescriptor[] = [
  { id: "agent", label: "Agent", icon: "agent", hint: "Reads, edits and runs tools" },
  { id: "plan",  label: "Plan",  icon: "plan",  hint: "Read-only, proposes a plan" },
  { id: "ask",   label: "Chat",  icon: "chat",  hint: "Answers questions about the code" },
] as const;

export function isMode(value: string): value is Mode {
  return value === "agent" || value === "ask" || value === "plan";
}

export function agentLabel(mode: Mode): string {
  return AGENTS.find(a => a.id === mode)?.label ?? "Agent";
}

// ── Persistance du mode ───────────────────────────────────────────────────────

export const MODE_STORAGE_KEY = "origin-ai-mode";

/** Lit le mode mémorisé, retombe sur `fallback` si absent ou invalide. */
export function readStoredMode(fallback: Mode = "agent"): Mode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    return raw && isMode(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** Mémorise le mode courant. Silencieux si le storage est indisponible. */
export function writeStoredMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* storage indisponible : on ignore, le mode courant reste en mémoire */
  }
}

// ── Slash-commands ────────────────────────────────────────────────────────────

export interface SlashCommand {
  /** Nom sans le `/` initial. */
  name: string;
  /** Libellé affiché. */
  label: string;
  /** Description courte. */
  description: string;
  /** L'action à appliquer, résolue par l'UI (pas d'effet ici). */
  action: { kind: "set-mode"; mode: Mode } | { kind: "noop" };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "agent", label: "Agent", description: "Reads, edits and runs tools", action: { kind: "set-mode", mode: "agent" } },
  { name: "plan",  label: "Plan",  description: "Read-only, proposes a plan",  action: { kind: "set-mode", mode: "plan" } },
  { name: "ask",   label: "Chat",  description: "Answers about the code",      action: { kind: "set-mode", mode: "ask" } },
  { name: "chat",  label: "Chat",  description: "Alias de /ask",               action: { kind: "set-mode", mode: "ask" } },
] as const;

export interface ParsedSlash {
  /** La commande reconnue, ou null si le nom est inconnu. */
  command: SlashCommand | null;
  /** Le texte restant après la commande (jamais undefined). */
  rest: string;
}

/**
 * Détecte un slash-command en *tête* de message.
 * Ne reconnaît que `/nom` en début (après espaces). `/foo` inconnu → `command: null`.
 * Un texte sans `/` initial → `command: null, rest: texte d'origine`.
 */
export function parseSlashCommand(text: string): ParsedSlash {
  const match = text.match(/^\s*\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { command: null, rest: text };
  const name = match[1].toLowerCase().replace(/^\/+/, "");
  const rest = (match[2] ?? "").trim();
  const command = SLASH_COMMANDS.find(c => c.name === name) ?? null;
  return { command, rest };
}

/** Filtre le catalogue slash pour l'autocomplétion (query après le `/`). */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(c => c.name.startsWith(q));
}

/** Détecte la requête slash active : `/foo` en fin de texte → "foo", sinon null. */
export function getSlashQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)\/(\S*)$/);
  return match ? match[1] : null;
}
