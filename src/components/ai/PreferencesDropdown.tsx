import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { loadCustomModels, subscribeCustomModels, type StoredCustomModel } from "../../lib/agent/customModels";
import { loadMiraModels, type MiraModel } from "../../lib/agent/miraModels";

interface Props {
  /** Élément auquel le menu s'ancre (le bouton du sélecteur de modèle). */
  anchorEl: HTMLElement | null;
  /** Clé du modèle actif (clé Mira ou clé custom) */
  selectedModelId: string;
  onSelect: (modelKey: string, modelId: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 260;
const MENU_MAX_HEIGHT = 340;

/** Entrée unifiée du sélecteur : un modèle Mira ou un modèle du client. */
interface Row {
  key: string;
  displayName: string;
  subtitle: string;
  /** Modèle fourni par Mira (fourni par l'éditeur). */
  fromMira: boolean;
}

// ── Main dropdown (model list) ────────────────────────────────────────────────

export default function PreferencesDropdown({ anchorEl, selectedModelId, onSelect, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<StoredCustomModel[]>(() => loadCustomModels());
  /** Modèles fournis par Mira (catalogue de l'éditeur), chargés une fois. */
  const [miraModels, setMiraModels] = useState<MiraModel[]>([]);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Source unique de vérité : le magasin de modèles, rafraîchi à chaque changement.
  useEffect(() => subscribeCustomModels(() => setModels(loadCustomModels())), []);

  useEffect(() => {
    let alive = true;
    loadMiraModels().then(list => { if (alive) setMiraModels(list); });
    return () => { alive = false; };
  }, []);

  // Position calculée depuis le bouton : le menu est rendu dans `document.body`
  // (portal) pour échapper au `overflow: hidden` du panneau de chat, qui sinon
  // le clipperait et le coincerait sous le contenu voisin.
  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- position portal from measured anchor rect
    setPos({ left: r.left, top: r.top - 6 });
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

  const rows: Row[] = [
    ...miraModels.map((m): Row => ({
      key: m.key,
      displayName: m.displayName,
      subtitle: m.modelId,
      fromMira: true,
    })),
    ...models.map((m): Row => ({
      key: m.key,
      displayName: m.displayName,
      subtitle: m.modelId,
      fromMira: false,
    })),
  ];

  const hoverOn = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; };
  const hoverOff = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = "transparent"; };

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        transform: "translateY(-100%)",
        width: MENU_WIDTH,
        maxWidth: "calc(100vw - 24px)",
        maxHeight: MENU_MAX_HEIGHT,
        display: "flex", flexDirection: "column",
        background: "color-mix(in srgb, var(--origin-bg-base) 92%, transparent)",
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        border: "1px solid var(--origin-border-default)", borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)", overflow: "hidden", zIndex: 9999,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--origin-fg-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Models
        </span>
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 6px" }}>
        {rows.length === 0 && (
          <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--origin-fg-subtle)", lineHeight: 1.5 }}>
            No model available yet. Add one to get started.
          </div>
        )}

        {rows.map((row) => {
          const isSelected = row.key === selectedModelId;
          // Sous-titre masqué quand il duplique le titre (catalogue cloud qui
          // ne fournit pas de libellé lisible) : on garde une ligne, épurée.
          const showSubtitle = row.subtitle.trim() !== "" && row.subtitle !== row.displayName;
          return (
            <button
              key={row.key}
              onMouseDown={(e) => { e.stopPropagation(); onSelect(row.key, row.subtitle); onClose(); }}
              onMouseEnter={hoverOn} onMouseLeave={hoverOff}
              title={showSubtitle ? `${row.displayName} · ${row.subtitle}` : row.displayName}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 7, border: "none", cursor: "pointer", background: "transparent", textAlign: "left", transition: "background 0.1s" }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontSize: 13, fontWeight: isSelected ? 600 : 400, color: "var(--origin-fg-default)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.displayName}
                </span>
                {showSubtitle && (
                  <span style={{ fontSize: 11, color: "var(--origin-fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.subtitle}
                  </span>
                )}
              </span>
              {row.fromMira && (
                <span style={{
                  flexShrink: 0, fontSize: 9, fontWeight: 600, letterSpacing: "0.03em",
                  padding: "1px 5px", borderRadius: 4,
                  color: "var(--origin-accent-blue, #3b82f6)",
                  background: "color-mix(in srgb, var(--origin-accent-blue, #3b82f6) 15%, transparent)",
                }}>
                  MIRA
                </span>
              )}
              {isSelected && <Check size={15} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />}
            </button>
          );
        })}

        {/* Add Model — ouvre les Settings sur la section Models */}
        <div style={{ borderTop: "1px solid var(--origin-border-default)", marginTop: 6, paddingTop: 6 }}>
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("origin-open-settings", { detail: { section: "models" } }));
              onClose();
            }}
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
