import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Info, Infinity as InfinityIcon, Check } from "lucide-react";
import { PROVIDERS } from "./providers";
import { useTheme } from "../../themes/ThemeContext";

interface Props {
  anchorEl: HTMLElement | null;
  selectedModelId: string;
  onSelect: (providerId: string, modelId: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 260;
const MENU_MAX_HEIGHT = 440;

// ── Main dropdown (model list) ────────────────────────────────────────────────

export default function PreferencesDropdown({ anchorEl, selectedModelId, onSelect, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const { theme } = useTheme();
  const isDark = theme.type === "dark";

  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    let top = spaceBelow < MENU_MAX_HEIGHT + 10 ? r.top - MENU_MAX_HEIGHT - 6 : r.bottom + 6;
    top = Math.max(8, Math.min(top, window.innerHeight - MENU_MAX_HEIGHT - 8));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position portal from measured anchor rect
    setPos({ top, left: Math.max(8, r.right - MENU_WIDTH) });
  }, [anchorEl]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  if (!anchorEl) return null;

  const hoverOn = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; };
  const hoverOff = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = "transparent"; };

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH, maxHeight: MENU_MAX_HEIGHT,
        display: "flex", flexDirection: "column",
        background: "color-mix(in srgb, var(--origin-bg-base) 90%, transparent)",
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        border: "1px solid var(--origin-border-default)", borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)", overflow: "hidden", zIndex: 9999,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px 6px", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--origin-fg-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Built-in Models
        </span>
        <Info size={12} style={{ color: "var(--origin-fg-subtle)" }} />
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 6px" }}>
        {/* Auto Mode — UI only */}
        <button
          onClick={onClose}
          onMouseEnter={hoverOn} onMouseLeave={hoverOff}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px", borderRadius: 7, border: "none", cursor: "pointer", background: "transparent", textAlign: "left", transition: "background 0.1s" }}
        >
          <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", color: "#e5e5e5", flexShrink: 0 }}>
            <InfinityIcon size={18} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--origin-fg-default)" }}>Auto Mode</span>
        </button>

        {PROVIDERS.flatMap(p => p.models.map(m => ({ provider: p, model: m }))).map(({ provider, model }) => {
          const isSelected = model.id === selectedModelId;
          const icon = model.icon ?? provider.icon;
          const invert = model.iconInvert ?? provider.invert;
          return (
            <button
              key={`${provider.id}/${model.id}`}
              onMouseDown={(e) => { e.stopPropagation(); onSelect(provider.id, model.id); onClose(); }}
              onMouseEnter={hoverOn} onMouseLeave={hoverOff}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px", borderRadius: 7, border: "none", cursor: "pointer", background: "transparent", textAlign: "left", transition: "background 0.1s" }}
            >
              <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {icon
                  ? <img src={icon} alt={model.name} style={{ width: 18, height: 18, objectFit: "contain", filter: invert ? (isDark ? "brightness(0) invert(1)" : "none") : "none" }} />
                  : <span style={{ fontSize: 9, fontWeight: 700, color: "var(--origin-fg-muted)" }}>{provider.initial}</span>
                }
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: isSelected ? 600 : 400, color: "var(--origin-fg-default)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {model.name}
              </span>
              {isSelected && <Check size={15} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />}
            </button>
          );
        })}

        {/* Add Model — after all models, inside scroll (UI only) */}
        <div style={{ borderTop: "1px solid var(--origin-border-default)", marginTop: 6, paddingTop: 6 }}>
          <button
            onClick={onClose}
            onMouseEnter={hoverOn} onMouseLeave={hoverOff}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px", borderRadius: 7, border: "none", cursor: "pointer", background: "transparent", fontSize: 13, fontWeight: 500, color: "var(--origin-fg-muted)", transition: "background 0.1s" }}
          >
            Add Model
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
