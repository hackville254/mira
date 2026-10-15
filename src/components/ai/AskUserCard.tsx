import { useState } from "react";
import { HelpCircle, Check } from "lucide-react";

// ── Carte « ask_user » ───────────────────────────────────────────────────────
//
// L'agent pose une question à laquelle seul l'utilisateur peut répondre. Le
// tour reste EN PAUSE tant que la carte n'a pas reçu de réponse : les options
// sont cliquables, et une saisie libre est proposée par défaut.

export default function AskUserCard({
  question,
  options,
  allowFreeform,
  answered,
  onAnswer,
}: {
  question: string;
  options: string[];
  allowFreeform: boolean;
  answered?: string;
  onAnswer: (answer: string) => void;
}) {
  const [freeform, setFreeform] = useState("");

  // Réponse déjà donnée (après re-render / reload de session) : état figé.
  if (answered !== undefined) {
    return (
      <div style={cardStyle}>
        <div style={headerStyle}>
          <Check size={11} style={{ color: "var(--origin-semantic-success)", flexShrink: 0 }} />
          <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--origin-fg-muted)" }}>Answered</span>
        </div>
        <div style={{ padding: "8px 10px" }}>
          <div style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "6px" }}>{question}</div>
          <div style={{ fontSize: "12px", color: "var(--origin-fg-default)", fontWeight: 500 }}>{answered || "(no answer)"}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, border: "1px solid color-mix(in srgb, var(--origin-accent-blue) 45%, transparent)", backgroundColor: "color-mix(in srgb, var(--origin-accent-blue) 7%, transparent)" }}>
      <div style={headerStyle}>
        <HelpCircle size={11} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />
        <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--origin-accent-blue)" }}>Question</span>
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: "12px", color: "var(--origin-fg-default)", lineHeight: 1.55, marginBottom: "8px" }}>
          {question}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswer(opt)}
              style={{
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                cursor: "pointer",
                background: "var(--origin-bg-base)",
                border: "1px solid var(--origin-border-default)",
                color: "var(--origin-fg-default)",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; e.currentTarget.style.borderColor = "var(--origin-accent-blue)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "var(--origin-bg-base)"; e.currentTarget.style.borderColor = "var(--origin-border-default)"; }}
            >
              {opt}
            </button>
          ))}
        </div>
        {allowFreeform && (
          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
            <input
              value={freeform}
              onChange={e => setFreeform(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && freeform.trim()) onAnswer(freeform.trim()); }}
              placeholder="Type your own answer…"
              style={{
                flex: 1, minWidth: 0, padding: "5px 8px", borderRadius: "6px", fontSize: "12px",
                background: "var(--origin-bg-base)", border: "1px solid var(--origin-border-default)",
                color: "var(--origin-fg-default)", outline: "none",
              }}
            />
            <button
              onClick={() => { if (freeform.trim()) onAnswer(freeform.trim()); }}
              disabled={!freeform.trim()}
              style={{
                padding: "5px 12px", borderRadius: "6px", fontSize: "12px", cursor: freeform.trim() ? "pointer" : "default",
                background: "var(--origin-accent-blue)", border: "1px solid transparent",
                color: "#fff", opacity: freeform.trim() ? 1 : 0.5,
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

const cardStyle: React.CSSProperties = {
  margin: "4px 0",
  borderRadius: "6px",
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-editor)",
  fontSize: "12px",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "5px", padding: "6px 10px",
  borderBottom: "1px solid var(--origin-border-default)",
};
