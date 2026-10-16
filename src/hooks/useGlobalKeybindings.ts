import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCommandKeyMap, matchesEvent } from "../lib/keybindings";
import { getCommand as getRegisteredCommand, executeCommand as runRegisteredCommand } from "../lib/extensions/registry";
import { getCommand as getRuntimeCommand, runCommand as runRuntimeCommand } from "../lib/commands/registry";
import { isEditorFocused, isNativeTextInputFocused, isContentEditableFocused, selectContentEditable } from "../lib/commands/editorBridge";

// Commandes purement « éditeur » : leur effet n'a de sens que si le focus est
// DANS un éditeur. Hors éditeur, on bloque l'action native (ex. le Ctrl+A du
// navigateur qui sélectionnait toute l'UI : noms de fichiers, chat, etc.) sans
// exécuter la commande — sinon Ctrl+A sélectionnait « tout » au lieu du fichier.
const EDITOR_SCOPED_COMMANDS = new Set<string>([
  "origin.editorSelectAll",
]);

export interface GlobalHandlers {
  // Always provided
  saveActive:     () => void;
  toggleTerminal: () => void;
  togglePalette:  () => void;
  toggleSettings: () => void;
  // Optional — wired when available in App.tsx
  newFile?:          () => void;
  openFile?:         () => void;
  closeTab?:         () => void;
  toggleSidebar?:    () => void;
  toggleSplit?:      () => void;
  zoomIn?:           () => void;
  zoomOut?:          () => void;
  zoomReset?:        () => void;
  runFile?:          () => void;
  startDebug?:       () => void;
  stopDebug?:        () => void;
  stepOver?:         () => void;
  stepInto?:         () => void;
  stepOut?:          () => void;
  toggleBreakpoint?: () => void;
}

export function useGlobalKeybindings(handlers: GlobalHandlers) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const h = useRef(handlers);
  h.current = handlers;

  const isFullscreenRef = useRef(false);
  const wasMaximizedRef = useRef(false);

  async function toggleFullscreen() {
    const win = getCurrentWindow();
    if (!isFullscreenRef.current) {
      const maximized = await win.isMaximized();
      wasMaximizedRef.current = maximized;
      if (maximized) {
        await win.unmaximize();
        // Win32 processes window state via the message queue — the promise resolves
        // before the OS has finished the restore, so setFullscreen fires into a
        // mid-transition window and silently fails without this delay.
        await new Promise(r => setTimeout(r, 150));
      }
      await win.setFullscreen(true);
      isFullscreenRef.current = true;
      setIsFullscreen(true);
    } else {
      await win.setFullscreen(false);
      if (wasMaximizedRef.current) await win.maximize();
      isFullscreenRef.current = false;
      setIsFullscreen(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Respecte les raccourcis déjà consommés en amont (ex. keymap CodeMirror) :
      // évite d'exécuter deux fois la même action (moveLineUp, etc.).
      if (e.defaultPrevented) return;

      // Read the live keymap on every event so custom bindings apply immediately
      // without a page reload (localStorage is synchronous).
      const km = getCommandKeyMap();

      // Handlers historiques (rétro-compat) pour les commandes sans entrée dans
      // la registry runtime. La registry runtime a priorité : elle couvre un
      // sur-ensemble des commandes (édition avancée, multi-curseurs, lignes…).
      const legacyDispatch: Record<string, (() => void) | undefined> = {
        "origin.toggleFullscreen": () => toggleFullscreen(),
        "origin.toggleBreakpoint": () => h.current.toggleBreakpoint?.(),
      };

      for (const [cmdId, keyStr] of Object.entries(km)) {
        if (!keyStr) continue;
        if (!matchesEvent(e, keyStr)) continue;

        // Commande « éditeur » hors éditeur : on neutralise l'action native
        // (empêche le Ctrl+A navigateur de sélectionner toute l'UI) SANS exécuter
        // la commande ni laisser filer l'event vers un autre raccourci.
        if (EDITOR_SCOPED_COMMANDS.has(cmdId) && !isEditorFocused()) {
          const el = document.activeElement;
          if (isNativeTextInputFocused()) {
            // Champ natif (input/textarea) : le Ctrl+A natif est fiable et scopé
            // au champ — on laisse filer sans le prévenir.
            return;
          }
          // `contenteditable` (ex. composer du chat) : le natif débordait sur le
          // document. On gère la sélection « tout » NOUS-MÊMES, confinée au contenu
          // de la zone.
          e.preventDefault();
          if (isContentEditableFocused() && el instanceof HTMLElement) {
            selectContentEditable(el);
          }
          return;
        }

        // 1) Registry runtime (cœur IDE) — source de vérité principale.
        const runtime = getRuntimeCommand(cmdId);
        if (runtime) {
          e.preventDefault();
          void runRuntimeCommand(cmdId);
          return;
        }

        // 2) Commandes d'extension (Level 2).
        const isExtension = getRegisteredCommand(cmdId) !== undefined;
        if (isExtension) {
          e.preventDefault();
          void runRegisteredCommand(cmdId).catch((err: unknown) => {
            console.error(`[extension] command "${cmdId}" failed:`, err);
          });
          return;
        }

        // 3) Handlers historiques restants.
        const handler = legacyDispatch[cmdId];
        if (handler) {
          e.preventDefault();
          handler();
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);

    let unlistenResized: (() => void) | undefined;
    let unlistenScale:   (() => void) | undefined;

    getCurrentWindow().onResized(() => {
      window.dispatchEvent(new Event("resize"));
    }).then(fn => { unlistenResized = fn; });

    getCurrentWindow().onScaleChanged(({ payload: scaleFactor }) => {
      document.documentElement.style.setProperty("--scale-factor", String(scaleFactor));
      window.dispatchEvent(new Event("resize"));
    }).then(fn => { unlistenScale = fn; });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlistenResized?.();
      unlistenScale?.();
    };
  }, []);

  return { isFullscreen, toggleFullscreen };
}
