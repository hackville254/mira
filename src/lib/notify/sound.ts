// ── Sons de notification (parité Trae) ────────────────────────────────────────
//
// Trae émet un signal sonore à certains moments clés du travail de l'agent :
//   - fin de tâche                                → carillon positif ;
//   - question posée par l'agent (« ask user »)   → tonalité d'interpellation ;
//   - erreur / arrêt brutal                       → son négatif ;
//   - arrêt volontaire par l'utilisateur          → son neutre, discret.
//
// Implémentation : de VRAIS fichiers audio (MP3) embarqués dans le bundle, issus
// de la banque Mixkit (licence gratuite, sans attribution requise,
// https://mixkit.co/license/#sfxFree).
//
// Pourquoi l'API Web Audio plutôt qu'un simple `new Audio().play()` ?
//   Dans une webview (WKWebView sur macOS, WebView2 sur Windows) la lecture
//   automatique d'un média est bloquée tant qu'un GESTE UTILISATEUR ne l'a pas
//   « débloquée ». Or nos sons se déclenchent de façon ASYNCHRONE (fin de
//   stream, erreur du modèle…), donc un `play()` direct sur un `HTMLAudioElement`
//   est très souvent refusé en silence.
//   L'API Web Audio expose un `AudioContext` que l'on peut `resume()` une seule
//   fois, lors d'un vrai geste utilisateur (`primeSound()` appelé au premier
//   envoi). Une fois le contexte « running », TOUTES les lectures ultérieures
//   (même asynchrones) passent — c'est la manière fiable de jouer un son dans
//   une app de bureau web.
//
// Le module respecte une préférence utilisateur (`localStorage`) et reste
// SILENCIEUX si l'utilisateur a coupé le son ou si la valeur est illisible.
// Il ne lève JAMAIS : un son ne doit pas casser un flux applicatif.

export type SoundName = "finish" | "question" | "error" | "stop";

export const SOUND_PREF_KEY = "origin-notifications-sound";
export const SOUND_VOLUME_KEY = "origin-notifications-volume";

const DEFAULT_VOLUME = 0.6;

/** Le son est-il activé ? (défaut : oui) */
export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Volume courant normalisé [0, 1] (défaut : 0.6). */
export function getSoundVolume(): number {
  try {
    const raw = localStorage.getItem(SOUND_VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return DEFAULT_VOLUME;
    return Math.min(100, Math.max(0, n)) / 100;
  } catch {
    return DEFAULT_VOLUME;
  }
}

// ── Fichiers audio embarqués ─────────────────────────────────────────────────
//
// `new URL(..., import.meta.url)` est résolu par Vite : en dev il pointe vers
// `src/assets/sounds/*`, en build il pointe vers le fichier haché émis dans
// `assets/`. On obtient donc une URL valide dans les deux cas, sans chemin
// absolu codé en dur.

const SOUND_URLS: Record<SoundName, string> = {
  finish: new URL("../../assets/sounds/finish.mp3", import.meta.url).href,
  question: new URL("../../assets/sounds/question.mp3", import.meta.url).href,
  error: new URL("../../assets/sounds/error.mp3", import.meta.url).href,
  stop: new URL("../../assets/sounds/stop.mp3", import.meta.url).href,
};

// ── Contexte audio paresseux & cache de buffers décodés ─────────────────────
//
// Un seul `AudioContext` pour toute l'app, créé au premier besoin. Chaque son
// est décodé UNE fois en `AudioBuffer` (via `fetch` + `decodeAudioData`), puis
// rejoué en créant un `AudioBufferSourceNode` (trivial, aucun re-décodage).
// Le volume est appliqué par un `GainNode` par lecture, donc modifiable à chaud.

const buffers = new Map<SoundName, AudioBuffer>();
const loading = new Map<SoundName, Promise<AudioBuffer | null>>();
let ctx: AudioContext | null = null;

type AudioCtxCtor = typeof AudioContext;

/** Récupère le constructeur d'AudioContext quelle que soit la webview. */
function getCtxCtor(): AudioCtxCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioCtxCtor;
    webkitAudioContext?: AudioCtxCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Contexte audio paresseux (créé au premier son / premier prime). */
function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = getCtxCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Décode un son en `AudioBuffer` (une fois), en cache. */
function loadBuffer(name: SoundName): Promise<AudioBuffer | null> {
  const cached = buffers.get(name);
  if (cached) return Promise.resolve(cached);

  const pending = loading.get(name);
  if (pending) return pending;

  const context = getCtx();
  if (!context) return Promise.resolve(null);

  const task = (async (): Promise<AudioBuffer | null> => {
    try {
      const res = await fetch(SOUND_URLS[name]);
      const bytes = await res.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes);
      buffers.set(name, decoded);
      return decoded;
    } catch {
      // Réseau, décodage ou format : on ignore (best-effort).
      return null;
    } finally {
      loading.delete(name);
    }
  })();

  loading.set(name, task);
  return task;
}

// ── Lecture ──────────────────────────────────────────────────────────────────

/**
 * Joue un son de notification. No-op silencieux si le son est désactivé ou si
 * l'environnement ne fournit pas d'API audio. Ne lève JAMAIS.
 */
export function playSound(name: SoundName, opts?: { force?: boolean }): void {
  try {
    if (!opts?.force && !isSoundEnabled()) return;
    const volume = getSoundVolume();
    if (volume <= 0) return;

    const context = getCtx();
    if (!context) return;

    // La lecture peut être « suspendue » si aucun geste utilisateur n'a encore
    // eu lieu : on tente de la relancer (no-op si c'est déjà en cours).
    void context.resume().catch(() => { /* ignore */ });

    const start = (buffer: AudioBuffer | null) => {
      if (!buffer) return;
      try {
        const src = context.createBufferSource();
        src.buffer = buffer;
        const gain = context.createGain();
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(context.destination);
        src.start(0);
        // Libère le graphe une fois la lecture finie.
        src.onended = () => {
          try { src.disconnect(); gain.disconnect(); } catch { /* ignore */ }
        };
      } catch {
        /* ignore */
      }
    };

    // Buffer déjà décodé → lecture immédiate (aucune latence). Sinon on attend
    // le décodage, qui se fait une seule fois puis est mis en cache.
    const cached = buffers.get(name);
    if (cached) { start(cached); return; }
    void loadBuffer(name).then(start).catch(() => { /* ignore */ });
  } catch {
    // best-effort : on ignore toute erreur audio.
  }
}

/**
 * Prépare le contexte audio : appelé sur un VRAI geste utilisateur (premier
 * envoi). C'est ce qui « débloque » la lecture automatique dans les webviews :
 * une fois `resume()` obtenu ici, toutes les lectures asynchrones suivantes
 * passent. On pré-décode aussi les buffers pour supprimer la latence au premier
 * son.
 */
export function primeSound(): void {
  try {
    const context = getCtx();
    if (!context) return;
    // resume() DOIT être appelé dans le geste utilisateur.
    void context.resume().catch(() => { /* ignore */ });
    for (const name of Object.keys(SOUND_URLS) as SoundName[]) {
      void loadBuffer(name).catch(() => { /* ignore */ });
    }
  } catch {
    // best-effort.
  }
}
