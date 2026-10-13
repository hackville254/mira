import { useEffect, useRef } from 'react';
import {
  loadAutoSavePrefs,
  AUTO_SAVE_CHANGED_EVENT,
  type AutoSavePrefs,
} from '../lib/autoSavePrefs';
import type { Tab } from '../components/editor/TabBar';

interface UseAutoSaveArgs {
  /** Snapshot toujours à jour des onglets (tabsRef de useTabs). */
  tabsRef: React.RefObject<Tab[]>;
  /** Snapshot toujours à jour du contenu par chemin (fileContentsRef de useTabs). */
  fileContentsRef: React.RefObject<Record<string, string>>;
  /** Onglet actif courant (activeTabRef de useTabs). */
  activeTabRef: React.RefObject<string | null>;
  /** Écriture effective d'un fichier (handleSave de useTabs). */
  handleSave: (path: string, contentOverride?: string) => Promise<void>;
}

/**
 * Sauvegarde automatique des onglets modifiés, façon VS Code (`files.autoSave`).
 *
 * Règles communes :
 *   - on n'écrit QUE les onglets `isDirty`, non « untitled » et réels (pas de
 *     chemin virtuel `__…`). Les untitled exigent un dialogue natif : les
 *     sauvegarder automatiquement ouvrirait une boîte de dialogue intempestive.
 *   - `afterDelay` : debounce après la dernière frappe (délai configurable).
 *   - `onFocusChange` : à la perte de focus de la fenêtre d'édition.
 *   - `onWindowChange` : à la perte de focus de la fenêtre applicative (blur).
 *
 * Le contenu est lu depuis `fileContentsRef` (source de vérité en mémoire, tenue
 * à jour à chaque frappe) — cohérent avec `handleSaveAll`.
 */
export function useAutoSave({ tabsRef, fileContentsRef, activeTabRef, handleSave }: UseAutoSaveArgs) {
  // On garde handleSave dans une ref pour que l'effet ne se recâble pas à chaque
  // rendu (handleSave est recréé à chaque rendu de useTabs).
  const handleSaveRef = useRef(handleSave);
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current values visible to pre-render callbacks
  handleSaveRef.current = handleSave;

  const argsRef = useRef({ tabsRef, fileContentsRef, activeTabRef });
  // eslint-disable-next-line react-hooks/refs -- stable ref pattern: keep current values visible to pre-render callbacks
  argsRef.current = { tabsRef, fileContentsRef, activeTabRef };

  useEffect(() => {
    let prefs: AutoSavePrefs = loadAutoSavePrefs();
    let timer: ReturnType<typeof setTimeout> | null = null;

    function dirtyPaths(): string[] {
      const { tabsRef: t } = argsRef.current;
      return (t.current ?? [])
        .filter(tab => tab.isDirty && !tab.isUntitled && !tab.path.startsWith('__'))
        .map(tab => tab.path);
    }

    function saveDirty() {
      const { fileContentsRef: fc } = argsRef.current;
      for (const path of dirtyPaths()) {
        const content = fc.current?.[path];
        if (content === undefined) continue;
        void handleSaveRef.current(path, content);
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      if (prefs.mode !== 'afterDelay') return;
      timer = setTimeout(() => { timer = null; saveDirty(); }, prefs.delayMs);
    }

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function onWindowBlur() {
      if (prefs.mode === 'onWindowChange') saveDirty();
    }

    // L'éditeur signale la perte de focus via un événement custom (émis par
    // CodeMirror `blur`). On l'écoute uniquement en mode 'onFocusChange'.
    function onEditorBlur() {
      if (prefs.mode === 'onFocusChange') saveDirty();
    }

    function onPrefsChanged() {
      prefs = loadAutoSavePrefs();
      cancel();
      // Un changement de mode/délai ne déclenche pas d'écriture immédiate : on
      // repart proprement avec les nouvelles préférences.
    }

    // Déclencheur du debounce : à chaque frappe (événement émis par l'éditeur).
    function onEditorChange() {
      if (prefs.mode === 'afterDelay') schedule();
    }

    window.addEventListener('origin:autosave-change', onEditorChange);
    window.addEventListener('origin:editor-blur', onEditorBlur);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener(AUTO_SAVE_CHANGED_EVENT, onPrefsChanged);

    return () => {
      cancel();
      window.removeEventListener('origin:autosave-change', onEditorChange);
      window.removeEventListener('origin:editor-blur', onEditorBlur);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener(AUTO_SAVE_CHANGED_EVENT, onPrefsChanged);
    };
  }, []);
}
