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
  /**
   * L'action à appliquer, résolue par l'UI (pas d'effet ici).
   * - `set-mode` : bascule de mode côté UI.
   * - `insert`   : insère le texte (ex. `/skill `) dans l'input sans envoyer.
   * - `noop`     : commande purement informative (documentation).
   */
  action: { kind: "set-mode"; mode: Mode } | { kind: "insert"; text: string } | { kind: "noop" };
  /** Origine de la commande : intégrée ou fournie par le runtime Cline. */
  source?: "builtin" | "runtime";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "agent", label: "Agent", description: "Reads, edits and runs tools", action: { kind: "set-mode", mode: "agent" }, source: "builtin" },
  { name: "plan",  label: "Plan",  description: "Read-only, proposes a plan",  action: { kind: "set-mode", mode: "plan" },  source: "builtin" },
  { name: "ask",   label: "Chat",  description: "Answers about the code",      action: { kind: "set-mode", mode: "ask" },   source: "builtin" },
  { name: "chat",  label: "Chat",  description: "Alias de /ask",               action: { kind: "set-mode", mode: "ask" },   source: "builtin" },
  { name: "skill", label: "Skill", description: "Charge une skill (skills du projet)", action: { kind: "insert", text: "/skill " }, source: "builtin" },
] as const;

/** Forme minimale d'une commande runtime telle que renvoyée par le sidecar. */
export interface RuntimeCommandLike {
  id: string;
  name: string;
  description?: string;
  kind: "skill" | "workflow";
}

/**
 * Fusionne les slash-commands intégrées avec celles RÉELLEMENT fournies par le
 * runtime Cline (`listRuntimeCommands()`). Les intégrées gardent la priorité en
 * cas de collision de nom ; les commandes runtime sont préfixées par `/` et
 * insérées dans l'input (l'expansion réelle est faite côté SDK).
 */
export function mergeSlashCommands(runtime: RuntimeCommandLike[] = []): SlashCommand[] {
  const merged: SlashCommand[] = [...SLASH_COMMANDS];
  const seen = new Set(merged.map(c => c.name));
  for (const cmd of runtime) {
    const raw = (cmd.name || cmd.id || "").replace(/^\/+/, "").trim();
    if (!raw) continue;
    const name = raw.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push({
      name,
      label: cmd.name || raw,
      description: cmd.description ?? (cmd.kind === "workflow" ? "Workflow" : "Skill"),
      action: { kind: "insert", text: `/${raw} ` },
      source: "runtime",
    });
  }
  return merged;
}

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
 * `catalog` permet de prendre en compte les commandes runtime du SDK.
 */
export function parseSlashCommand(text: string, catalog: readonly SlashCommand[] = SLASH_COMMANDS): ParsedSlash {
  const match = text.match(/^\s*\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { command: null, rest: text };
  const name = match[1].toLowerCase().replace(/^\/+/, "");
  const rest = (match[2] ?? "").trim();
  const command = catalog.find(c => c.name === name) ?? null;
  return { command, rest };
}

/** Filtre le catalogue slash pour l'autocomplétion (query après le `/`). */
export function filterSlashCommands(query: string, catalog: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...catalog];
  return catalog.filter(c => c.name.startsWith(q));
}

/** Détecte la requête slash active : `/foo` en fin de texte → "foo", sinon null. */
export function getSlashQuery(text: string): string | null {
  const match = text.match(/(?:^|\s)\/(\S*)$/);
  return match ? match[1] : null;
}
