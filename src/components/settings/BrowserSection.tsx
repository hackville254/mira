import { useState, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BROWSER_EVENT,
  isBuiltinControlEnabled, setBuiltinControlEnabled,
  isExternalControlEnabled, setExternalControlEnabled,
  isAutoScreenshotEnabled, setAutoScreenshotEnabled,
  getDefaultTarget, setDefaultTarget,
  type BrowserTarget,
} from "../../lib/browserPrefs";

// Chrome Web Store — extension de liaison Origin. L'installation manuelle est
// proposée en repli si le store est inaccessible.
const CHROME_EXTENSION_STORE_URL =
  "https://chromewebstore.google.com/";
const CHROME_EXTENSION_MANUAL_URL =
  "https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world";

// ── Browser Section ──────────────────────────────────────────────────────────
//
// Trois blocs : Built-in Browser, External Browser, General. Les toggles sont
// branchés sur la politique d'exposition du panel navigateur à l'agent
// (voir browserPrefs.ts). « Browser Data » purge les données du panel interne
// (cookies / localStorage de la webview preview).

export function BrowserSection({ workspace }: { workspace?: string }) {
  const [builtin, setBuiltin] = useState(isBuiltinControlEnabled);
  const [external, setExternal] = useState(isExternalControlEnabled);
  const [autoShot, setAutoShot] = useState(isAutoScreenshotEnabled);
  const [target, setTarget] = useState<BrowserTarget>(getDefaultTarget);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    const sync = () => {
      setBuiltin(isBuiltinControlEnabled());
      setExternal(isExternalControlEnabled());
      setAutoShot(isAutoScreenshotEnabled());
      setTarget(getDefaultTarget());
    };
    window.addEventListener(BROWSER_EVENT, sync);
    return () => window.removeEventListener(BROWSER_EVENT, sync);
  }, []);

  const clearBrowserData = async () => {
    setClearing(true);
    setCleared(false);
    try {
      // Purge best-effort : efface le stockage persistant associé au panel de
      // prévisualisation et notifie la webview pour qu'elle vide son cache local.
      localStorage.removeItem("origin-browser-preview-data");
      window.dispatchEvent(new CustomEvent("origin-browser-clear-data"));
      setCleared(true);
      window.setTimeout(() => setCleared(false), 2000);
    } finally {
      setClearing(false);
    }
  };

  const openStore = () => {
    void openUrl(CHROME_EXTENSION_STORE_URL).catch(() => { /* ouverture externe best-effort */ });
  };
  const openManual = () => {
    void openUrl(CHROME_EXTENSION_MANUAL_URL).catch(() => { /* ouverture externe best-effort */ });
  };

  return (
    <div data-workspace={workspace}>
      <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: "18px" }}>
        Browser
      </div>

      <Heading>Built-in Browser</Heading>
      <Card>
        <Row
          title="Allow AI to Control Built-in Browser"
          description="Allow the AI agent to automate web browsing tasks in the built-in browser"
        >
          <Toggle on={builtin} onToggle={() => { const n = !builtin; setBuiltin(n); setBuiltinControlEnabled(n); }} />
        </Row>
        <Row
          title="Browser Data"
          last
          description="Website data stored in the built-in browser (such as cookies and local storage)"
        >
          <DangerButton onClick={clearing ? undefined : clearBrowserData}>
            {cleared ? "Cleared" : clearing ? "Clearing…" : "Clear"}
          </DangerButton>
        </Row>
      </Card>

      <Heading>External Browser</Heading>
      <Card>
        <Row
          title="Allow AI to Control External Browser"
          description="When enabled, the AI agent can use your external Chrome browser for web browsing tasks"
        >
          <Toggle on={external} onToggle={() => { const n = !external; setExternal(n); setExternalControlEnabled(n); }} />
        </Row>
        <Row
          title="Link Chrome"
          last
          description="If the Chrome extension is not installed, the AI may not be able to open the browser properly."
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
            <SecondaryButton onClick={openStore}>
              Install extension <ExternalIcon />
            </SecondaryButton>
            <button
              onClick={openManual}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                fontSize: "11.5px", color: "var(--origin-fg-muted)", textDecoration: "underline",
              }}
            >
              Unable to access the store? Try manual installation
            </button>
          </div>
        </Row>
      </Card>

      <Heading>General</Heading>
      <Card>
        <Row
          title="Default Browser for AI Tasks"
          description="Select which browser the AI agent uses by default when performing Browser Use tasks"
        >
          <select
            value={target}
            onChange={(e) => { const v = e.target.value as BrowserTarget; setTarget(v); setDefaultTarget(v); }}
            style={selectStyle}
          >
            <option value="builtin">Built-in Browser</option>
            <option value="external">External Chrome</option>
          </select>
        </Row>
        <Row
          title="Auto Screenshot"
          last
          description="Automatically captures screenshots after browser actions, for display only, does not consume tokens."
        >
          <Toggle on={autoShot} onToggle={() => { const n = !autoShot; setAutoShot(n); setAutoScreenshotEnabled(n); }} />
        </Row>
      </Card>
    </div>
  );
}

// ── Primitives locales ───────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-base)",
  color: "var(--origin-fg-default)",
  fontSize: "12.5px",
  outline: "none",
  cursor: "pointer",
  minWidth: 160,
};

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)",
      margin: "20px 0 8px",
    }}>
      {children}
    </div>
  );
}

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

function Row({ title, description, last, children }: {
  title: string;
  description?: string;
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
        <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{title}</div>
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

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: "6px",
        padding: "6px 12px", borderRadius: "6px",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)",
        color: "var(--origin-fg-default)",
        fontSize: "12.5px", fontWeight: 500, cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function DangerButton({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        padding: "6px 14px", borderRadius: "6px",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)",
        color: "var(--origin-semantic-error, #f85149)",
        fontSize: "12.5px", fontWeight: 500,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {children}
    </button>
  );
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
