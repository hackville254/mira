import { useSyncExternalStore } from "react";

// ── Terminal de l'agent (miroir lecture seule) ────────────────────────────────
//
// Pendant un tour, l'agent exécute des commandes (`run_commands`) via le moteur
// Cline. Jusqu'ici l'utilisateur ne voyait que la carte de tool-call dans le
// chat, avec la sortie figée à la fin. On veut — parité SOLO — montrer ce que
// l'agent exécute DANS un vrai terminal, en DIRECT, pendant que ça tourne.
//
// Ce store est ce « terminal agent » :
//   - il accumule, PAR SESSION, un transcript texte (ANSI conservé) que l'onglet
//     « Agent » du panneau bas affiche tel quel dans un xterm ;
//   - l'utilisateur NE PEUT PAS y écrire : seul le flux de l'agent l'alimente.
//     La contrainte est structurelle (le store n'expose aucune méthode d'écriture
//     « clavier »), pas seulement visuelle.
//
// MULTITASKING : clé par session de chat, comme `swarmStore`/`runState`. Un run
// qui continue en arrière-plan continue d'alimenter SON terminal ; l'onglet suit
// la session affichée.
//
// Contrat de snapshot : une instance `AgentTerminalSnapshot` n'est remplacée que
// lorsque le contenu change réellement, sinon `useSyncExternalStore` boucle.

export interface AgentCommand {
  /** Commande shell telle que demandée par l'agent. */
  command: string;
  /** Horodatage de début (ms epoch). */
  startedAt: number;
  /** `undefined` tant que la commande tourne ; sinon code de sortie. */
  exitCode?: number;
  /** `true` si la commande a fini (avec succès ou non). */
  done: boolean;
}

export interface AgentTerminalSnapshot {
  /** Transcript ANSI complet, tel qu'à écrire dans le xterm. */
  transcript: string;
  /** Commandes exécutées dans cette session, dans l'ordre. */
  commands: AgentCommand[];
  /** Une commande est-elle en cours ? (pilote le spinner / badge « live ») */
  running: boolean;
}

const EMPTY: AgentTerminalSnapshot = { transcript: "", commands: [], running: false };

/** Plafond du transcript conservé en mémoire (anti-croissance illimitée). */
const MAX_TRANSCRIPT_CHARS = 200_000;
const TRUNCATION_NOTICE = "\r\n\x1b[90m… [sortie tronquée]\x1b[0m\r\n";

/** Registre : sessionId → état mutable interne. */
interface Internal {
  transcript: string;
  commands: AgentCommand[];
  running: boolean;
  /** Référence stable exposée tant que rien ne change. */
  snapshot: AgentTerminalSnapshot;
}
const registry = new Map<string, Internal>();
const listeners = new Set<() => void>();

/** Clé utilisée quand l'appelant n'a pas de session (rétrocompat). */
export const GLOBAL_TERMINAL_KEY = "__global__";

function emit(): void {
  for (const cb of listeners) cb();
}

function bucket(sessionKey: string): Internal {
  let b = registry.get(sessionKey);
  if (!b) {
    b = { transcript: "", commands: [], running: false, snapshot: EMPTY };
    registry.set(sessionKey, b);
  }
  return b;
}

/** Recalcule le snapshot stable d'un bucket (nouvelle référence si modifié). */
function refresh(b: Internal): void {
  b.snapshot = {
    transcript: b.transcript,
    commands: b.commands,
    running: b.running,
  };
}

/**
 * Ajoute une commande au terminal d'une session et marque le flux « en cours ».
 * Émet l'en-tête de la commande (avec un préfixe `$`) dans le transcript, pour
 * que l'onglet se lise comme un vrai shell.
 */
export function agentTerminalCommandStart(sessionKey: string, command: string): void {
  const b = bucket(sessionKey);
  b.commands = [...b.commands, { command, startedAt: Date.now(), done: false }];
  b.running = true;
  b.transcript += `${b.transcript ? "\r\n" : ""}\x1b[1;36m$\x1b[0m ${command}\r\n`;
  trim(b);
  refresh(b);
  emit();
}

/**
 * Ajoute un morceau de sortie (stdout/stderr) au terminal d'une session.
 * Le contenu est déjà de l'ANSI brut : on l'écrit tel quel (`\r\n` normalisés
 * côté émetteur si nécessaire).
 */
export function agentTerminalOutput(sessionKey: string, chunk: string): void {
  if (!chunk) return;
  const b = bucket(sessionKey);
  b.transcript += chunk;
  trim(b);
  refresh(b);
  emit();
}

/**
 * Clôt la commande en cours avec son code de sortie. Affiche un marqueur de fin
 * discret coloré (vert si 0, rouge sinon), comme un prompt qui revient.
 */
export function agentTerminalCommandEnd(sessionKey: string, exitCode: number): void {
  const b = bucket(sessionKey);
  const idx = b.commands.length - 1;
  if (idx >= 0 && !b.commands[idx].done) {
    b.commands = b.commands.map((c, i) =>
      i === idx ? { ...c, exitCode, done: true } : c,
    );
  }
  b.running = false;
  const ok = exitCode === 0;
  b.transcript += ok
    ? "\x1b[90m[terminé]\x1b[0m\r\n"
    : `\x1b[31m[code de sortie ${exitCode}]\x1b[0m\r\n`;
  trim(b);
  refresh(b);
  emit();
}

/** Vide le terminal d'une session (appelé à la fin d'un tour, ou manuellement). */
export function clearAgentTerminal(sessionKey: string): void {
  const b = bucket(sessionKey);
  b.transcript = "";
  b.commands = [];
  b.running = false;
  refresh(b);
  emit();
}

/** Purge complètement une session (fin de vie de la conversation). */
export function forgetAgentTerminal(sessionKey: string): void {
  if (registry.delete(sessionKey)) emit();
}

function trim(b: Internal): void {
  if (b.transcript.length <= MAX_TRANSCRIPT_CHARS) return;
  // On garde la fin (la plus récente) et on signale la coupe par un préavis.
  b.transcript = TRUNCATION_NOTICE + b.transcript.slice(-MAX_TRANSCRIPT_CHARS);
}

/** Snapshot du terminal d'une session (référence stable tant que rien ne change). */
export function getAgentTerminal(sessionKey: string): AgentTerminalSnapshot {
  return registry.get(sessionKey)?.snapshot ?? EMPTY;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Hook React : lit le terminal de la session donnée en s'y abonnant. */
export function useAgentTerminal(sessionKey: string): AgentTerminalSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => getAgentTerminal(sessionKey),
    () => EMPTY,
  );
}
