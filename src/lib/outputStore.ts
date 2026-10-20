/**
 * Buffer de sortie texte pour le panel « Output ».
 *
 * Les tâches « Run » émettent leur sortie via les events `terminal-output-{id}`
 * (déjà utilisés par xterm). On capture ici une copie découplée du terminal,
 * par « canal » nommé (ex: le nom de la tâche), afin d'afficher une console
 * propre dans le panel Output — sans dépendre du scrollback xterm.
 *
 * Implémentation : singleton en mémoire, capé, avec abonnés. Aucun état React
 * global : évite un re-render de l'app entière sur chaque ligne de log.
 */

export interface OutputLine {
  /** Canal (nom de tâche / onglet) auquel appartient la ligne. */
  channel: string;
  text: string;
  kind: 'stdout' | 'stderr' | 'system';
}

const MAX_LINES = 5_000;
const MAX_CHANNELS = 20;

// Map ordonnée (insertion) : canal → lignes. Un canal réutilisé repart à zéro.
const channels = new Map<string, OutputLine[]>();
const listeners = new Set<() => void>();
/** Compteur de version : permet un `useSyncExternalStore` stable. */
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

/** Ajoute une ligne de sortie dans un canal (tronquée du `\r` terminal). */
export function appendOutput(channel: string, text: string, kind: OutputLine['kind'] = 'stdout') {
  if (!text) return;
  const clean = text.replace(/\r\n?/g, '\n');
  let lines = channels.get(channel);
  if (!lines) {
    // Nouveau canal : évince le plus ancien si on dépasse le plafond.
    if (channels.size >= MAX_CHANNELS) {
      const oldest = channels.keys().next().value;
      if (oldest !== undefined) channels.delete(oldest);
    }
    lines = [];
    channels.set(channel, lines);
  } else {
    // Re-insertion en fin de Map : garde l'ordre d'éviction = ancienneté d'usage.
    channels.delete(channel);
    channels.set(channel, lines);
  }
  for (const piece of clean.split('\n')) {
    lines.push({ channel, text: piece, kind });
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  emit();
}

/** Marque le démarrage d'un canal (nouvelle exécution → buffer vidé). */
export function startOutputChannel(channel: string, header?: string) {
  channels.set(channel, []);
  if (header) {
    channels.get(channel)!.push({ channel, text: header, kind: 'system' });
  }
  emit();
}

/** Ajoute une ligne système (ex: « process exited with code 0 »). */
export function appendOutputSystem(channel: string, text: string) {
  appendOutput(channel, text, 'system');
}

/** Vide un canal (ou tous si `channel` est omis). */
export function clearOutput(channel?: string) {
  if (channel) channels.delete(channel);
  else channels.clear();
  emit();
}

/** Liste des canaux connus, du plus récent au plus ancien. */
export function listOutputChannels(): string[] {
  return [...channels.keys()].reverse();
}

/** Lignes d'un canal (retourne le tableau interne, ne pas muter). */
export function getOutput(channel: string): OutputLine[] {
  return channels.get(channel) ?? [];
}

export function subscribeOutput(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getOutputVersion(): number {
  return version;
}
