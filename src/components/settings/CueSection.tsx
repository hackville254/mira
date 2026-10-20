import { useState, useEffect } from "react";
import {
  CUE_EVENT,
  isTabCueEnabled, setTabCueEnabled,
  isSmartImportEnabled, setSmartImportEnabled,
  isSmartRenameEnabled, setSmartRenameEnabled,
} from "../../lib/cuePrefs";

// ── CUE Section ──────────────────────────────────────────────────────────────
//
// Moteur CUE (context understanding engine). Trois capacités, activées par
// défaut, désactivables ici. Tab-Cue est branché sur le moteur de complétion
// inline (voir App.tsx › getAiCompletion) : couper le toggle coupe réellement
// les requêtes de complétion.

export function CueSection() {
  const [tabCue, setTabCue] = useState(isTabCueEnabled);
  const [smartImport, setSmartImport] = useState(isSmartImportEnabled);
  const [smartRename, setSmartRename] = useState(isSmartRenameEnabled);

  // Garde l'UI synchrone si un flag change ailleurs (App.tsx, command palette…).
  useEffect(() => {
    const sync = () => {
      setTabCue(isTabCueEnabled());
      setSmartImport(isSmartImportEnabled());
      setSmartRename(isSmartRenameEnabled());
    };
    window.addEventListener(CUE_EVENT, sync);
    return () => window.removeEventListener(CUE_EVENT, sync);
  }, []);

  return (
    <div>
      <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: "18px" }}>
        CUE
      </div>

      <Card>
        <Row
          title="Tab-Cue (context understanding engine)"
          description="Advanced code assistance with multi-line edits, smart refactoring, and cursor prediction"
        >
          <Toggle on={tabCue} onToggle={() => { const next = !tabCue; setTabCue(next); setTabCueEnabled(next); }} />
        </Row>
        <Row
          title="Smart Import"
          badge="Beta"
          description="Intelligently detect and import dependencies in TypeScript, Python and Go projects"
        >
          <Toggle on={smartImport} onToggle={() => { const next = !smartImport; setSmartImport(next); setSmartImportEnabled(next); }} />
        </Row>
        <Row
          title="Smart Rename"
          badge="Beta"
          last
          description="Intelligently rename variables, functions, and files in TypeScript, Python and Go projects"
        >
          <Toggle on={smartRename} onToggle={() => { const next = !smartRename; setSmartRename(next); setSmartRenameEnabled(next); }} />
        </Row>
      </Card>
    </div>
  );
}

// ── Primitives locales (mêmes métriques que les autres sections Settings) ────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: "1px solid var(--origin-border-default)",
      borderRadius: "8px",
      backgroundColor: "var(--origin-bg-subtle, var(--origin-bg-base))",
      overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function Row({ title, description, badge, last, children }: {
  title: string;
  description?: string;
  badge?: string;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "24px",
      padding: "14px 16px",
      borderBottom: last ? "none" : "1px solid var(--origin-border-default)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{title}</span>
          {badge && (
            <span style={{
              fontSize: "10px", color: "var(--origin-fg-subtle)",
              backgroundColor: "var(--origin-bg-base)",
              border: "1px solid var(--origin-border-default)",
              borderRadius: "4px", padding: "1px 5px",
            }}>{badge}</span>
          )}
        </div>
        {description && (
          <div style={{ fontSize: "11.5px", color: "var(--origin-fg-muted)", marginTop: "3px", lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
      {children && <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>{children}</div>}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      style={{
        width: 34, height: 18, borderRadius: 9, border: "none", cursor: "pointer",
        padding: 2, display: "flex", alignItems: "center",
        backgroundColor: on ? "var(--origin-semantic-success, #2ea043)" : "var(--origin-border-default)",
        transition: "background 0.15s", flexShrink: 0,
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: "50%", backgroundColor: "#fff",
        transform: on ? "translateX(16px)" : "translateX(0)",
        transition: "transform 0.15s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}
