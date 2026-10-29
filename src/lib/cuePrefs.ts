// Préférences du moteur CUE (context understanding engine).
//
// Persistées en localStorage (clés plates `origin-cue-*`), comme les autres
// préférences éditeur (`origin-editor-ai-autocomplete`, etc.). Toutes les
// capacités CUE sont activées par défaut : l'utilisateur peut les désactiver
// depuis Settings › CUE, et le moteur respecte immédiatement le changement.

export const CUE_TAB_KEY = "origin-cue-tab";
export const CUE_SMART_IMPORT_KEY = "origin-cue-smart-import";
export const CUE_SMART_RENAME_KEY = "origin-cue-smart-rename";

export const CUE_EVENT = "origin-cue-changed";

// Lit un flag booléen : absent = activé (opt-out).
export function readCueFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

export function writeCueFlag(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, enabled ? "true" : "false");
    window.dispatchEvent(new CustomEvent(CUE_EVENT, { detail: { key, enabled } }));
  } catch {
    /* stockage indisponible : on garde le défaut en mémoire */
  }
}

// Tab-Cue : complétion inline (ghost text) alimentée par le moteur CUE.
export const isTabCueEnabled = () => readCueFlag(CUE_TAB_KEY);
export const setTabCueEnabled = (on: boolean) => writeCueFlag(CUE_TAB_KEY, on);

// Smart Import : détection et ajout automatique des imports manquants.
export const isSmartImportEnabled = () => readCueFlag(CUE_SMART_IMPORT_KEY);
export const setSmartImportEnabled = (on: boolean) => writeCueFlag(CUE_SMART_IMPORT_KEY, on);

// Smart Rename : renommage intelligent des variables/fonctions/fichiers.
export const isSmartRenameEnabled = () => readCueFlag(CUE_SMART_RENAME_KEY);
export const setSmartRenameEnabled = (on: boolean) => writeCueFlag(CUE_SMART_RENAME_KEY, on);
