// ── Indicateur d'usage du contexte ────────────────────────────────────────────
//
// Affiche, de façon discrète, la part du budget de tokens consommée par
// l'historique courant — comme la jauge de contexte de Cursor/Trae. Le seuil de
// compaction (80 %) change la couleur pour prévenir l'utilisateur qu'une
// réduction d'historique va bientôt se produire.
//
// Un clic sur la jauge ouvre un menu compact (façon Trae) : « Context Usage
// Rate », le pourcentage du budget, et un bouton « Compact » qui déclenche la
// compaction MANUELLE de l'historique côté parent.

import { useEffect, useRef, useState } from "react";
import { COMPACTION_THRESHOLD, CRITICAL_THRESHOLD } from "../../lib/agent/tokenBudget";

export default function ContextUsageBar({
  used,
  budget,
  onCompact,
}: {
  used: number;
  budget: number;
  /** Fourni uniquement sur le dernier message : ouvre le menu de compaction. */
  onCompact?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // Fermeture au clic extérieur ou sur Échap — sans piéger le focus.
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (budget <= 0) return null;
  const ratio = Math.min(1, Math.max(0, used / budget));
  const pct = Math.round(ratio * 100);

  // Vert < 80 %, orange à l'approche de la compaction, rouge au-delà du critique.
  const color = ratio >= CRITICAL_THRESHOLD
    ? "var(--origin-semantic-error, #ef4444)"
    : ratio >= COMPACTION_THRESHOLD
      ? "#d9822b"
      : "var(--origin-fg-subtle)";

  // Anneau circulaire type Cursor : un arc proportionnel au ratio, tracé via un
  // cercle SVG (dasharray = circonférence). L'arc démarre en haut (-90°) et
  // tourne dans le sens horaire.
  const size = 15;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;

  // Budget affiché en « K » (128K, 200K…) pour rester compact.
  const budgetLabel = budget >= 1000 ? `${Math.round(budget / 1000)}K` : String(budget);

  const canCompact = !!onCompact;
  const label = `${used.toLocaleString()} / ${budget.toLocaleString()} tokens de contexte utilisés`;

  const inner = (
    <>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0, transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="var(--origin-border-default)" strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - ratio)}
          style={{ transition: "stroke-dashoffset .2s, stroke .2s" }}
        />
      </svg>
      <span style={{ color, fontSize: "12px" }}>{pct}%</span>
    </>
  );

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      {canCompact ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            background: open ? "var(--origin-bg-hover)" : "none",
            border: "none", padding: "2px 5px", borderRadius: "5px",
            cursor: "pointer", transition: "background-color .12s",
          }}
        >
          {inner}
        </button>
      ) : (
        <span title={label} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "2px 5px" }}>
          {inner}
        </span>
      )}

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", bottom: "calc(100% + 8px)", right: 0,
            minWidth: "188px", zIndex: 40,
            background: "var(--origin-bg-elevated, var(--origin-bg-panel, #1f1f23))",
            border: "1px solid var(--origin-border-default)",
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            padding: "10px 12px 12px",
            color: "var(--origin-fg-default)",
          }}
        >
          <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", marginBottom: "8px" }}>
            Context Usage Rate
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "10px" }}>
            <span style={{ fontSize: "15px", fontWeight: 600 }}>{pct}%</span>
            <span style={{ fontSize: "13px", color: "var(--origin-fg-subtle)" }}>of {budgetLabel}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCompact?.();
            }}
            style={{
              display: "block", width: "100%",
              padding: "6px 10px",
              background: "var(--origin-bg-hover)",
              border: "1px solid var(--origin-border-default)",
              borderRadius: "6px",
              color: "var(--origin-fg-default)",
              fontSize: "13px", fontWeight: 500,
              cursor: "pointer", textAlign: "center",
            }}
          >
            Compact
          </button>
        </div>
      )}
    </span>
  );
}
