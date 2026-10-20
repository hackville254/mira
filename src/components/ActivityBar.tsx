import { Icon } from "@iconify/react";
import { Tooltip } from "./ui/Tooltip";

const items = [
  { id: "explorer",   icon: "lucide:files",          label: "Explorer" },
  { id: "search",     icon: "lucide:search",         label: "Search" },
  { id: "sourcetree", icon: "lucide:git-branch",     label: "Source Control" },
  { id: "outline",    icon: "lucide:list-tree",      label: "Outline" },
  { id: "debug",      icon: "lucide:bug",            label: "Debug" },
];

interface ActivityBarProps {
  active: string;
  onSelect: (id: string) => void;
}

export default function ActivityBar({ active, onSelect }: ActivityBarProps) {
  return (
    <div
      className="flex flex-col items-center gap-1 py-2 shrink-0"
      style={{
        width: 44,
        backgroundColor: "var(--origin-bg-sidebar)",
        borderRight: "1px solid var(--origin-border-strong)",
      }}
    >
      {items.map(({ id, icon, label }) => {
        const isActive = active === id;
        return (
          <Tooltip key={id} content={label} side="right">
            <button
              onClick={() => onSelect(id)}
              className="relative p-2 rounded transition-colors"
              style={{
                color: isActive ? "var(--origin-fg-default)" : "var(--origin-fg-subtle)",
                backgroundColor: isActive ? "var(--origin-bg-active)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--origin-fg-muted)";
                if (!isActive) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = isActive ? "var(--origin-fg-default)" : "var(--origin-fg-subtle)";
                e.currentTarget.style.backgroundColor = isActive ? "var(--origin-bg-active)" : "transparent";
              }}
              aria-label={label}
            >
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r"
                  style={{ width: 2, height: 18, backgroundColor: "var(--origin-fg-default)" }}
                />
              )}
              <Icon icon={icon} width={18} />
            </button>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      <Tooltip content="More" side="right">
        <button
          className="p-2 rounded transition-colors"
          style={{ color: "var(--origin-fg-subtle)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--origin-fg-muted)";
            e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--origin-fg-subtle)";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
          aria-label="More"
        >
          <Icon icon="lucide:more-horizontal" width={18} />
        </button>
      </Tooltip>
    </div>
  );
}
