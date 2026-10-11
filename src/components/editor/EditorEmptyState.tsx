import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { getSetting, type RecentProject } from "../../lib/settings";

interface Props {
  onOpenFolder?: () => void;
  onOpenProject?: (path: string) => void;
}

// Illustration de la page d'accueil. Les entrées non implémentées sont
// volontairement inertes (affichage seul, pas d'action).
const actions = [
  { id: "open-folder",   label: "Open Folder",          icon: "lucide:folder",        implemented: true },
  { id: "new-project",   label: "Create a new project", icon: "lucide:file-plus-2",   implemented: false },
  { id: "clone-repo",    label: "Clone Git Repository", icon: "lucide:git-fork",      implemented: false },
  { id: "remote-host",   label: "Connect Remote Host",  icon: "lucide:monitor",       implemented: false },
];

function shortPath(path: string): string {
  const home = "~";
  return path.startsWith("/Users/") || path.startsWith("/home/")
    ? home + path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "")
    : path;
}

export default function EditorEmptyState({ onOpenFolder, onOpenProject }: Props) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    getSetting("recent.projects").then(list => {
      if (alive) setRecents(list ?? []);
    }).catch(() => { /* store indisponible (hors Tauri) : section vide */ });
    return () => { alive = false; };
  }, []);

  const handleAction = (id: string, implemented: boolean) => {
    if (!implemented) return;
    if (id === "open-folder") onOpenFolder?.();
  };

  const visibleRecents = showAll ? recents : recents.slice(0, 5);

  return (
    <div
      style={{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", backgroundColor: "var(--origin-bg-editor)", overflow: "auto",
      }}
    >
      <div style={{ width: "100%", maxWidth: "360px", display: "flex", flexDirection: "column" }}>
        {/* Actions principales */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {actions.map(a => (
            <button
              key={a.id}
              onClick={() => handleAction(a.id, a.implemented)}
              disabled={!a.implemented}
              style={{
                display: "flex", alignItems: "center", gap: "12px",
                width: "100%", padding: "10px 14px", textAlign: "left",
                background: "var(--origin-bg-hover)",
                border: "1px solid var(--origin-border-default)",
                borderRadius: "6px",
                color: "var(--origin-fg-muted)",
                fontSize: "13px",
                cursor: a.implemented ? "pointer" : "default",
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={e => {
                if (!a.implemented) return;
                e.currentTarget.style.background = "var(--origin-bg-active)";
                e.currentTarget.style.color = "var(--origin-fg-default)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "var(--origin-bg-hover)";
                e.currentTarget.style.color = "var(--origin-fg-muted)";
              }}
            >
              <Icon icon={a.icon} width={15} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>

        {/* Projets récents */}
        {recents.length > 0 && (
          <div style={{ marginTop: "28px", display: "flex", flexDirection: "column" }}>
            {visibleRecents.map(p => (
              <button
                key={p.path}
                onClick={() => onOpenProject?.(p.path)}
                title={p.path}
                style={{
                  display: "flex", alignItems: "center", gap: "10px",
                  width: "100%", padding: "6px 8px", textAlign: "left",
                  background: "transparent", border: "none", borderRadius: "5px",
                  cursor: "pointer", fontSize: "13px",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <Icon icon="lucide:folder" width={15} style={{ color: "#eab308", flexShrink: 0 }} />
                <span style={{ fontWeight: 600, color: "var(--origin-fg-default)", flexShrink: 0 }}>{p.name}</span>
                <span
                  style={{
                    color: "var(--origin-fg-subtle)", fontSize: "12px", marginLeft: "auto",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "180px",
                    direction: "rtl", textAlign: "right",
                  }}
                >
                  {shortPath(p.path)}
                </span>
              </button>
            ))}
            {recents.length > 5 && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                style={{
                  marginTop: "6px", alignSelf: "center", padding: "4px 10px",
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "var(--origin-fg-muted)", fontSize: "12px",
                }}
              >
                More
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
