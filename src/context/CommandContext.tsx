import { createContext, useContext } from 'react';

export interface AppCommands {
  // Layout toggles
  sidebarOpen: boolean;
  terminalOpen: boolean;
  aiPanelOpen: boolean;
  appMode: 'ide' | 'ai';
  onSetAppMode: (mode: 'ide' | 'ai') => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleAiPanel: () => void;
  /** Explicitly open/close the AI panel (IDE ↔ AI MODE switch). */
  onSetAiPanel: (open: boolean) => void;
  // Window
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  // Navigation
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onNewFile: () => void;
  onNewWindow: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  /** Ouvre un projet (dossier) déjà connu — entrées « Recent » du menu projet. */
  onOpenProject: (path: string) => void;
  /** Ouvre la boîte de dialogue « Clone Git Repository ». */
  onCloneRepo: () => void;
  // Status
  gitBranch: string | null;
  dirtyCount: number;
  hasActiveTab: boolean;
  hasFolderOpen: boolean;
  // File menu
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAll: () => void;
  onCloseEditor: () => void;
  onCloseFolder: () => void;
  // Editor actions
  onEditorUndo: () => void;
  onEditorRedo: () => void;
  onEditorPrevFile: () => void;
  onEditorNextFile: () => void;
  onEditorCut: () => void;
  onEditorCopy: () => void;
  onEditorPaste: () => void;
  onEditorSelectAll: () => void;
  onEditorFind: () => void;
  // Zoom
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  // Terminal
  onNewTerminalTab: () => void;
  onClearTerminal: () => void;
  onKillTerminal: () => void;
  // Run
  onRunFile: () => void;
  // Debug
  onStartDebugging: () => void;
  onStopDebugging: () => void;
  isDebugActive: boolean;
}

const noop = () => {};

const defaults: AppCommands = {
  sidebarOpen: false, terminalOpen: false, aiPanelOpen: false,
  appMode: 'ide', onSetAppMode: noop,
  onToggleSidebar: noop, onToggleTerminal: noop, onToggleAiPanel: noop, onSetAiPanel: noop,
  isFullscreen: false, onToggleFullscreen: noop,
  onOpenFolder: noop, onOpenFile: noop, onNewFile: noop, onNewWindow: noop, onOpenPalette: noop, onOpenSettings: noop,
  onOpenProject: noop, onCloneRepo: noop,
  gitBranch: null, dirtyCount: 0, hasActiveTab: false, hasFolderOpen: false,
  onSave: noop, onSaveAs: noop, onSaveAll: noop, onCloseEditor: noop, onCloseFolder: noop,
  onEditorUndo: noop, onEditorRedo: noop, onEditorPrevFile: noop, onEditorNextFile: noop, onEditorCut: noop, onEditorCopy: noop,
  onEditorPaste: noop, onEditorSelectAll: noop, onEditorFind: noop,
  onZoomIn: noop, onZoomOut: noop, onZoomReset: noop,
  onNewTerminalTab: noop, onClearTerminal: noop, onKillTerminal: noop,
  onRunFile: noop,
  onStartDebugging: noop, onStopDebugging: noop, isDebugActive: false,
};

export const CommandContext = createContext<AppCommands>(defaults);

export function useCommands(): AppCommands {
  return useContext(CommandContext);
}
