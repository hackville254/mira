// ── Indicateur d'usage du contexte ────────────────────────────────────────────
//
// Affiche, de façon discrète, la part du budget de tokens consommée par
// l'historique courant — comme la jauge de contexte de Cursor/Trae. Le seuil de
// compaction (80 %) change la couleur pour prévenir l'utilisateur qu'une
// réduction d'historique va bientôt se produire.

import { COMPACTION_THRESHOLD, CRITICAL_THRESHOLD } from "../../lib/agent/tokenBudget";

export default function ContextUsageBar({ used, budget }: { used: number; budget: number }) {
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

  return (
    <span
      title={`${used.toLocaleString()} / ${budget.toLocaleString()} tokens de contexte utilisés`}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
    >
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
    </span>
  );
}
