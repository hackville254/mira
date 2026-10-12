import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, Check, SlidersHorizontal, Copy, Search, User, Smartphone, Code2, ShieldCheck, Wrench, Plug, Zap, Cpu, MessageSquare, Globe, Database, Command, ScrollText, Anchor, FlaskConical, Info, ExternalLink, ChevronDown, Palette, RefreshCw } from "lucide-react";
import KeybindingsSection from "./KeybindingsSection";
import FileIcon from "../FileIcon";
import { PROVIDERS } from "../ai/providers";
import { loadApiKey, saveApiKey, deleteApiKey } from "../../lib/secrets";
import { useTheme, builtinThemes } from "../../themes/ThemeContext";
import type { OriginTheme } from "../../themes/types";
import { detectDevEnvironment, type ToolInfo } from "../../lib/env";
import { loadDevEnvPrefs, saveDevEnvPrefs, type DevEnvPrefs } from "../../lib/devEnv";
import { KNOWN_SERVERS, isKnownServerId } from "../../lib/lspConfig";
import {
  loadGlobalLspConfig,
  saveGlobalLspConfig,
  WORKSPACE_LSP_PATH,
} from "../../lib/lspConfigStore";
import type { LspConfig, LspServerConfig } from "../../lib/lspConfig";

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_IDS = new Set(["ollama", "lmstudio", "vllm"]);
const API_PROVIDERS = PROVIDERS.filter(p => !LOCAL_IDS.has(p.id));

type Section =
  | "account" | "general" | "trae-mobile" | "dev-env" | "permission"
  | "agent" | "mcp" | "cue" | "models" | "appearance" | "conversation" | "browser"
  | "indexing" | "skills" | "rules" | "hooks" | "languages" | "beta" | "about";

interface NavDef {
  id: Section;
  label: string;
  icon: React.ReactNode;
  external?: boolean;
  keywords: string;
  dividerAfter?: boolean;
}

const NAV_ITEMS: NavDef[] = [
  { id: "account",      label: "Account",                 icon: <User size={14} />,               keywords: "account profile user" },
  { id: "general",      label: "General",                 icon: <SlidersHorizontal size={14} />,   keywords: "general settings" },
  { id: "trae-mobile",  label: "TRAE Mobile",             icon: <Smartphone size={14} />,          keywords: "mobile phone", dividerAfter: true },
  { id: "dev-env",      label: "Development Environment", icon: <Code2 size={14} />,              keywords: "python node interpreter environment" },
  { id: "permission",   label: "Permission Approval",      icon: <ShieldCheck size={14} />,         keywords: "permission approval security" },
  { id: "agent",        label: "Agent",                   icon: <Wrench size={14} />,              keywords: "agent tools" },
  { id: "mcp",          label: "MCP",                     icon: <Plug size={14} />,                keywords: "mcp server" },
  { id: "cue",          label: "CUE",                     icon: <Zap size={14} />,                 keywords: "cue" },
  { id: "models",       label: "Models",                  icon: <Cpu size={14} />,                 keywords: "models ai provider api key openai anthropic gemini" },
  { id: "appearance",   label: "Appearance",              icon: <Palette size={14} />,             keywords: "appearance theme color" },
  { id: "conversation", label: "Conversation",            icon: <MessageSquare size={14} />,       keywords: "conversation chat" },
  { id: "browser",      label: "Browser",                 icon: <Globe size={14} />,               keywords: "browser web preview", dividerAfter: true },
  { id: "indexing",     label: "Indexing & Docs",         icon: <Database size={14} />,            keywords: "indexing docs" },
  { id: "skills",       label: "Skills & Commands",       icon: <Command size={14} />,             keywords: "skills commands keyboard" },
  { id: "rules",        label: "Rules & Memories",        icon: <ScrollText size={14} />,          keywords: "rules memories" },
  { id: "hooks",        label: "Hooks",                   icon: <Anchor size={14} />,              keywords: "hooks" },
  { id: "languages",    label: "Languages & LSP",         icon: <Code2 size={14} />,               keywords: "languages lsp language server intellisense diagnostics completion hover", dividerAfter: true },
  { id: "beta",         label: "Beta",                    icon: <FlaskConical size={14} />,        keywords: "beta experimental", dividerAfter: true },
  { id: "about",        label: "About TraeCode",          icon: <Info size={14} />,                keywords: "about" },
];

// ── Nav ──────────────────────────────────────────────────────────────────────

function NavItem({ active, icon, label, onClick, external }: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  external?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "9px",
        width: "100%",
        padding: "7px 10px",
        borderRadius: "6px",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        fontSize: "13px",
        fontWeight: active ? 500 : 400,
        backgroundColor: active ? "var(--origin-bg-hover)" : "transparent",
        color: active ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => {
        if (!active) e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
      }}
      onMouseLeave={e => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span style={{ opacity: active ? 1 : 0.7, display: "flex" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {external && <ExternalLink size={11} style={{ opacity: 0.5 }} />}
    </button>
  );
}

// ── Setting row (VS Code style) ──────────────────────────────────────────────

function SettingRow({ title, description, children }: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "24px",
      padding: "11px 0",
      borderBottom: "1px solid var(--origin-border-default)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", color: "var(--origin-fg-default)" }}>{title}</div>
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "11px", fontWeight: 600, color: "var(--origin-fg-subtle)",
      textTransform: "uppercase", letterSpacing: "0.07em",
      margin: "18px 0 2px",
    }}>
      {children}
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

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: "4px",
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-base)",
  color: "var(--origin-fg-default)",
  fontSize: "12px",
  outline: "none",
  cursor: "pointer",
};

// ── AI Providers Section ─────────────────────────────────────────────────────

type KeyState = {
  value: string;
  original: string;
  visible: boolean;
  saving: boolean;
  justSaved: boolean;
};

function ComingSoonSection({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "40px 0", color: "var(--origin-fg-subtle)" }}>
      <span style={{ fontSize: "15px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{label}</span>
      <span style={{ fontSize: "12px" }}>Coming soon</span>
    </div>
  );
}

// ── Development Environment ─────────────────────────────────────────────────

function DevEnvironmentSection() {
  const cardBg = "color-mix(in srgb, var(--origin-fg-default) 3%, transparent)";
  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", padding: "14px 16px",
  };

  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<DevEnvPrefs>(() => loadDevEnvPrefs());

  useEffect(() => {
    let cancelled = false;
    detectDevEnvironment()
      .then(list => { if (!cancelled) setTools(list); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const byName = useMemo(() => {
    const m: Record<string, ToolInfo | undefined> = {};
    for (const t of tools) if (!m[t.name]) m[t.name] = t;
    return m;
  }, [tools]);

  const python = byName["python3"] ?? byName["python"];
  const node   = byName["node"];

  function chooseTool(kind: "pythonPath" | "nodePath", label: string) {
    const value = window.prompt(`${label} path (leave empty to use auto-detected):`, prefs[kind] ?? "");
    if (value === null) return;
    const next = { ...prefs, [kind]: value.trim() || null };
    setPrefs(next);
    saveDevEnvPrefs(next);
  }

  const toolRow = (label: string, tool: ToolInfo | undefined, icon: string, chosen: string | null, kind: "pythonPath" | "nodePath") => {
    const found = !!tool?.path;
    return (
      <div style={{ ...rowStyle, borderBottom: "1px solid var(--origin-border-default)" }}>
        <span style={{ fontSize: "13px", color: "var(--origin-fg-default)", flex: 1 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => chooseTool(kind, label)}
            title={tool?.path ?? "Not detected"}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "5px 10px", borderRadius: 6,
              border: "1px solid var(--origin-border-default)",
              backgroundColor: "var(--origin-bg-base)",
              fontSize: "12px",
              color: found ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
              cursor: "pointer", maxWidth: 320,
            }}
          >
            <span style={{ fontSize: 13 }}>{icon}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {loading
                ? "Detecting…"
                : chosen
                  ? chosen
                  : found
                    ? `${label} ${tool?.version ?? ""}`.trim()
                    : `${label} not found`}
            </span>
            <ChevronDown size={12} style={{ color: "var(--origin-fg-muted)", flexShrink: 0 }} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
        <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--origin-fg-default)", flex: 1 }}>
          Development Environment
        </div>
        <button
          onClick={() => {
            setLoading(true);
            detectDevEnvironment().then(setTools).finally(() => setLoading(false));
          }}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 6,
            border: "1px solid var(--origin-border-default)",
            backgroundColor: "var(--origin-bg-base)",
            fontSize: "12px", color: "var(--origin-fg-default)", cursor: "pointer",
          }}
        >
          <RefreshCw size={13} /> Rescan
        </button>
      </div>

      {/* Python */}
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: 10 }}>
        Python
      </div>
      <div style={{
        border: "1px solid var(--origin-border-default)",
        borderRadius: 10,
        overflow: "hidden",
        marginBottom: 32,
        backgroundColor: cardBg,
      }}>
        {toolRow("Python Interpreter", python, "🐍", prefs.pythonPath, "pythonPath")}
        <div style={rowStyle}>
          <span style={{ fontSize: "13px", color: "var(--origin-fg-default)", flex: 1 }}>Python Extension Configuration</span>
          <button style={{
            padding: "6px 16px", borderRadius: 6,
            border: "1px solid var(--origin-border-default)",
            backgroundColor: "var(--origin-bg-base)",
            fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)",
            cursor: "pointer",
          }}>
            Go to Settings
          </button>
        </div>
      </div>

      {/* Node.js */}
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--origin-fg-default)", marginBottom: 10 }}>
        Node.js
      </div>
      <div style={{
        border: "1px solid var(--origin-border-default)",
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: cardBg,
      }}>
        {toolRow("Node Version", node, "⬢", prefs.nodePath, "nodePath")}
      </div>
    </div>
  );
}

function AIProvidersSection() {
  const { theme } = useTheme();
  const isDark = theme.type === "dark";
  const [keys, setKeys] = useState<Record<string, KeyState>>(() =>
    Object.fromEntries(
      API_PROVIDERS.map(p => [p.id, { value: "", original: "", visible: false, saving: false, justSaved: false }])
    )
  );

  useEffect(() => {
    API_PROVIDERS.forEach(async ({ id }) => {
      const key = await loadApiKey(id).catch(() => null);
      if (key) {
        setKeys(prev => ({
          ...prev,
          [id]: { ...prev[id], value: key, original: key },
        }));
      }
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<KeyState>) => {
    setKeys(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  async function handleSave(id: string) {
    const { value } = keys[id];
    update(id, { saving: true });
    try {
      if (value.trim()) {
        await saveApiKey(id, value.trim());
        update(id, { saving: false, original: value.trim(), justSaved: true });
        setTimeout(() => update(id, { justSaved: false }), 1800);
      } else {
        await deleteApiKey(id);
        update(id, { saving: false, original: "", justSaved: true });
        setTimeout(() => update(id, { justSaved: false }), 1800);
      }
    } catch {
      update(id, { saving: false });
    }
  }

  async function handleClear(id: string) {
    await deleteApiKey(id).catch(() => {});
    update(id, { value: "", original: "" });
  }

  return (
    <div style={{ padding: "2px 0 16px" }}>
      <SectionHeading>API Keys</SectionHeading>
      <p style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "6px", lineHeight: 1.5 }}>
        API keys are stored in your OS keychain and never leave your device.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "12px" }}>
        {API_PROVIDERS.map(provider => {
          const state = keys[provider.id];
          if (!state) return null;
          const isDirty = state.value !== state.original;
          const hasSaved = state.original !== "";

          return (
            <div
              key={provider.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid var(--origin-border-default)",
                backgroundColor: "var(--origin-bg-base)",
              }}
            >
              {/* Provider icon */}
              <div style={{
                width: 28, height: 28, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "6px",
                backgroundColor: provider.icon ? "transparent" : provider.color,
                overflow: "hidden",
              }}>
                {provider.icon ? (
                  <img
                    src={provider.icon}
                    alt={provider.name}
                    style={{
                      width: 20, height: 20,
                      filter: provider.invert ? (isDark ? "brightness(0) invert(1)" : "none") : "none",
                    }}
                  />
                ) : (
                  <span style={{ fontSize: "10px", fontWeight: 700, color: provider.textColor }}>
                    {provider.initial}
                  </span>
                )}
              </div>

              {/* Name */}
              <div style={{ width: 90, flexShrink: 0 }}>
                <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--origin-fg-default)" }}>
                  {provider.name}
                </span>
                {hasSaved && (
                  <div style={{ display: "flex", alignItems: "center", gap: "3px", marginTop: "1px" }}>
                    <Check size={10} style={{ color: "var(--origin-semantic-success)" }} />
                    <span style={{ fontSize: "10px", color: "var(--origin-semantic-success)" }}>Key saved</span>
                  </div>
                )}
              </div>

              {/* Key input */}
              <div style={{ flex: 1, position: "relative" }}>
                <input
                  type={state.visible ? "text" : "password"}
                  value={state.value}
                  placeholder="Paste API key…"
                  onChange={e => update(provider.id, { value: e.target.value })}
                  onKeyDown={e => { if (e.key === "Enter") handleSave(provider.id); }}
                  style={{
                    width: "100%",
                    padding: "6px 30px 6px 9px",
                    borderRadius: "6px",
                    border: "1px solid var(--origin-border-default)",
                    backgroundColor: "var(--origin-bg-sidebar)",
                    color: "var(--origin-fg-default)",
                    fontSize: "12px",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={() => update(provider.id, { visible: !state.visible })}
                  style={{
                    position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--origin-fg-subtle)", padding: 0, display: "flex",
                  }}
                  tabIndex={-1}
                >
                  {state.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                <button
                  onClick={() => handleSave(provider.id)}
                  disabled={!isDirty || state.saving}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--origin-border-default)",
                    backgroundColor: state.justSaved
                      ? "color-mix(in srgb, var(--origin-semantic-success) 15%, transparent)"
                      : isDirty
                        ? "var(--origin-fg-default)"
                        : "transparent",
                    color: state.justSaved
                      ? "var(--origin-semantic-success)"
                      : isDirty
                        ? "var(--origin-bg-base)"
                        : "var(--origin-fg-subtle)",
                    fontSize: "12px",
                    fontWeight: 500,
                    cursor: isDirty ? "pointer" : "default",
                    transition: "all 0.15s",
                    minWidth: 50,
                  }}
                >
                  {state.saving ? "…" : state.justSaved ? "Saved!" : "Save"}
                </button>
                {hasSaved && (
                  <button
                    onClick={() => handleClear(provider.id)}
                    style={{
                      padding: "5px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--origin-border-default)",
                      backgroundColor: "transparent",
                      color: "var(--origin-fg-muted)",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Local providers note */}
      <div style={{
        marginTop: "20px",
        padding: "10px 12px",
        borderRadius: "8px",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)",
      }}>
        <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-muted)", marginBottom: "2px" }}>
          Local providers (Ollama, LM Studio, vLLM)
        </div>
        <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)" }}>
          No API key required. Make sure your local server is running before starting a chat.
        </div>
      </div>
    </div>
  );
}

// ── Appearance Section ───────────────────────────────────────────────────────

/** Extract a CSS var value for a token from a theme's color map. */
function colorOf(theme: OriginTheme | undefined, token: string, fallback: string): string {
  return theme?.colors[token] ?? fallback;
}

function ThemePreviewCard({ theme: t, selected, onSelect }: {
  theme: OriginTheme;
  selected: boolean;
  onSelect: () => void;
}) {
  const isDark = t.type === "dark";
  const bg = colorOf(t, "bg.editor", isDark ? "#1e1e1e" : "#ffffff");
  const sidebar = colorOf(t, "bg.sidebar", isDark ? "#252526" : "#f3f3f3");
  const fg = colorOf(t, "fg.default", isDark ? "#d4d4d4" : "#333333");
  const accent = colorOf(t, "accent.blue", "#3b82f6");
  const kw = colorOf(t, "syntax.keyword", isDark ? "#569cd6" : "#0000ff");
  const str = colorOf(t, "syntax.string", isDark ? "#ce9178" : "#a31515");
  const fn = colorOf(t, "syntax.function", isDark ? "#dcdcaa" : "#795e26");

  return (
    <button
      onClick={onSelect}
      title={t.name}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px",
        borderRadius: "8px",
        border: selected ? "2px solid var(--origin-accent-blue)" : "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)",
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 0.12s",
      }}
    >
      {/* Mini editor mock */}
      <div style={{
        width: "100%",
        height: "74px",
        borderRadius: "5px",
        overflow: "hidden",
        display: "flex",
        border: "1px solid rgba(128,128,128,0.2)",
      }}>
        {/* Sidebar strip */}
        <div style={{ width: "26%", backgroundColor: sidebar, padding: "8px 6px", display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ height: 4, width: "70%", borderRadius: 2, backgroundColor: fg, opacity: 0.5 }} />
          <div style={{ height: 4, width: "50%", borderRadius: 2, backgroundColor: accent, opacity: 0.85 }} />
          <div style={{ height: 4, width: "60%", borderRadius: 2, backgroundColor: fg, opacity: 0.3 }} />
        </div>
        {/* Editor area */}
        <div style={{ flex: 1, backgroundColor: bg, padding: "8px 8px", display: "flex", flexDirection: "column", gap: "5px", justifyContent: "center" }}>
          <div style={{ height: 4, width: "80%", borderRadius: 2, backgroundColor: kw }} />
          <div style={{ height: 4, width: "55%", borderRadius: 2, backgroundColor: fn }} />
          <div style={{ height: 4, width: "68%", borderRadius: 2, backgroundColor: str }} />
          <div style={{ height: 4, width: "40%", borderRadius: 2, backgroundColor: fg, opacity: 0.45 }} />
        </div>
      </div>
      {/* Label */}
      <div style={{ display: "flex", alignItems: "center", gap: "5px", minWidth: 0 }}>
        {selected && <Check size={12} style={{ color: "var(--origin-accent-blue)", flexShrink: 0 }} />}
        <span style={{
          fontSize: "12px", color: "var(--origin-fg-default)", fontWeight: selected ? 500 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {t.name}
        </span>
      </div>
    </button>
  );
}

const APPEARANCE_DENSITY_KEY = "origin-ui-density";
const APPEARANCE_STATUS_BAR_KEY = "origin-ui-status-bar";

/**
 * Sample entries used to preview an icon theme, mirroring VS Code's own preview
 * row. Names map onto real theme keys (`fileNames`/`fileExtensions`/folders) so
 * the preview reflects what the Explorer will actually show.
 */
const ICON_PREVIEW_ENTRIES: { name: string; isDir?: boolean; expanded?: boolean }[] = [
  { name: "src", isDir: true, expanded: true },
  { name: "index.ts" },
  { name: "App.tsx" },
  { name: "styles.css" },
  { name: "package.json" },
  { name: "README.md" },
  { name: "Dockerfile" },
];

/** Horizontal strip previewing the files/folders as rendered by the active theme. */
function IconThemePreview() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "16px",
      flexWrap: "wrap",
      padding: "12px 14px",
      borderRadius: "8px",
      border: "1px solid var(--origin-border-default)",
      backgroundColor: "var(--origin-bg-base)",
    }}>
      {ICON_PREVIEW_ENTRIES.map(e => (
        <span key={e.name} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <FileIcon name={e.name} isDir={e.isDir} expanded={e.expanded} size={16} />
          <span style={{ fontSize: "12px", color: "var(--origin-fg-muted)" }}>{e.name}</span>
        </span>
      ))}
    </div>
  );
}

function AppearanceSection() {
  const {
    theme, themes, setTheme,
    iconThemes, iconThemeId, setIconTheme,
    productIconThemes, productIconThemeId, setProductIconTheme,
  } = useTheme();

  const [density, setDensity] = useState<string>(() => localStorage.getItem(APPEARANCE_DENSITY_KEY) ?? "comfortable");
  const [statusBar, setStatusBar] = useState(() => localStorage.getItem(APPEARANCE_STATUS_BAR_KEY) !== "false");

  function changeDensity(v: string) {
    localStorage.setItem(APPEARANCE_DENSITY_KEY, v);
    setDensity(v);
    document.documentElement.setAttribute("data-density", v);
  }
  function toggleStatusBar() {
    const next = !statusBar;
    localStorage.setItem(APPEARANCE_STATUS_BAR_KEY, String(next));
    setStatusBar(next);
    document.documentElement.setAttribute("data-status-bar", String(next));
  }

  return (
    <div style={{ paddingBottom: "24px" }}>
      <SectionHeading>Color Theme</SectionHeading>
      <p style={{ fontSize: "12px", color: "var(--origin-fg-muted)", margin: "4px 0 14px", lineHeight: 1.5 }}>
        Select the colour theme for the editor and workspace. Themes installed from extensions appear here automatically.
      </p>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
        gap: "12px",
      }}>
        {themes.map(t => (
          <ThemePreviewCard
            key={t.name}
            theme={t}
            selected={t.name === theme.name}
            onSelect={() => setTheme(t)}
          />
        ))}
      </div>
      {themes.length === builtinThemes.length && (
        <div style={{
          marginTop: "12px",
          padding: "10px 12px",
          borderRadius: "8px",
          border: "1px solid var(--origin-border-default)",
          backgroundColor: "var(--origin-bg-base)",
          fontSize: "12px",
          color: "var(--origin-fg-muted)",
          lineHeight: 1.5,
        }}>
          No colour theme from an extension is installed yet. Install one from the Extensions panel
          (e.g. <span style={{ color: "var(--origin-fg-default)" }}>One Dark Pro</span>) and it will show up here.
        </div>
      )}

      <SectionHeading>File Icon Theme</SectionHeading>
      <SettingRow
        title="Icon theme"
        description="Icons shown next to files and folders in the Explorer, tabs and search results."
      >
        <select value={iconThemeId} onChange={e => setIconTheme(e.target.value)} style={selectStyle}>
          {iconThemes.map(t => (
            <option key={t.id || "__default"} value={t.id}>{t.label}</option>
          ))}
        </select>
      </SettingRow>
      <div style={{ marginTop: "10px" }}>
        <IconThemePreview />
      </div>

      <SectionHeading>Product Icon Theme</SectionHeading>
      <SettingRow
        title="Product icon theme"
        description="Icon set used for the interface (activity bar, panels, views)."
      >
        <select value={productIconThemeId} onChange={e => setProductIconTheme(e.target.value)} style={selectStyle}>
          {productIconThemes.map(t => (
            <option key={t.id || "__default"} value={t.id}>{t.label}</option>
          ))}
        </select>
      </SettingRow>

      <SectionHeading>Interface</SectionHeading>
      <SettingRow title="Density" description="Controls the spacing of the tab bar and file tree rows.">
        <select value={density} onChange={e => changeDensity(e.target.value)} style={selectStyle}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </SettingRow>
      <SettingRow title="Status bar" description="Show the status bar at the bottom of the window.">
        <Toggle on={statusBar} onToggle={toggleStatusBar} />
      </SettingRow>
    </div>
  );
}

// ── General Section ──────────────────────────────────────────────────────────

const AUTOCOMPLETE_DELAY_KEY = 'origin-editor-autocomplete-delay';
const AUTOCOMPLETE_DELAY_UNIT_KEY = 'origin-editor-autocomplete-delay-unit';
const AUTOCOMPLETE_DELAY_DEFAULT_MS = 350;

type DelayUnit = 'ms' | 's';

function msToDisplay(ms: number, unit: DelayUnit): string {
  return unit === 's' ? (ms / 1000).toString() : ms.toString();
}

function displayToMs(raw: string, unit: DelayUnit): number | null {
  const n = parseFloat(raw);
  if (isNaN(n) || n <= 0) return null;
  return unit === 's' ? Math.round(n * 1000) : Math.round(n);
}

function GeneralSection() {
  const [unit, setUnit] = useState<DelayUnit>(
    () => (localStorage.getItem(AUTOCOMPLETE_DELAY_UNIT_KEY) as DelayUnit | null) ?? 'ms'
  );
  const [delayMs, setDelayMs] = useState(
    () => parseInt(localStorage.getItem(AUTOCOMPLETE_DELAY_KEY) ?? String(AUTOCOMPLETE_DELAY_DEFAULT_MS), 10)
  );
  const [inputVal, setInputVal] = useState(() =>
    msToDisplay(parseInt(localStorage.getItem(AUTOCOMPLETE_DELAY_KEY) ?? String(AUTOCOMPLETE_DELAY_DEFAULT_MS), 10), (localStorage.getItem(AUTOCOMPLETE_DELAY_UNIT_KEY) as DelayUnit | null) ?? 'ms')
  );
  const [completionsEnabled, setCompletionsEnabled] = useState(
    () => localStorage.getItem('origin-editor-ai-autocomplete') !== 'false'
  );

  function commitInput(raw: string) {
    const ms = displayToMs(raw, unit);
    if (ms !== null) {
      setDelayMs(ms);
      setInputVal(msToDisplay(ms, unit));
      localStorage.setItem(AUTOCOMPLETE_DELAY_KEY, String(ms));
    } else {
      setInputVal(msToDisplay(delayMs, unit));
    }
  }

  function switchUnit(next: DelayUnit) {
    setUnit(next);
    setInputVal(msToDisplay(delayMs, next));
    localStorage.setItem(AUTOCOMPLETE_DELAY_UNIT_KEY, next);
  }

  function toggleCompletions() {
    const next = !completionsEnabled;
    localStorage.setItem('origin-editor-ai-autocomplete', next ? 'true' : 'false');
    setCompletionsEnabled(next);
  }

  const inputStyle: React.CSSProperties = {
    width: "80px",
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid var(--origin-border-default)",
    backgroundColor: "var(--origin-bg-sidebar)",
    color: "var(--origin-fg-default)",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    outline: "none",
    textAlign: "right",
  };

  return (
    <div style={{ paddingBottom: "24px" }}>
      <SectionHeading>AI Autocomplete</SectionHeading>
      <SettingRow
        title="Inline completions"
        description="Ghost text as you type — Tab to accept, Escape to dismiss."
      >
        <Toggle on={completionsEnabled} onToggle={toggleCompletions} />
      </SettingRow>

      <SettingRow
        title="Ghost text delay"
        description="Wait time after typing stops before requesting a suggestion."
      >
        <input
          type="number"
          min={unit === 's' ? 0.1 : 100}
          step={unit === 's' ? 0.1 : 50}
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onBlur={e => { e.currentTarget.style.borderColor = "var(--origin-border-default)"; commitInput(e.target.value); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
          style={inputStyle}
          onFocus={e => { e.currentTarget.style.borderColor = "var(--origin-fg-muted)"; }}
        />
        <select
          value={unit}
          onChange={e => switchUnit(e.target.value as DelayUnit)}
          style={selectStyle}
        >
          <option value="ms">ms</option>
          <option value="s">s</option>
        </select>
      </SettingRow>
    </div>
  );
}

// ── Languages & LSP Section ──────────────────────────────────────────────────

/** Petit bouton d'action réutilisé dans la liste des serveurs. */
function TinyButton({ onClick, title, children, danger }: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--origin-border-default)",
        backgroundColor: "transparent",
        color: danger ? "var(--origin-semantic-error, #f85149)" : "var(--origin-fg-muted)",
      }}
      onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {children}
    </button>
  );
}

const monoInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-sidebar)",
  color: "var(--origin-fg-default)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

function LspSection() {
  // État local, initialisé depuis la config globale (localStorage).
  const [config, setConfig] = useState<LspConfig>(() => loadGlobalLspConfig());
  const [saved, setSaved] = useState(false);

  const knownIds = useMemo(() => new Set(KNOWN_SERVERS.map(s => s.id)), []);

  function persist(next: LspConfig) {
    setConfig(next);
    saveGlobalLspConfig(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function updateServer(idx: number, patch: Partial<LspServerConfig>) {
    const servers = config.servers.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    persist({ ...config, servers });
  }

  function toggleEnabled(idx: number) {
    const s = config.servers[idx];
    updateServer(idx, { enabled: s.enabled === false ? undefined : false });
  }

  function removeServer(idx: number) {
    const s = config.servers[idx];
    if (!window.confirm(`Remove the "${s.serverId}" server from the global config?`)) return;
    persist({ ...config, servers: config.servers.filter((_, i) => i !== idx) });
  }

  function addServer() {
    const available = KNOWN_SERVERS.filter(s => !config.servers.some(c => c.serverId === s.id));
    if (available.length === 0) return;
    const choice = window.prompt(
      `Add a language server (serverId):\n${available.map(s => `- ${s.id}`).join("\n")}`,
      available[0].id
    );
    if (!choice) return;
    const id = choice.trim();
    if (!isKnownServerId(id)) {
      window.alert(`Unknown server id "${id}". It must exist in the built-in catalog.`);
      return;
    }
    if (config.servers.some(c => c.serverId === id)) {
      window.alert(`"${id}" is already configured.`);
      return;
    }
    persist({
      ...config,
      servers: [...config.servers, { serverId: id, extensions: [], languageId: id }],
    });
  }

  function commitExtensions(idx: number, raw: string) {
    const exts = raw
      .split(/[,\s]+/)
      .map(e => e.trim().replace(/^\./, "").toLowerCase())
      .filter(e => /^[a-z0-9]+$/.test(e));
    updateServer(idx, { extensions: exts });
  }

  function commitArgs(idx: number, raw: string) {
    const args = raw.split(/\s+/).map(a => a.trim()).filter(Boolean);
    updateServer(idx, { args: args.length ? args : undefined });
  }

  return (
    <div style={{ padding: "2px 0 24px" }}>
      <SectionHeading>Language Servers</SectionHeading>
      <p style={{ fontSize: 12, color: "var(--origin-fg-muted)", margin: "6px 0 16px", lineHeight: 1.6 }}>
        Language servers provide diagnostics, completion, hover and go-to-definition. A server can only
        run if it is part of the built-in allow-list — this panel only binds known servers to file
        extensions and controls how they are launched.
      </p>

      {saved && (
        <div style={{
          fontSize: 12, color: "var(--origin-semantic-success, #2ea043)",
          display: "flex", alignItems: "center", gap: 6, marginBottom: 12,
        }}>
          <Check size={12} /> Saved
        </div>
      )}

      {/* Workspace override hint */}
      <div style={{
        padding: "10px 12px", marginBottom: 18,
        borderRadius: 8, border: "1px solid var(--origin-border-default)",
        backgroundColor: "var(--origin-bg-base)", fontSize: 12,
        color: "var(--origin-fg-muted)", lineHeight: 1.5,
      }}>
        These settings apply <span style={{ color: "var(--origin-fg-default)" }}>globally</span>. A project can
        override them with an{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--origin-fg-default)" }}>{WORKSPACE_LSP_PATH}</span>{" "}
        file at its root (workspace settings take precedence per server).
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {config.servers.map((server, idx) => {
          const known = knownIds.has(server.serverId);
          const disabled = server.enabled === false;
          return (
            <div
              key={server.serverId}
              style={{
                border: "1px solid var(--origin-border-default)",
                borderRadius: 8,
                backgroundColor: "var(--origin-bg-base)",
                padding: "12px 14px",
                opacity: disabled ? 0.55 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--origin-fg-default)", fontFamily: "var(--font-mono)" }}>
                  {server.serverId}
                </span>
                {!known && (
                  <span style={{ fontSize: 10, color: "var(--origin-semantic-error, #f85149)", border: "1px solid currentColor", borderRadius: 4, padding: "0 4px" }}>
                    unknown
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <Toggle on={!disabled} onToggle={() => toggleEnabled(idx)} />
                <TinyButton onClick={() => removeServer(idx)} title="Remove server" danger>
                  <X size={13} />
                </TinyButton>
              </div>

              {(() => {
                const info = KNOWN_SERVERS.find(s => s.id === server.serverId);
                if (!info) return null;
                return (
                  <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                    {info.installCommand}
                  </div>
                );
              })()}

              <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                <label style={{ flex: "2 1 260px", minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", marginBottom: 4 }}>Extensions</div>
                  <input
                    defaultValue={server.extensions.join(", ")}
                    placeholder="ts, tsx, js"
                    onBlur={e => commitExtensions(idx, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    style={monoInputStyle}
                  />
                </label>
                <label style={{ flex: "1 1 160px", minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", marginBottom: 4 }}>languageId</div>
                  <input
                    defaultValue={server.languageId}
                    onBlur={e => updateServer(idx, { languageId: e.target.value.trim() || server.languageId })}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    style={monoInputStyle}
                  />
                </label>
                <label style={{ flex: "2 1 200px", minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", marginBottom: 4 }}>Arguments</div>
                  <input
                    defaultValue={(server.args ?? []).join(" ")}
                    placeholder="--stdio"
                    onBlur={e => commitArgs(idx, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    style={monoInputStyle}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 14 }}>
        <button
          onClick={addServer}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 6, fontSize: 12,
            border: "1px solid var(--origin-border-default)",
            backgroundColor: "transparent", color: "var(--origin-fg-default)",
            cursor: "pointer",
          }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          Add language server
        </button>
      </div>
    </div>
  );
}

// ── Terminal Section ─────────────────────────────────────────────────────────

const SHELL_CONFIGS: Record<string, { label: string; filename: string; code: string }> = {
  powershell: {
    label: "PowerShell",
    filename: "$PROFILE",
    code: [
      'function prompt {',
      '    $code = if ($?) { 0 } else { $LASTEXITCODE }',
      "    $p = ($PWD.Path -replace '\\\\', '/') -replace '^([A-Za-z]):', '/$1'",
      '    $esc = [char]27',
      '    [Console]::Write("$esc]133;D;$code`a$esc]7;file://$env:COMPUTERNAME$p`a$esc]133;A`a")',
      '    "PS $($PWD.Path)> $esc]133;B`a"',
      '}',
    ].join('\n'),
  },
  bash: {
    label: "Bash",
    filename: "~/.bashrc",
    code: [
      '__origin_prompt() {',
      '  local code=$?',
      "  printf '\\033]133;D;%s\\007' \"$code\"",
      "  printf '\\033]7;file://%s%s\\007' \"$HOSTNAME\" \"$PWD\"",
      "  printf '\\033]133;A\\007'",
      '}',
      'PROMPT_COMMAND="__origin_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      "PS1=\"${PS1}\"$'\\033]133;B\\007'",
    ].join('\n'),
  },
  zsh: {
    label: "Zsh",
    filename: "~/.zshrc",
    code: [
      '__origin_precmd() {',
      '  local code=$?',
      "  printf '\\033]133;D;%s\\007' \"$code\"",
      "  printf '\\033]7;file://%s%s\\007' \"$HOST\" \"$PWD\"",
      "  printf '\\033]133;A\\007'",
      '}',
      'precmd_functions+=(__origin_precmd)',
      "PROMPT=\"${PROMPT}\"$'\\033]133;B\\007'",
    ].join('\n'),
  },
};

function TerminalSection() {
  const [copied, setCopied] = useState<string | null>(null);

  function copy(key: string, code: string) {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    }).catch(() => {});
  }

  return (
    <div style={{ padding: "2px 0 16px" }}>
      <SectionHeading>Shell Integration</SectionHeading>
      <p style={{ fontSize: "12px", color: "var(--origin-fg-muted)", marginBottom: "20px", lineHeight: 1.6, marginTop: "6px" }}>
        Paste the snippet for your shell into the file shown, then reload your shell. Once active, terminal tabs show a live directory and a colored dot for command exit status.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {Object.entries(SHELL_CONFIGS).map(([key, cfg]) => (
          <div key={key}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{cfg.label}</span>
                <span style={{ fontSize: "11px", color: "var(--origin-fg-subtle)", fontFamily: "var(--font-mono)" }}>{cfg.filename}</span>
              </div>
              <button
                onClick={() => copy(key, cfg.code)}
                style={{
                  display: "flex", alignItems: "center", gap: "5px",
                  padding: "4px 10px", borderRadius: "6px", fontSize: "12px",
                  border: "1px solid var(--origin-border-default)",
                  backgroundColor: copied === key
                    ? "color-mix(in srgb, var(--origin-semantic-success) 15%, transparent)"
                    : "transparent",
                  color: copied === key ? "var(--origin-semantic-success)" : "var(--origin-fg-muted)",
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {copied === key ? <Check size={11} /> : <Copy size={11} />}
                {copied === key ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre style={{
              margin: 0, padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid var(--origin-border-default)",
              backgroundColor: "var(--origin-bg-base)",
              color: "var(--origin-fg-default)",
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
              lineHeight: "1.65",
              overflowX: "auto",
              whiteSpace: "pre",
            }}>
              {cfg.code}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
void TerminalSection;

// ── Settings Panel ───────────────────────────────────────────────────────────

interface SettingsPanelProps {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [section, setSection] = useState<Section>("dev-env");
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      s => s.label.toLowerCase().includes(q) || s.keywords.includes(q)
    );
  }, [query]);

  return createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        backgroundColor: "var(--origin-bg-sidebar)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Floating close button */}
      <button
        onClick={onClose}
        title="Close (Esc)"
        style={{
          position: "absolute", top: 12, right: 14, zIndex: 10,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 28, height: 28,
          borderRadius: "6px",
          border: "none",
          background: "none",
          cursor: "pointer",
          color: "var(--origin-fg-muted)",
        }}
        onMouseEnter={e => {
          e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)";
          e.currentTarget.style.color = "var(--origin-fg-default)";
        }}
        onMouseLeave={e => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--origin-fg-muted)";
        }}
      >
        <X size={16} />
      </button>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left nav */}
        <div style={{
          width: 264,
          flexShrink: 0,
          borderRight: "1px solid var(--origin-border-default)",
          padding: "16px 12px",
          overflowY: "auto",
        }}>
          {/* Account header */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px 16px" }}>
            <div style={{
              width: 40, height: 40, borderRadius: "10px",
              backgroundColor: "var(--origin-accent-blue)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: "17px", fontWeight: 700, flexShrink: 0,
            }}>
              f
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--origin-fg-default)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                franklin DZUKAM
              </span>
              <span style={{
                fontSize: "10px", fontWeight: 600, color: "#10b981",
                backgroundColor: "rgba(16,185,129,0.12)",
                padding: "1px 6px", borderRadius: "4px", alignSelf: "flex-start",
                marginTop: 3,
              }}>
                Pro+
              </span>
            </div>
          </div>

          {/* Search */}
          <div style={{ position: "relative", padding: "0 6px 12px" }}>
            <Search size={12} style={{
              position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
              color: "var(--origin-fg-subtle)", pointerEvents: "none",
            }} />
            <input
              value={query}
              onChange={e => {
                const v = e.target.value;
                setQuery(v);
                const q = v.trim().toLowerCase();
                if (q) {
                  const first = NAV_ITEMS.find(s => s.label.toLowerCase().includes(q) || s.keywords.includes(q));
                  if (first) setSection(first.id);
                }
              }}
              placeholder="⌘F to search"
              style={{
                width: "100%",
                padding: "5px 9px 5px 28px",
                borderRadius: "6px",
                border: "1px solid var(--origin-border-default)",
                backgroundColor: "var(--origin-bg-base)",
                color: "var(--origin-fg-default)",
                fontSize: "12px",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={e => { e.currentTarget.style.borderColor = "var(--origin-fg-muted)"; }}
              onBlur={e => { e.currentTarget.style.borderColor = "var(--origin-border-default)"; }}
            />
          </div>

          {filteredSections.map(s => (
            <div key={s.id}>
              <NavItem
                active={section === s.id}
                icon={s.icon}
                label={s.label}
                external={s.external}
                onClick={() => setSection(s.id)}
              />
              {s.dividerAfter && (
                <div style={{
                  height: 1,
                  margin: "6px 8px",
                  backgroundColor: "var(--origin-border-default)",
                }} />
              )}
            </div>
          ))}
          {filteredSections.length === 0 && (
            <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", padding: "8px 10px" }}>
              No matching settings
            </div>
          )}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 40px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            {section === "dev-env"     && <DevEnvironmentSection />}
            {section === "models"      && <AIProvidersSection />}
            {section === "appearance"  && <AppearanceSection />}
            {section === "general"     && <GeneralSection />}
            {section === "skills"      && <KeybindingsSection />}
            {section === "languages"   && <LspSection />}
            {!["dev-env", "models", "appearance", "general", "skills", "languages"].includes(section) && (
              <ComingSoonSection label={NAV_ITEMS.find(s => s.id === section)?.label ?? ""} />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
