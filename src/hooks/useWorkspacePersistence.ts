import { useState, useEffect } from "react";
import { getSetting, setSetting } from "../lib/settings";
import { hydrateAllTodos } from "../lib/agent/todoStore";
import { useWorkspace } from "../context/WorkspaceContext";

const ls = {
  get: (k: string) => localStorage.getItem(k),
  set: (k: string, v: string) => localStorage.setItem(k, v),
};

export function useWorkspacePersistence() {
  const { setFolderPath } = useWorkspace();

  const [sidebarOpen,    setSidebarOpen]    = useState(() => ls.get('origin-sidebar-open') === 'true');
  // Agent panel: open by default unless the user explicitly closed it.
  const [aiPanelOpen,    setAiPanelOpen]    = useState(() => ls.get('origin-ai-panel-open') !== 'false');
  const [terminalOpen,   setTerminalOpen]   = useState(() => ls.get('origin-terminal-open') === 'true');
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const n = parseInt(ls.get('origin-terminal-height') ?? '', 10);
    return isNaN(n) ? 240 : n;
  });
  // Global application mode: "ide" (full editor layout) or "ai" (Agent-centric layout).
  const [appMode, setAppMode] = useState<'ide' | 'ai'>(
    () => (ls.get('origin-app-mode') === 'ai' ? 'ai' : 'ide')
  );

  // Hydrate from Tauri store on mount (overwrites localStorage defaults if store has values)
  useEffect(() => {
    Promise.all([
      getSetting('workspace.folder'),
      getSetting('sidebar.open'),
      getSetting('terminal.open'),
      getSetting('terminal.height'),
      getSetting('app.mode'),
    ]).then(([folder, sidebar, termOpen, termHeight, storeAppMode]) => {
      setFolderPath(folder || null);

      setSidebarOpen(sidebar);
      ls.set('origin-sidebar-open', String(sidebar));

      setTerminalOpen(termOpen);
      ls.set('origin-terminal-open', String(termOpen));

      if (termHeight > 0) {
        setTerminalHeight(termHeight);
        ls.set('origin-terminal-height', String(termHeight));
      }

      // Le mode applicatif était jusqu'ici reconstruit uniquement depuis
      // localStorage, donc « désynchronisé » du store Tauri : une bascule
      // IDE↔AI pouvait ne pas survivre selon la machine/le profil. On aligne
      // désormais le store comme source de vérité (repli localStorage si vide).
      const effectiveAppMode: 'ide' | 'ai' =
        storeAppMode === 'ai' || storeAppMode === 'ide'
          ? storeAppMode
          : (ls.get('origin-app-mode') === 'ai' ? 'ai' : 'ide');
      setAppMode(effectiveAppMode);
      ls.set('origin-app-mode', effectiveAppMode);
    });

    // Les todo lists sont persistées par conversation : on les réalimente une
    // fois au démarrage pour qu'elles survivent au reload et à la bascule IDE↔AI.
    void hydrateAllTodos();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ls.set('origin-sidebar-open', String(sidebarOpen));
    setSetting('sidebar.open', sidebarOpen);
  }, [sidebarOpen]);

  useEffect(() => {
    ls.set('origin-terminal-open', String(terminalOpen));
    setSetting('terminal.open', terminalOpen);
  }, [terminalOpen]);

  useEffect(() => {
    ls.set('origin-terminal-height', String(terminalHeight));
    setSetting('terminal.height', terminalHeight);
  }, [terminalHeight]);

  useEffect(() => {
    ls.set('origin-ai-panel-open', String(aiPanelOpen));
  }, [aiPanelOpen]);

  useEffect(() => {
    ls.set('origin-app-mode', appMode);
    setSetting('app.mode', appMode);
  }, [appMode]);

  return {
    sidebarOpen,    setSidebarOpen,
    aiPanelOpen,    setAiPanelOpen,
    terminalOpen,   setTerminalOpen,
    terminalHeight, setTerminalHeight,
    appMode,        setAppMode,
  };
}
