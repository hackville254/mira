import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { getSetting, type RecentProject } from "../../lib/settings";

interface Props {
  anchorEl: HTMLElement | null;
  /** Dossier actuellement ouvert (coche verte sur l'entrée correspondante). */
  currentPath: string | null;
  onClose: () => void;
  onOpenFolder: () => void;
  onCloneRepo: () => void;
  onConnectRemote: () => void;
  onOpenProject: (path: string) => void;
}

/** Palette de pastilles : couleur stable dérivée du nom (hachage simple). */
const PASTEL = [
  { bg: "#8b5cf6", fg: "#ffffff" }, // violet
  { bg: "#84cc16", fg: "#1a2e05" }, // lime
  { bg: "#64748b", fg: "#ffffff" }, // ardoise
  { bg: "#eab308", fg: "#1c1917" }, // ambre
  { bg: "#38bdf8", fg: "#082f49" }, // ciel
  { bg: "#34d399", fg: "#022c22" }, // émeraude
  { bg: "#f472b6", fg: "#500724" }, // rose
  { bg: "#fb923c", fg: "#431407" }, // orange
];

function branchColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PASTEL[h % PASTEL.length];
}

/** Initiales affichées dans la pastille (2 lettres, ou 1 si un seul mot). */
function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Remplace le préfixe home par `~` pour un affichage compact. */
function shortPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "~");
}

export default function ProjectMenu({
  anchorEl,
  currentPath,
  onClose,
  onOpenFolder,
  onCloneRepo,
  onConnectRemote,
  onOpenProject,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [recents, setRecents] = useState<RecentProject[]>([]);

  useEffect(() => {
    let alive = true;
    getSetting("recent.projects")
      .then(list => { if (alive) setRecents(list ?? []); })
      .catch(() => { /* store indisponible (hors Tauri) : section vide */ });
    return () => { alive = false; };
  }, []);

  // Positionne le portail sous l'ancre puis le garde dans le viewport.
  useEffect(() => {
    const el = menuRef.current;
    if (!anchorEl || !el) return;
    const r = anchorEl.getBoundingClientRect();
    const margin = 8;
    const maxH = window.innerHeight - margin * 2;
    el.style.maxHeight = `${maxH}px`;
    const h = Math.min(el.scrollHeight, maxH);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - h);
    }
    let left = r.left;
    if (left + el.offsetWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - el.offsetWidth);
    }
    setPos({ top, left });
  }, [anchorEl, recents.length]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!anchorEl) return null;

  const actions = [
    { id: "open-folder",  label: "Open Folder",          icon: "lucide:folder",   run: onOpenFolder },
    { id: "clone-repo",   label: "Clone Git Repository", icon: "lucide:git-fork", run: onCloneRepo },
    { id: "remote-host",  label: "Connect Remote Host",  icon: "lucide:monitor",  run: onConnectRemote },
  ];

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: "360px",
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
        background: "var(--origin-bg-panel)",
        border: "1px solid var(--origin-border-default)",
        borderRadius: "8px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        padding: "6px",
        zIndex: 9999,
      }}
    >
      {/* Actions principales */}
      {actions.map(a => (
        <MenuRow
          key={a.id}
          onClick={() => { onClose(); a.run(); }}
        >
          <Icon icon={a.icon} width={16} style={{ color: "var(--origin-fg-muted)", flexShrink: 0 }} />
          <span style={{ fontSize: "14px", color: "var(--origin-fg-default)" }}>{a.label}</span>
        </MenuRow>
      ))}

      <div
        style={{
          height: "1px",
          background: "var(--origin-border-default)",
          margin: "6px 2px",
        }}
      />

      {/* Section « Recent » */}
      <div
        style={{
          padding: "4px 10px 6px",
          fontSize: "12px",
          color: "var(--origin-fg-subtle)",
        }}
      >
        Recent
      </div>

      {recents.length === 0 ? (
        <div style={{ padding: "6px 10px 10px", fontSize: "12px", color: "var(--origin-fg-subtle)" }}>
          No recent projects
        </div>
      ) : (
        recents.map(p => {
          const isCurrent = !!currentPath && p.path === currentPath;
          const color = branchColor(p.name);
          return (
            <MenuRow
              key={p.path}
              title={p.path}
              onClick={() => { onClose(); onOpenProject(p.path); }}
            >
              <span
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "6px",
                  background: color.bg,
                  color: color.fg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initials(p.name)}
              </span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--origin-fg-default)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.name}
                </span>
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--origin-fg-subtle)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {shortPath(p.path)}
                </span>
              </span>
              {isCurrent && (
                <Icon
                  icon="lucide:check"
                  width={16}
                  style={{ color: "#22c55e", flexShrink: 0 }}
                />
              )}
            </MenuRow>
          );
        })
      )}
    </div>,
    document.body,
  );
}

function MenuRow({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "6px 10px",
        borderRadius: "6px",
        border: "none",
        cursor: "pointer",
        background: hover ? "var(--origin-bg-hover)" : "transparent",
        fontFamily: "inherit",
        textAlign: "left",
        transition: "background 0.1s",
      }}
    >
      {children}
    </button>
  );
}
