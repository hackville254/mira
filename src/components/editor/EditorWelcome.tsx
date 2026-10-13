import logoCode from "../../assets/logo-code.svg";
import { isMac } from "../../lib/platform";

// Chaque touche est rendue dans sa propre « kbd » : on décompose le libellé natif.
// Sur macOS, les symboles Apple se touchent (« ⌘U ») ; ailleurs, « Ctrl+U ».
function keysOf(shortcut: string): string[] {
  return isMac() ? shortcut.split("") : shortcut.split("+");
}

const rows = [
  { label: "Chat With AI",            shortcut: keysOf("⌘U") },
  { label: "Edit Code Inline With AI", shortcut: keysOf("⌘I") },
];

// Affiché quand un projet est ouvert mais qu'aucun fichier n'est en cours d'édition.
export default function EditorWelcome() {
  return (
    <div
      style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        backgroundColor: "var(--origin-bg-editor)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", width: "100%", maxWidth: "320px", padding: "0 24px" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "18px" }}>
          <img src={logoCode} alt="Origin" style={{ height: "64px", width: "auto" }} />
        </div>
        {rows.map(r => (
          <div
            key={r.label}
            style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 16px" }}
          >
            <span style={{ fontSize: "14px", color: "var(--origin-fg-muted)" }}>{r.label}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
              {r.shortcut.map(k => (
                <kbd
                  key={k}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    minWidth: "22px", height: "22px", padding: "0 5px",
                    borderRadius: "5px", fontSize: "12px", fontWeight: 500,
                    color: "var(--origin-fg-muted)", backgroundColor: "var(--origin-bg-hover)",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {k}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
