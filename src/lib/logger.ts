import { invoke } from "@tauri-apps/api/core";

/**
 * Logger central d'Origin.
 *
 * ── Pourquoi ──────────────────────────────────────────────────────────────────
 * `console.*` du front est invisible sans DevTools. Or en usage normal on veut
 * pouvoir dire « où ça casse » et « combien de temps ça a pris ». Ce module
 * relaie les logs vers le backend (`origin_log`), qui les écrit sur stderr du
 * process (VISIBLE dans le terminal `tauri dev`) ET dans un fichier persistant
 * (`~/.origin/logs/origin.log`, utile en release sans terminal).
 *
 * ── Conception ────────────────────────────────────────────────────────────────
 *   - Buffer + flush : les logs d'un long run arrivent par rafales (un par
 *     token potentiellement). On les accumule et on les envoie par lots pour ne
 *     pas saturer l'IPC — un seul `invoke` par fenêtre de temps.
 *   - Best-effort : toute erreur d'IPC est avalée (un log ne doit JAMAIS casser
 *     une fonctionnalité). On garde aussi le log console local en dev.
 *   - Pas de secret : on n'y met que du diagnostic (jamais la clé API).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface BufferedLine {
  level: LogLevel;
  target: string;
  message: string;
}

/** Tampon des lignes en attente d'envoi vers le backend. */
let buffer: BufferedLine[] = [];
/** Handle du flush différé (une seule planification à la fois). */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Délai de regroupement : assez court pour rester « live », assez long pour batcher. */
const FLUSH_DELAY_MS = 150;
/** Au-delà, on flush immédiatement (évite un tampon non borné si l'app se bloque). */
const FLUSH_THRESHOLD = 50;

/**
 * Envoie le tampon au backend en un appel. En dev, on duplique aussi sur la
 * console locale (DevTools), pour ne rien perdre si l'IPC est indisponible
 * (ex. tests unitaires en environnement node, où `invoke` n'existe pas).
 */
function flush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];

  // Réplique console (dev / tests) : reste lisible même sans backend.
  for (const l of lines) {
    const s = `[${l.target}] ${l.message}`;
    if (l.level === "error") console.error(s);
    else if (l.level === "warn") console.warn(s);
    else console.info(s);
  }

  // Envoi backend : un appel par ligne, mais groupés dans la même rafale. On
  // avale toute erreur (hors contexte Tauri → pas d'`invoke`).
  for (const l of lines) {
    void Promise.resolve()
      .then(() => invoke("origin_log", { level: l.level, target: l.target, message: l.message }))
      .catch(() => { /* best-effort : jamais bloquant */ });
  }
}

function enqueue(level: LogLevel, target: string, message: string): void {
  buffer.push({ level, target, message });
  if (buffer.length >= FLUSH_THRESHOLD) { flush(); return; }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

/**
 * API publique minimale. `target` est un tag stable (ex. « agent/run ») qui
 * permet de filtrer le fichier de log : on s'y tient (pas de tag dynamique).
 */
export const log = {
  debug: (target: string, message: string) => enqueue("debug", target, message),
  info:  (target: string, message: string) => enqueue("info",  target, message),
  warn:  (target: string, message: string) => enqueue("warn",  target, message),
  error: (target: string, message: string) => enqueue("error", target, message),
  /** Force l'envoi immédiat (ex. juste avant une erreur fatale). */
  flush,
};
