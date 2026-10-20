import { useState } from "react";
import { Icon } from "@iconify/react";

// ── Question de l'agent, dockée au-dessus de l'input (style Trae) ─────────────
//
// Quand l'agent a besoin d'une décision, il pose une question et le run se met
// EN PAUSE. Plutôt que d'afficher la question loin dans le fil (hors du regard
// pendant que l'utilisateur regarde l'input), on la remonte ici : juste
// au-dessus de la zone de saisie, là où l'attention se trouve.
//
// Présentation calquée sur Trae / les toolkits « Ask User » :
//  - une question courte ;
//  - 2–4 options concrètes, présentées comme des puces cliquables ;
//  - toujours une dernière entrée « Other » qui ouvre un champ de saisie libre
//    (l'utilisateur ne doit jamais être enfermé dans les choix proposés).
//
// Le composant est purement présentationnel : la réponse remonte via `onAnswer`.

export default function QuestionPrompt({
  question,
  options,
  onAnswer,
}: {
  question: string;
  /** Options proposées par l'agent (2–4 en pratique). */
  options: string[];
  /** Répond au tool `ask_user` (débloque le run en pause). */
  onAnswer: (answer: string) => void;
}) {
  // Mode « Other » : révèle un champ de saisie libre sous les options.
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const answer = (value: string, index: number | null) => {
    setSelected(index);
    onAnswer(value);
  };

  const submitOther = () => {
    const v = otherText.trim();
    if (v) onAnswer(v);
  };

  return (
    <div
      style={{
        margin: "0 0 6px",
        border: "1px solid color-mix(in srgb, var(--origin-accent-blue) 45%, transparent)",
        borderRadius: "8px",
        backgroundColor: "color-mix(in srgb, var(--origin-accent-blue) 6%, var(--origin-bg-base))",
        overflow: "hidden",
        fontSize: "12px",
      }}
    >
      {/* En-tête : « Question » + question en clair. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "7px", padding: "9px 12px 4px" }}>
        <Icon
          icon="lucide:help-circle"
          width={14}
          style={{ color: "var(--origin-accent-blue)", flexShrink: 0, marginTop: "1px" }}
        />
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--origin-accent-blue)", flexShrink: 0 }}>
          Question
        </span>
      </div>
      <div style={{ padding: "0 12px 8px", fontSize: "12px", lineHeight: 1.5, color: "var(--origin-fg-default)" }}>
        {question}
      </div>

      {/* Options : une puce par choix, cliquable au clavier comme à la souris. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 10px 8px" }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => answer(opt, i)}
            disabled={selected !== null}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              textAlign: "left", padding: "7px 10px", borderRadius: "6px",
              fontSize: "12px", cursor: selected !== null ? "default" : "pointer",
              background: selected === i ? "var(--origin-bg-active)" : "var(--origin-bg-base)",
              border: `1px solid ${selected === i ? "var(--origin-accent-blue)" : "var(--origin-border-default)"}`,
              color: "var(--origin-fg-default)",
              opacity: selected !== null && selected !== i ? 0.5 : 1,
              transition: "background 0.1s, border-color 0.1s",
            }}
            onMouseEnter={e => { if (selected === null) { e.currentTarget.style.background = "var(--origin-bg-hover)"; e.currentTarget.style.borderColor = "var(--origin-accent-blue)"; } }}
            onMouseLeave={e => { if (selected === null) { e.currentTarget.style.background = "var(--origin-bg-base)"; e.currentTarget.style.borderColor = "var(--origin-border-default)"; } }}
          >
            <span style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0,
              fontSize: "10px", fontFamily: "var(--font-mono)",
              background: "var(--origin-bg-active)", color: "var(--origin-fg-muted)",
            }}>
              {i + 1}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{opt}</span>
            {selected === i && (
              <Icon icon="lucide:check" width={13} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />
            )}
          </button>
        ))}

        {/* « Other » : toujours en dernier — échappatoire vers une réponse libre. */}
        {!otherOpen ? (
          <button
            onClick={() => setOtherOpen(true)}
            disabled={selected !== null}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              textAlign: "left", padding: "7px 10px", borderRadius: "6px",
              fontSize: "12px", cursor: selected !== null ? "default" : "pointer",
              background: "transparent",
              border: "1px dashed var(--origin-border-default)",
              color: "var(--origin-fg-muted)",
            }}
            onMouseEnter={e => { if (selected === null) { e.currentTarget.style.background = "var(--origin-bg-hover)"; e.currentTarget.style.color = "var(--origin-fg-default)"; } }}
            onMouseLeave={e => { if (selected === null) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--origin-fg-muted)"; } }}
          >
            <Icon icon="lucide:pencil-line" width={12} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>Other…</span>
          </button>
        ) : (
          <div style={{ display: "flex", gap: "6px" }}>
            <input
              autoFocus
              value={otherText}
              onChange={e => setOtherText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitOther(); }
                if (e.key === "Escape") { setOtherOpen(false); setOtherText(""); }
              }}
              placeholder="Type your own answer…"
              style={{
                flex: 1, minWidth: 0, padding: "6px 9px", borderRadius: "6px", fontSize: "12px",
                background: "var(--origin-bg-base)", border: "1px solid var(--origin-accent-blue)",
                color: "var(--origin-fg-default)", outline: "none",
              }}
            />
            <button
              onClick={submitOther}
              disabled={!otherText.trim()}
              style={{
                padding: "6px 12px", borderRadius: "6px", fontSize: "12px",
                cursor: otherText.trim() ? "pointer" : "default",
                background: "var(--origin-accent-blue)", border: "1px solid transparent",
                color: "#fff", opacity: otherText.trim() ? 1 : 0.5,
              }}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
