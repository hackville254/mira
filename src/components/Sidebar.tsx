import { useState, useRef, useCallback } from "react";
import ActivityBar from "./ActivityBar";
import FileTree from "./FileTree";
import SearchPanel from "./SearchPanel";
import SourceTreePanel from "./SourceTreePanel";
import DebugPanel from "./DebugPanel";
import ExtensionsPanel from "./ExtensionsPanel";
import OutlinePanel from "./outline/OutlinePanel";

const MIN_WIDTH = 180;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 240;

interface Props {
  onFileOpen: (path: string) => void;
  onFileOpenAtLine: (path: string, line: number, col: number) => void;
  onMarkdownPreview?: (path: string) => void;
  fileTreeKey?: number;
  defaultCollapsed?: boolean;
  activePath?: string;
  activeContent?: string;
  rootPath?: string;
  /** Recharge depuis le disque des fichiers modifiés à l'extérieur (replace in files). */
  onFilesChanged?: (paths: string[]) => void;
}

function ActivePanel({ id, onFileOpen, onFileOpenAtLine, onMarkdownPreview, fileTreeKey, activePath, activeContent, rootPath, onFilesChanged }: {
  id: string;
  onFileOpen: (path: string) => void;
  onFileOpenAtLine: (path: string, line: number, col: number) => void;
  onMarkdownPreview?: (path: string) => void;
  fileTreeKey?: number;
  activePath?: string;
  activeContent?: string;
  rootPath?: string;
  onFilesChanged?: (paths: string[]) => void;
}) {
  switch (id) {
    case "explorer":   return <FileTree onFileOpen={onFileOpen} onMarkdownPreview={onMarkdownPreview} refreshKey={fileTreeKey} />;
    case "search":     return <SearchPanel onFileOpenAtLine={onFileOpenAtLine} onFilesChanged={onFilesChanged} />;
    case "sourcetree": return <SourceTreePanel />;
    case "outline":    return <OutlinePanel activePath={activePath} content={activeContent} rootPath={rootPath} onFileOpenAtLine={onFileOpenAtLine} />;
    case "debug":      return <DebugPanel onFileOpenAtLine={onFileOpenAtLine} />;
    case "extensions": return <ExtensionsPanel />;
    default:           return null;
  }
}

export default function Sidebar({ onFileOpen, onFileOpenAtLine, onMarkdownPreview, fileTreeKey, defaultCollapsed = false, activePath, activeContent, rootPath, onFilesChanged }: Props) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [active, setActive] = useState("explorer");
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const isResizing = useRef(false);

  const handleSelect = useCallback((id: string) => {
    if (id === active) {
      // Same item clicked → toggle collapse (VSCode behaviour).
      setCollapsed((c) => !c);
    } else {
      setActive(id);
      setCollapsed(false);
    }
  }, [active]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;

    function onMouseMove(e: MouseEvent) {
      if (!isResizing.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX)));
    }

    function onMouseUp() {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div className="relative flex shrink-0 gap-1" style={{ width: collapsed ? 44 : width + 44 + 4 }}>
      <ActivityBar active={collapsed ? "" : active} onSelect={handleSelect} />
      <div
        className="relative flex flex-col shrink-0 overflow-hidden"
        style={{
          width: collapsed ? 0 : width,
          backgroundColor: "var(--origin-bg-sidebar)",
        }}
      >
      <ActivePanel
        id={active}
        onFileOpen={onFileOpen}
        onFileOpenAtLine={onFileOpenAtLine}
        onMarkdownPreview={onMarkdownPreview}
        fileTreeKey={fileTreeKey}
        activePath={activePath}
        activeContent={activeContent}
        rootPath={rootPath}
        onFilesChanged={onFilesChanged}
      />

      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize z-10"
        style={{ backgroundColor: "transparent" }}
        onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-border-default)"; }}
        onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
      />
      </div>
    </div>
  );
}
