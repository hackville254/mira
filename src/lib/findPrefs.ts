// Préférences persistantes de la barre « Find » de l'éditeur.
//
// On mémorise uniquement ce qui doit survivre entre sessions (comme VS Code) :
// l'état déplié de la ligne de remplacement. Le champ de recherche lui-même
// n'est pas persisté (VS Code ne le fait pas non plus : la sélection courante
// re-préremplit le champ à chaque ouverture).

const KEY = 'origin-find-prefs';

export interface FindPrefs {
  /** La ligne « Replace » était-elle dépliée à la dernière utilisation ? */
  replaceOpen: boolean;
}

const DEFAULT: FindPrefs = { replaceOpen: false };

export function loadFindPrefs(): FindPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<FindPrefs>;
    return { replaceOpen: parsed.replaceOpen === true };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveFindPrefs(prefs: FindPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Stockage indisponible (mode privé, quota) : on ignore silencieusement.
  }
}
