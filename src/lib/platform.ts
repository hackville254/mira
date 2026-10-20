// ── Plateforme & formatage des raccourcis ────────────────────────────────────
//
// Centralise la détection d'OS et le rendu des touches pour garantir un affichage
// cohérent et natif sur macOS / Windows / Linux :
//   - macOS  : « ⌘ ⇧ ⌥ ⌃ » (symboles Apple), séparateur fin.
//   - Windows/Linux : « Ctrl + Shift + Alt », séparateur « + ».
//
// Les raccourcis sont stockés dans un format canonique (ex. « ctrl+shift+p »),
// identique quel que soit l'OS ; seul l'affichage change.

export type Platform = 'mac' | 'win' | 'linux';

/** Détecte la plateforme courante. Sûr côté navigateur (Tauri = webview). */
export function getPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'win';
  return 'linux';
}

/** Vrai si l'OS courant est macOS. */
export function isMac(): boolean {
  return getPlatform() === 'mac';
}

// Sur macOS, « ctrl » dans nos raccourcis canoniques = modificateur principal
// (Cmd/⌘), car `matchesEvent` accepte Ctrl OU Cmd. Le vrai Control (⌃) n'est pas
// utilisé dans les bindings par défaut : on le réserve à « control » explicite.
const MAC_SYMBOLS: Record<string, string> = {
  cmd: '⌘', meta: '⌘', ctrl: '⌘', control: '⌃',
  alt: '⌥', opt: '⌥', option: '⌥',
  shift: '⇧', enter: '↵', return: '↵',
  backspace: '⌫', delete: '⌦', del: '⌦',
  esc: '⎋', escape: '⎋', tab: '⇥',
  up: '↑', down: '↓', left: '←', right: '→',
};

const WIN_LABELS: Record<string, string> = {
  cmd: 'Ctrl', meta: 'Ctrl', ctrl: 'Ctrl', control: 'Ctrl',
  alt: 'Alt', opt: 'Alt', option: 'Alt',
  shift: 'Shift', enter: 'Enter', return: 'Enter',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};

/**
 * Formate un raccourci canonique (ex. « ctrl+shift+p », « alt+down », « f5 »)
 * en libellé natif de la plateforme.
 *   - macOS  : « ⇧⌘P », « ⌥↓ »
 *   - autres : « Ctrl+Shift+P », « Alt+Down »
 * Les séquences « chord » (ex. « ctrl+k ctrl+o ») sont rendues séparées par un
 * espace : « ⌘K ⌘O » / « Ctrl+K Ctrl+O ».
 */
export function formatShortcut(key: string | undefined | null): string {
  if (!key) return '';
  const mac = isMac();
  // Une séquence chord contient des espaces ; chaque segment est formaté à part.
  const chords = key.trim().split(/\s+/);
  const formatOne = (chord: string): string => {
    const parts = chord.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
    const rendered = parts.map(p => {
      if (mac) {
        if (MAC_SYMBOLS[p]) return MAC_SYMBOLS[p];
        return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
      }
      if (WIN_LABELS[p]) return WIN_LABELS[p];
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    });
    return rendered.join(mac ? '' : '+');
  };
  return chords.map(formatOne).join(' ');
}

/** Libellé du modificateur principal seul : « ⌘ » sur macOS, « Ctrl » ailleurs. */
export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
