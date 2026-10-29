// Préférences de l'environnement de développement (Development Environment).
//
// On persiste uniquement le choix de l'utilisateur (chemin d'interpréteur
// sélectionné). La détection réelle des binaires est faite côté Rust.

const KEY = 'origin-devenv';

export interface DevEnvPrefs {
  /** Chemin de l'interpréteur Python choisi manuellement, sinon null. */
  pythonPath: string | null;
  /** Version/chemin Node.js choisi manuellement, sinon null. */
  nodePath: string | null;
}

const DEFAULT: DevEnvPrefs = { pythonPath: null, nodePath: null };

export function loadDevEnvPrefs(): DevEnvPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<DevEnvPrefs>;
    return {
      pythonPath: typeof parsed.pythonPath === 'string' ? parsed.pythonPath : null,
      nodePath:   typeof parsed.nodePath   === 'string' ? parsed.nodePath   : null,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveDevEnvPrefs(prefs: DevEnvPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}
