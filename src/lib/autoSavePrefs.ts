// Préférences persistantes de la sauvegarde automatique (parité VS Code
// `files.autoSave` / `files.autoSaveDelay`).
//
// Quatre modes, comme VS Code :
//   - 'off'            : sauvegarde manuelle uniquement (défaut)
//   - 'afterDelay'     : sauvegarde N ms après la dernière frappe
//   - 'onFocusChange'  : sauvegarde quand l'éditeur perd le focus
//   - 'onWindowChange' : sauvegarde quand la fenêtre perd le focus
//
// Persisté en localStorage, dans la lignée de `origin-editor-format-on-save`.

const MODE_KEY = 'origin-editor-autosave';
const DELAY_KEY = 'origin-editor-autosave-delay';

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

export interface AutoSavePrefs {
  mode: AutoSaveMode;
  /** Délai (ms) utilisé uniquement en mode 'afterDelay'. */
  delayMs: number;
}

const DEFAULT_DELAY_MS = 1000;
const MODES: AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];

export const DEFAULT_AUTO_SAVE_PREFS: AutoSavePrefs = {
  mode: 'off',
  delayMs: DEFAULT_DELAY_MS,
};

function isMode(v: unknown): v is AutoSaveMode {
  return typeof v === 'string' && (MODES as string[]).includes(v);
}

export function loadAutoSavePrefs(): AutoSavePrefs {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    const delayRaw = parseInt(localStorage.getItem(DELAY_KEY) ?? '', 10);
    const delayMs = Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : DEFAULT_DELAY_MS;
    return { mode: isMode(mode) ? mode : 'off', delayMs };
  } catch {
    return { ...DEFAULT_AUTO_SAVE_PREFS };
  }
}

export function saveAutoSavePrefs(prefs: AutoSavePrefs): void {
  try {
    localStorage.setItem(MODE_KEY, prefs.mode);
    localStorage.setItem(DELAY_KEY, String(prefs.delayMs));
  } catch {
    // Stockage indisponible (mode privé, quota) : on ignore silencieusement.
  }
}

/** Sélecteur d'événement pour que les consommateurs réagissent en direct. */
export const AUTO_SAVE_CHANGED_EVENT = 'origin:autosave-changed';

export function notifyAutoSaveChanged(): void {
  window.dispatchEvent(new Event(AUTO_SAVE_CHANGED_EVENT));
}
