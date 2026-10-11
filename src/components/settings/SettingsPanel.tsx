import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, Bot, Palette, Check, SlidersHorizontal, Terminal, Copy, Keyboard, Search } from "lucide-react";
import KeybindingsSection from "./KeybindingsSection";
import FileIcon from "../FileIcon";
import { PROVIDERS } from "../ai/providers";
import { loadApiKey, saveApiKey, deleteApiKey } from "../../lib/secrets";
import { useTheme, builtinThemes } from "../../themes/ThemeContext";
import type { OriginTheme } from "../../themes/types";

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_IDS = new Set(["ollama", "lmstudio", "vllm"]);
const API_PROVIDERS = PROVIDERS.filter(p => !LOCAL_IDS.has(p.id));

type Section = "general" | "ai" | "appearance" | "terminal" | "keybindings";

// ── Nav ──────────────────────────────────────────────────────────────────────

function NavItem({ active, icon, label, onClick }: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
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
      {label}
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

// ── Settings Panel ───────────────────────────────────────────────────────────

interface SettingsPanelProps {
  onClose: () => void;
}

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; keywords: string }[] = [
  { id: "general",      label: "General",           icon: <SlidersHorizontal size={14} />, keywords: "autocomplete inline ghost text delay completions" },
  { id: "ai",           label: "AI Providers",      icon: <Bot size={14} />,               keywords: "api key openai anthropic gemini provider model" },
  { id: "appearance",   label: "Appearance",        icon: <Palette size={14} />,           keywords: "theme color dark light" },
  { id: "terminal",     label: "Terminal",          icon: <Terminal size={14} />,          keywords: "shell integration bash zsh powershell" },
  { id: "keybindings",  label: "Keyboard Shortcuts",icon: <Keyboard size={14} />,          keywords: "keybinding shortcut keys" },
];

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [section, setSection] = useState<Section>("general");
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
    if (!q) return SECTIONS;
    return SECTIONS.filter(
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
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "0 16px",
        height: "48px",
        borderBottom: "1px solid var(--origin-border-default)",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--origin-fg-default)", whiteSpace: "nowrap" }}>
          Settings
        </span>

        {/* Search */}
        <div style={{ position: "relative", flex: 1, maxWidth: "360px" }}>
          <Search size={13} style={{
            position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)",
            color: "var(--origin-fg-subtle)", pointerEvents: "none",
          }} />
          <input
            value={query}
            onChange={e => {
              const v = e.target.value;
              setQuery(v);
              const q = v.trim().toLowerCase();
              if (q) {
                const first = SECTIONS.find(s => s.label.toLowerCase().includes(q) || s.keywords.includes(q));
                if (first) setSection(first.id);
              }
            }}
            placeholder="Search settings"
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

        <button
          onClick={onClose}
          style={{
            marginLeft: "auto",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26,
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
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left nav */}
        <div style={{
          width: "196px",
          flexShrink: 0,
          borderRight: "1px solid var(--origin-border-default)",
          padding: "10px 8px",
          overflowY: "auto",
        }}>
          <div style={{ fontSize: "10px", fontWeight: 600, color: "var(--origin-fg-subtle)", textTransform: "uppercase", letterSpacing: "0.07em", padding: "4px 10px 6px" }}>
            Settings
          </div>
          {filteredSections.map(s => (
            <NavItem
              key={s.id}
              active={section === s.id}
              icon={s.icon}
              label={s.label}
              onClick={() => setSection(s.id)}
            />
          ))}
          {filteredSections.length === 0 && (
            <div style={{ fontSize: "12px", color: "var(--origin-fg-subtle)", padding: "8px 10px" }}>
              No matching settings
            </div>
          )}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 32px" }}>
          <div style={{ maxWidth: "760px" }}>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--origin-fg-default)" }}>
              {SECTIONS.find(s => s.id === section)?.label}
            </div>
            {section === "general"     && <GeneralSection />}
            {section === "ai"          && <AIProvidersSection />}
            {section === "appearance"  && <AppearanceSection />}
            {section === "terminal"    && <TerminalSection />}
            {section === "keybindings" && <KeybindingsSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
