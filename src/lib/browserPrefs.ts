// Préférences navigateur (Settings › Browser).
//
// Persistées en localStorage (clés plates `origin-browser-*`). Elles pilotent
// la politique d'exposition du panel navigateur à l'agent :
//   - builtinControl : l'agent peut piloter le navigateur intégré (preview).
//   - externalControl : l'agent peut piloter un Chrome externe (désactivé par
//     défaut — surface d'attaque plus large, hors sandbox).
//   - defaultTarget : cible par défaut des tâches de navigation.
//   - autoScreenshot : capture automatique après chaque action (affichage seul).

export const BROWSER_BUILTIN_KEY = "origin-browser-builtin-control";
export const BROWSER_EXTERNAL_KEY = "origin-browser-external-control";
export const BROWSER_DEFAULT_TARGET_KEY = "origin-browser-default-target";
export const BROWSER_AUTOSCREENSHOT_KEY = "origin-browser-auto-screenshot";

export const BROWSER_EVENT = "origin-browser-changed";

export type BrowserTarget = "builtin" | "external";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw !== "false";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "true" : "false");
    window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { key, value } }));
  } catch {
    /* stockage indisponible */
  }
}

// Autoriser l'agent à piloter le navigateur intégré : activé par défaut.
export const isBuiltinControlEnabled = () => readBool(BROWSER_BUILTIN_KEY, true);
export const setBuiltinControlEnabled = (on: boolean) => writeBool(BROWSER_BUILTIN_KEY, on);

// Autoriser l'agent à piloter un navigateur externe (Chrome) : désactivé par
// défaut (opt-in explicite — surface d'attaque plus large).
export const isExternalControlEnabled = () => readBool(BROWSER_EXTERNAL_KEY, false);
export const setExternalControlEnabled = (on: boolean) => writeBool(BROWSER_EXTERNAL_KEY, on);

// Capture automatique après action : activée par défaut.
export const isAutoScreenshotEnabled = () => readBool(BROWSER_AUTOSCREENSHOT_KEY, true);
export const setAutoScreenshotEnabled = (on: boolean) => writeBool(BROWSER_AUTOSCREENSHOT_KEY, on);

// Cible par défaut des tâches de navigation.
export function getDefaultTarget(): BrowserTarget {
  try {
    return localStorage.getItem(BROWSER_DEFAULT_TARGET_KEY) === "external" ? "external" : "builtin";
  } catch {
    return "builtin";
  }
}

export function setDefaultTarget(target: BrowserTarget): void {
  try {
    localStorage.setItem(BROWSER_DEFAULT_TARGET_KEY, target);
    window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { key: BROWSER_DEFAULT_TARGET_KEY, value: target } }));
  } catch {
    /* stockage indisponible */
  }
}
