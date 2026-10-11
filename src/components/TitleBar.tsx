import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "./ui/Tooltip";
import DropdownMenu, { type MenuEntry } from "./ui/DropdownMenu";
import { useCommands } from "../context/CommandContext";
import { useWorkspace } from "../context/WorkspaceContext";
import logoSrc from "../assets/logo-code.svg";

const win = getCurrentWindow();

function IconBtn({
  onClick,
  label,
  active,
  tooltip,
  children,
}: {
  onClick?: () => void;
  label: string;
  active?: boolean;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const btn = (
    <button
      onClick={onClick}
      aria-label={label}
      className="p-1.5 rounded transition-colors"
      style={{ color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--origin-fg-default)";
        e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)";
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {children}
    </button>
  );

  return tooltip ? (
    <Tooltip content={tooltip} side="bottom">{btn}</Tooltip>
  ) : btn;
}

/**
 * Segmented switch between IDE and AI MODE.
 * A single sliding white "thumb" carries the robot glyph and animates between the
 * two segments, mirroring the Trae/SOLO style: inactive labels are muted, the
 * active one is highlighted, and the thumb holds the mode icon.
 */
function ModeSwitch({
  aiPanelOpen,
  onSetAiPanel,
}: {
  aiPanelOpen: boolean;
  onSetAiPanel: (open: boolean) => void;
}) {
  const ideRef = useRef<HTMLButtonElement>(null);
  const aiRef = useRef<HTMLButtonElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0 });

  // Recompute the thumb geometry from the active segment's box.
  useEffect(() => {
    const el = aiPanelOpen ? aiRef.current : ideRef.current;
    if (!el) return;
    setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [aiPanelOpen]);

  const segmentStyle = (active: boolean) => ({
    color: active ? "var(--origin-fg-default)" : "var(--origin-fg-subtle)",
    transition: "color 220ms ease",
  });

  return (
    <div className="flex items-center gap-1.5" style={{ color: "var(--origin-fg-muted)" }}>
      <img src={logoSrc} alt="Origin" style={{ height: "16px", width: "auto" }} />
      <div
        role="tablist"
        aria-label="Editor mode"
        className="relative flex items-center rounded-lg p-0.5"
        style={{ backgroundColor: "var(--origin-bg-hover)" }}
      >
        {/* Sliding thumb — holds the mode glyph */}
        <span
          aria-hidden
          className="absolute flex items-center justify-center rounded-md"
          style={{
            top: "2px",
            bottom: "2px",
            left: 0,
            width: `${thumb.width}px`,
            transform: `translateX(${thumb.left}px)`,
            backgroundColor: "#ffffff",
            transition: "transform 260ms cubic-bezier(0.34, 1.3, 0.64, 1), width 260ms cubic-bezier(0.34, 1.3, 0.64, 1)",
          }}
        >
          <Icon icon="lucide:square-terminal" width={14} strokeWidth={2.5} style={{ color: "#111111" }} />
        </span>

        <Tooltip content={aiPanelOpen ? "Switch to IDE Mode" : ""} side="bottom">
          <button
            ref={ideRef}
            role="tab"
            aria-selected={!aiPanelOpen}
            onClick={() => onSetAiPanel(false)}
            className="relative z-10 rounded-md px-2 py-1 text-xs font-bold tracking-wide"
            style={segmentStyle(!aiPanelOpen)}
          >
            <span style={{ visibility: !aiPanelOpen ? "hidden" : "visible" }}>IDE</span>
          </button>
        </Tooltip>

        <Tooltip content={!aiPanelOpen ? "Switch to AI Mode" : ""} side="bottom">
          <button
            ref={aiRef}
            role="tab"
            aria-selected={aiPanelOpen}
            onClick={() => onSetAiPanel(true)}
            className="relative z-10 rounded-md px-2 py-1 text-xs font-bold tracking-wide"
            style={segmentStyle(aiPanelOpen)}
          >
            <span style={{ visibility: aiPanelOpen ? "hidden" : "visible", paddingLeft: "2px" }}>AI MODE</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export default function TitleBar() {
  const { folderPath } = useWorkspace();
  const {
    sidebarOpen, terminalOpen, aiPanelOpen,
    onToggleSidebar, onToggleTerminal, onToggleAiPanel, onSetAiPanel,
    onOpenFolder, onOpenFile, onNewFile, onNewWindow, onOpenPalette, onOpenSettings,
    dirtyCount, hasActiveTab, hasFolderOpen,
    onSave, onSaveAs, onSaveAll, onCloseEditor, onCloseFolder,
    onEditorUndo, onEditorRedo, onEditorPrevFile, onEditorNextFile, onEditorCut, onEditorCopy, onEditorPaste, onEditorSelectAll, onEditorFind,
    onZoomIn, onZoomOut, onZoomReset,
    onNewTerminalTab, onClearTerminal, onKillTerminal,
    onStartDebugging, onStopDebugging, isDebugActive,
  } = useCommands();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const close = () => { setMenuOpen(false); setMenuAnchor(null); };
  const toggleMenu = () => {
    setMenuOpen(open => !open);
    setMenuAnchor(menuBtnRef.current);
  };
  const fileEntries: MenuEntry[] = [
    { type: 'item', label: 'New File',      shortcut: 'Ctrl+N',        onClick: onNewFile },
    { type: 'item', label: 'New Window',    shortcut: 'Ctrl+Shift+N',  onClick: onNewWindow },
    { type: 'separator' },
    { type: 'item', label: 'Open Folder…', shortcut: 'Ctrl+K Ctrl+O', onClick: onOpenFolder },
    { type: 'item', label: 'Open File…',   shortcut: 'Ctrl+O',        onClick: onOpenFile },
    { type: 'separator' },
    { type: 'item', label: 'Save',         shortcut: 'Ctrl+S',        disabled: !hasActiveTab, onClick: () => { close(); onSave?.(); } },
    { type: 'item', label: 'Save As…',     shortcut: 'Ctrl+Shift+S',  disabled: !hasActiveTab, onClick: () => { close(); onSaveAs?.(); } },
    { type: 'item', label: 'Save All',     shortcut: 'Ctrl+K S',      disabled: dirtyCount === 0, onClick: () => { close(); onSaveAll?.(); } },
    { type: 'separator' },
    { type: 'item', label: 'Close Editor', shortcut: 'Ctrl+W',        disabled: !hasActiveTab, onClick: () => { close(); onCloseEditor?.(); } },
    { type: 'item', label: 'Close Folder',                             disabled: !hasFolderOpen, onClick: () => { close(); onCloseFolder?.(); } },
    { type: 'separator' },
    { type: 'item', label: 'Exit',         shortcut: 'Alt+F4',        onClick: () => win.close() },
  ];

  const editEntries: MenuEntry[] = [
    { type: 'item', label: 'Undo',       shortcut: 'Ctrl+Z',  disabled: !hasActiveTab, onClick: () => { close(); onEditorUndo?.(); } },
    { type: 'item', label: 'Redo',       shortcut: 'Ctrl+Y',  disabled: !hasActiveTab, onClick: () => { close(); onEditorRedo?.(); } },
    { type: 'separator' },
    { type: 'item', label: 'Cut',        shortcut: 'Ctrl+X',  disabled: !hasActiveTab, onClick: () => { close(); onEditorCut?.(); } },
    { type: 'item', label: 'Copy',       shortcut: 'Ctrl+C',  disabled: !hasActiveTab, onClick: () => { close(); onEditorCopy?.(); } },
    { type: 'item', label: 'Paste',      shortcut: 'Ctrl+V',  disabled: !hasActiveTab, onClick: () => { close(); onEditorPaste?.(); } },
    { type: 'separator' },
    { type: 'item', label: 'Select All', shortcut: 'Ctrl+A',  disabled: !hasActiveTab, onClick: () => { close(); onEditorSelectAll?.(); } },
    { type: 'separator' },
    { type: 'item', label: 'Find',       shortcut: 'Ctrl+F',  disabled: !hasActiveTab, onClick: () => { close(); onEditorFind?.(); } },
    { type: 'item', label: 'Replace',    shortcut: 'Ctrl+H',  disabled: !hasActiveTab, onClick: () => { close(); onEditorFind?.(); } },
  ];

  const viewEntries: MenuEntry[] = [
    { type: 'item', label: 'Command Palette', shortcut: 'Ctrl+P', onClick: () => { close(); onOpenPalette(); } },
    { type: 'separator' },
    { type: 'item', label: sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar', onClick: () => { close(); onToggleSidebar(); } },
    { type: 'item', label: terminalOpen ? 'Hide Terminal' : 'Show Terminal', shortcut: 'Ctrl+`', onClick: () => { close(); onToggleTerminal(); } },
    { type: 'item', label: aiPanelOpen ? 'Hide AI Panel' : 'Show AI Panel', onClick: () => { close(); onToggleAiPanel(); } },
    { type: 'separator' },
    { type: 'item', label: 'Zoom In',    shortcut: 'Ctrl+=', onClick: () => { close(); onZoomIn?.(); } },
    { type: 'item', label: 'Zoom Out',   shortcut: 'Ctrl+-', onClick: () => { close(); onZoomOut?.(); } },
    { type: 'item', label: 'Reset Zoom', shortcut: 'Ctrl+0', onClick: () => { close(); onZoomReset?.(); } },
  ];

  const runEntries: MenuEntry[] = [
    { type: 'item', label: 'Start Debugging', shortcut: 'F5', disabled: isDebugActive, onClick: () => { close(); onStartDebugging(); } },
    { type: 'item', label: 'Stop Debugging',  shortcut: 'Shift+F5', disabled: !isDebugActive, onClick: () => { close(); onStopDebugging(); } },
  ];

  const terminalEntries: MenuEntry[] = [
    { type: 'item', label: terminalOpen ? 'Hide Terminal' : 'Show Terminal', shortcut: 'Ctrl+`', onClick: () => { close(); onToggleTerminal(); } },
    { type: 'separator' },
    { type: 'item', label: 'New Terminal Tab', onClick: () => { close(); onNewTerminalTab?.(); } },
    { type: 'item', label: 'Clear Terminal',   disabled: !terminalOpen, onClick: () => { close(); onClearTerminal?.(); } },
    { type: 'item', label: 'Kill Terminal',    disabled: !terminalOpen, onClick: () => { close(); onKillTerminal?.(); } },
  ];

  const helpEntries: MenuEntry[] = [
    { type: 'item', label: 'Keyboard Shortcuts', shortcut: 'Ctrl+P', onClick: () => { close(); onOpenPalette(); } },
  ];

  const projectName = folderPath
    ? (folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath)
    : 'No project';

  // Single merged menu anchored to the IDE button.
  const combinedEntries: MenuEntry[] = [
    ...fileEntries,
    { type: 'separator' },
    ...editEntries,
    { type: 'separator' },
    ...viewEntries,
    { type: 'separator' },
    ...runEntries,
    { type: 'separator' },
    ...terminalEntries,
    { type: 'separator' },
    ...helpEntries,
  ];

  return (
    <div
      className="relative z-10 flex items-center h-9 shrink-0 select-none rounded-md"
      style={{
        backgroundColor: "var(--origin-bg-titlebar)",
      }}
    >
      {/* Left — IDE logo + mode toggle + project name */}
      <div className="flex items-center gap-1 px-2 z-10 shrink-0">
        <ModeSwitch aiPanelOpen={aiPanelOpen} onSetAiPanel={onSetAiPanel} />

        {/* Divider */}
        <span className="mx-1 h-4 w-px" style={{ backgroundColor: "var(--origin-border-default)" }} />

        {/* Project selector */}
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-1.5 px-2 py-1 rounded transition-colors text-xs"
          style={{ color: "var(--origin-fg-default)", backgroundColor: "transparent" }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
          title="Switch project"
        >
          <span className="font-medium">{projectName}</span>
          <Icon icon="lucide:chevron-down" width={12} style={{ color: "var(--origin-fg-subtle)" }} />
        </button>
      </div>

      {/* Center — Search */}
      <div className="flex-1 flex justify-start pl-2">
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 px-3 py-1 rounded text-xs transition-colors"
          style={{ color: "var(--origin-fg-muted)", backgroundColor: "var(--origin-bg-hover)" }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--origin-fg-default)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
          title="Search (Ctrl+P)"
        >
          <Icon icon="lucide:search" width={13} />
          <span>Search</span>
        </button>
      </div>

      {/* Right — history + layout toggles + menu + window controls */}
      <div className="flex items-center gap-0.5 pr-1 z-10 shrink-0" data-tauri-drag-region>
        <div data-no-drag>
          <IconBtn label="Previous File" tooltip="Previous File" onClick={() => onEditorPrevFile?.()}>
            <Icon icon="lucide:arrow-left" width={15} />
          </IconBtn>
        </div>
        <div data-no-drag>
          <IconBtn label="Next File" tooltip="Next File" onClick={() => onEditorNextFile?.()}>
            <Icon icon="lucide:arrow-right" width={15} />
          </IconBtn>
        </div>
        <div data-no-drag>
          <IconBtn label="Toggle Sidebar" tooltip="Toggle Sidebar" active={sidebarOpen} onClick={onToggleSidebar}>
            <Icon icon="lucide:panel-left" width={15} />
          </IconBtn>
        </div>
        <div data-no-drag>
          <IconBtn label="Toggle Bottom Panel" tooltip="Toggle Terminal" active={terminalOpen} onClick={onToggleTerminal}>
            <Icon icon="lucide:panel-bottom" width={15} />
          </IconBtn>
        </div>
        <div data-no-drag>
          <IconBtn label="Toggle AI Panel" tooltip="Toggle AI Panel" active={aiPanelOpen} onClick={onToggleAiPanel}>
            <Icon icon="lucide:panel-right" width={15} />
          </IconBtn>
        </div>

        <div className="mx-1 h-4 w-px" style={{ backgroundColor: "var(--origin-border-default)" }} />

        {/* Settings */}
        <div data-no-drag>
          <IconBtn label="Settings" tooltip="Settings (Ctrl+,)" onClick={onOpenSettings}>
            <Icon icon="lucide:settings" width={15} />
          </IconBtn>
        </div>

        {/* Menu dédié (ex-bouton IDE) — à l'extrémité droite */}
        <div data-no-drag className="relative">
          <button
            ref={menuBtnRef}
            onClick={() => toggleMenu()}
            aria-label="Menu"
            className="p-1.5 rounded transition-colors"
            style={{
              color: menuOpen ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
              backgroundColor: menuOpen ? "var(--origin-bg-hover)" : "transparent",
            }}
            onMouseEnter={e => { if (!menuOpen) { e.currentTarget.style.color = "var(--origin-fg-default)"; e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; } }}
            onMouseLeave={e => { if (!menuOpen) { e.currentTarget.style.color = "var(--origin-fg-muted)"; e.currentTarget.style.backgroundColor = "transparent"; } }}
          >
            <Icon icon="lucide:menu" width={15} />
          </button>
          {menuOpen && menuAnchor && (
            <DropdownMenu entries={combinedEntries} anchorEl={menuAnchor} onClose={close} />
          )}
        </div>

        <div className="mx-1 h-4 w-px" style={{ backgroundColor: "var(--origin-border-default)" }} />
        <button
          data-no-drag
          aria-label="Minimize"
          className="p-2 transition-colors"
          style={{ color: "var(--origin-fg-muted)" }}
          onClick={() => win.minimize()}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; e.currentTarget.style.color = "var(--origin-fg-default)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
        >
          <Icon icon="lucide:minus" width={15} />
        </button>
        <button
          data-no-drag
          aria-label="Maximize"
          className="p-2 transition-colors"
          style={{ color: "var(--origin-fg-muted)" }}
          onClick={() => win.toggleMaximize()}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; e.currentTarget.style.color = "var(--origin-fg-default)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
        >
          <Icon icon="lucide:square" width={13} />
        </button>
        <button
          data-no-drag
          aria-label="Close"
          className="p-2 transition-colors"
          style={{ color: "var(--origin-fg-muted)" }}
          onClick={() => win.close()}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#e81123"; e.currentTarget.style.color = "#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--origin-fg-muted)"; }}
        >
          <Icon icon="lucide:x" width={15} />
        </button>
      </div>
    </div>
  );
}
