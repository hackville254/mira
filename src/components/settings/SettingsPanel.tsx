import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, Check, SlidersHorizontal, Copy, Search, User, Smartphone, Code2, ShieldCheck, Wrench, Plug, Zap, Cpu, MessageSquare, Bell, Globe, Database, Command, ScrollText, Anchor, FlaskConical, Info, ExternalLink, ChevronDown, ChevronRight, ChevronLeft, Palette, RefreshCw, Bot, Plus, Trash2, Link2 } from "lucide-react";
import KeybindingsSection from "./KeybindingsSection";
import SkillsSection from "./SkillsSection";
import CommandsSection from "./CommandsSection";
import RulesMemoriesSection from "./RulesMemoriesSection";
import McpSection from "./McpSection";
import HooksSection from "./HooksSection";
import IndexingSection from "./IndexingSection";
import AboutSection from "./AboutSection";
import AccountSection from "./AccountSection";
import { useAccount } from "../../lib/agent/account";
import { CueSection } from "./CueSection";
import { BrowserSection } from "./BrowserSection";
import { AgentSection } from "./AgentSection";
import { AgentsSection } from "./AgentsSection";
import { getSetting } from "../../lib/settings";
import FileIcon from "../FileIcon";
import { loadApiKey, saveApiKey, deleteApiKey } from "../../lib/secrets";
import {
  loadCustomModels,
  saveCustomModel,
  removeCustomModel,
  subscribeCustomModels,
  emitCustomModelsChanged,
  newCustomModelKey,
  validateEndpointUrl,
  isCustomModelKey,
  API_FORMAT_LABELS,
  DEFAULT_TOOL_CALL_ROUNDS,
  DISPLAY_NAME_MAX,
  type ApiFormat,
  type StoredCustomModel,
} from "../../lib/agent/customModels";
import { accentForModel } from "../ai/providers";
import { useTheme, builtinThemes } from "../../themes/ThemeContext";
import type { OriginTheme } from "../../themes/types";
import { detectDevEnvironment, type ToolInfo } from "../../lib/env";
import { loadDevEnvPrefs, saveDevEnvPrefs, type DevEnvPrefs } from "../../lib/devEnv";
import { notifyAutoSaveChanged, type AutoSaveMode } from "../../lib/autoSavePrefs";
import { TOAST_PREF_KEY } from "../../lib/notify/notify";
import { SOUND_PREF_KEY, SOUND_VOLUME_KEY, playSound } from "../../lib/notify/sound";
import { KNOWN_SERVERS, isKnownServerId } from "../../lib/lspConfig";
import {
  loadGlobalLspConfig,
  saveGlobalLspConfig,
  WORKSPACE_LSP_PATH,
} from "../../lib/lspConfigStore";
import type { LspConfig, LspServerConfig } from "../../lib/lspConfig";
import { probeLspServer, type LspProbeResult } from "../../lib/lspProbe";
import { formatShortcut } from "../../lib/platform";
import {
  loadPermissionMode, savePermissionMode, PERMISSION_MODE_INFO, type PermissionMode,
} from "../../lib/agent/permissions";

// ── Constants ────────────────────────────────────────────────────────────────

type Section =
  | "account" | "general" | "mira-mobile" | "dev-env" | "permission"
  | "agent" | "agents" | "mcp" | "cue" | "models" | "appearance" | "conversation" | "notifications" | "browser"
  | "indexing" | "skills" | "commands" | "rules" | "hooks" | "languages" | "shortcuts" | "beta" | "about";

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
  { id: "mira-mobile",  label: "Mira Mobile",             icon: <Smartphone size={14} />,          keywords: "mobile phone", dividerAfter: true },
  { id: "dev-env",      label: "Development Environment", icon: <Code2 size={14} />,              keywords: "python node interpreter environment" },
  { id: "permission",   label: "Permission Approval",      icon: <ShieldCheck size={14} />,         keywords: "permission approval security" },
  { id: "agent",        label: "Agent",                   icon: <Wrench size={14} />,              keywords: "agent tools" },
  { id: "agents",       label: "Agents",                  icon: <Bot size={14} />,                 keywords: "agents custom agent create prompt tools mcp" },
  { id: "mcp",          label: "MCP",                     icon: <Plug size={14} />,                keywords: "mcp server" },
  { id: "cue",          label: "CUE",                     icon: <Zap size={14} />,                 keywords: "cue" },
  { id: "models",       label: "Models",                  icon: <Cpu size={14} />,                 keywords: "models ai provider api key openai anthropic gemini" },
  { id: "appearance",   label: "Appearance",              icon: <Palette size={14} />,             keywords: "appearance theme color" },
  { id: "conversation", label: "Conversation",            icon: <MessageSquare size={14} />,       keywords: "conversation chat" },
  { id: "notifications", label: "Notifications",          icon: <Bell size={14} />,                keywords: "notifications sound toast alert" },
  { id: "browser",      label: "Browser",                 icon: <Globe size={14} />,               keywords: "browser web preview", dividerAfter: true },
  { id: "indexing",     label: "Indexing & Docs",         icon: <Database size={14} />,            keywords: "indexing docs" },
  { id: "skills",       label: "Skills",                  icon: <Zap size={14} />,                 keywords: "skills agent capabilities" },
  { id: "commands",     label: "Commands",                icon: <Command size={14} />,             keywords: "commands slash commands prompts" },
  { id: "rules",        label: "Rules & Memories",        icon: <ScrollText size={14} />,          keywords: "rules memories" },
  { id: "hooks",        label: "Hooks",                   icon: <Anchor size={14} />,              keywords: "hooks" },
  { id: "languages",    label: "Languages & LSP",         icon: <Code2 size={14} />,               keywords: "languages lsp language server intellisense diagnostics completion hover", dividerAfter: true },
  { id: "shortcuts",    label: "Keyboard Shortcuts",      icon: <Command size={14} />,             keywords: "keyboard shortcuts keybindings hotkeys keys", dividerAfter: true },
  { id: "beta",         label: "Beta",                    icon: <FlaskConical size={14} />,        keywords: "beta experimental", dividerAfter: true },
  { id: "about",        label: "About Mira",              icon: <Info size={14} />,                keywords: "about" },
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

function ComingSoonSection({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "40px 0", color: "var(--origin-fg-subtle)" }}>
      <span style={{ fontSize: "15px", fontWeight: 500, color: "var(--origin-fg-default)" }}>{label}</span>
      <span style={{ fontSize: "12px" }}>Coming soon</span>
    </div>
  );
}

// ── Permission Approval Section ────────────────────────────────────────────────
//
// Sélecteur du mode d'approbation des actions d'agent (pattern Trae/Cline) :
// Manual (confirmer), Auto (règles déterministes), Full Access (aucune
// confirmation, sauf la garde anti-catastrophe non désactivable).

function PermissionSection() {
  const [mode, setMode] = useState<PermissionMode>(() => loadPermissionMode());

  function select(next: PermissionMode) {
    savePermissionMode(next);
    setMode(next);
  }

  const order: PermissionMode[] = ["manual", "auto", "full"];
  const danger = mode === "full";

  return (
    <div style={{ paddingBottom: "24px" }}>
      <SectionHeading>Agent Permissions</SectionHeading>
      <SettingRow
        title="Approval mode"
        description="Choose how Agent actions (file writes, commands) are approved before they run."
      >
        <select
          value={mode}
          onChange={e => select(e.target.value as PermissionMode)}
          style={selectStyle}
        >
          {order.map(m => (
            <option key={m} value={m}>{PERMISSION_MODE_INFO[m].label}</option>
          ))}
        </select>
      </SettingRow>

      <div style={{
        marginTop: "10px", padding: "10px 12px", borderRadius: "6px",
        border: "1px solid var(--origin-border-default)",
        background: danger ? "color-mix(in srgb, #d9822b 12%, transparent)" : "var(--origin-bg-active)",
        fontSize: "12px", color: "var(--origin-fg-muted)", lineHeight: 1.55,
      }}>
        <div style={{ color: danger ? "#d9822b" : "var(--origin-fg-default)", fontWeight: 600, marginBottom: "3px" }}>
          {PERMISSION_MODE_INFO[mode].label}
        </div>
        {PERMISSION_MODE_INFO[mode].desc}
        {danger && (
          <div style={{ marginTop: "6px" }}>
            Full Access runs actions without confirmation. A minimal, non-disableable guard
            still blocks commands that would destroy your machine (fork bomb, <code>rm -rf /</code>,
            <code> mkfs</code>, raw disk writes).
          </div>
        )}
      </div>
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

// ── Models Section ───────────────────────────────────────────────────────────
//
// REFONTE (2026-10) — plus AUCUN catalogue de providers codé en dur.
//
// AVANT : une liste figée de 12 providers avec champs de clé API. Le client ne
// pouvait pas brancher son propre endpoint (proxy d'entreprise, passerelle
// interne, modèle auto-hébergé) sans passer par un provider « connu ».
//
// APRÈS : le client DÉCLARE ses modèles. Chaque entrée porte son format d'API,
// son URL, son id de modèle et sa clé. Ces modèles apparaissent ensuite partout
// où l'on choisit un modèle (sélecteur de l'input, actions utilitaires).
//
// La clé API n'est JAMAIS stockée dans le store des modèles : elle part dans le
// keychain OS, sous le compte `provider:<clé du modèle>` (cf. `secrets.ts`).

/** État d'édition de la modale « Custom Model ». */
interface ModelDraft {
  key: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  fullUrl: boolean;
  modelId: string;
  displayName: string;
  modelSeries: string;
  contextInput: string;
  contextOutput: string;
  toolCallRounds: string;
}

function emptyDraft(): ModelDraft {
  return {
    key: newCustomModelKey(),
    apiFormat: "openai-chat",
    baseUrl: "",
    fullUrl: false,
    modelId: "",
    displayName: "",
    modelSeries: "",
    contextInput: "",
    contextOutput: "",
    toolCallRounds: String(DEFAULT_TOOL_CALL_ROUNDS),
  };
}

function draftFromStored(m: StoredCustomModel): ModelDraft {
  return {
    key: m.key,
    apiFormat: m.apiFormat,
    baseUrl: m.baseUrl,
    fullUrl: m.fullUrl,
    modelId: m.modelId,
    displayName: m.displayName,
    modelSeries: m.modelSeries,
    contextInput: m.contextInput === null ? "" : String(m.contextInput),
    contextOutput: m.contextOutput === null ? "" : String(m.contextOutput),
    toolCallRounds: m.toolCallRounds === null ? "" : String(m.toolCallRounds),
  };
}

/** Champ numérique vide → `null` (défaut optimal du moteur). */
function parseOptionalInt(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

const INPUT_FIELD_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--origin-border-default)",
  backgroundColor: "var(--origin-bg-base)",
  color: "var(--origin-fg-default)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const FIELD_LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--origin-fg-default)",
  marginBottom: 6,
};

const FIELD_HELP_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: "var(--origin-fg-subtle)",
  lineHeight: 1.5,
  marginBottom: 6,
};

/** Astérisque rouge des champs obligatoires. */
function RequiredMark() {
  return <span style={{ color: "var(--origin-semantic-error, #f85149)", marginRight: 4 }}>*</span>;
}

/**
 * Modale de déclaration d'un modèle (calquée sur la modale « Custom Model »
 * des IDE d'agent modernes : format d'API, URL, id, libellé, clé, options
 * avancées repliables).
 */
function CustomModelModal({ initial, onClose, onSaved }: {
  initial: StoredCustomModel | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => initial ? draftFromStored(initial) : emptyDraft());
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = useCallback((patch: Partial<ModelDraft>) => {
    setDraft(prev => ({ ...prev, ...patch }));
  }, []);

  // Clé existante : on la précharge (le keychain est la source de vérité), sans
  // jamais l'exposer en clair tant que l'œil n'est pas activé.
  useEffect(() => {
    let alive = true;
    if (!initial) return;
    void loadApiKey(initial.key).then(k => { if (alive && k) setApiKey(k); }).catch(() => {});
    return () => { alive = false; };
  }, [initial]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setError(null);
    const modelId = draft.modelId.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) return setError("Custom Request URL is required.");
    const urlCheck = validateEndpointUrl(baseUrl);
    if (!urlCheck.ok) return setError(urlCheck.reason);
    if (!modelId) return setError("Model ID is required.");
    if (!apiKey.trim()) return setError("API Key is required.");

    setSaving(true);
    try {
      saveCustomModel({
        key: draft.key,
        displayName: draft.displayName.trim().slice(0, DISPLAY_NAME_MAX) || modelId,
        apiFormat: draft.apiFormat,
        baseUrl,
        fullUrl: draft.fullUrl,
        modelId,
        modelSeries: draft.modelSeries.trim(),
        contextInput: parseOptionalInt(draft.contextInput),
        contextOutput: parseOptionalInt(draft.contextOutput),
        toolCallRounds: parseOptionalInt(draft.toolCallRounds),
      });
      await saveApiKey(draft.key, apiKey.trim());
      emitCustomModelsChanged();
      onSaved();
      onClose();
    } catch {
      setError("Could not save this model. Check the values and try again.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10001,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{
        width: "100%", maxWidth: 620, maxHeight: "90vh",
        display: "flex", flexDirection: "column",
        backgroundColor: "var(--origin-bg-sidebar)",
        border: "1px solid var(--origin-border-default)",
        borderRadius: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px",
          borderBottom: "1px solid var(--origin-border-default)",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--origin-fg-muted)", display: "flex", padding: 0 }}
          >
            <ChevronLeft size={17} />
          </button>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: "var(--origin-fg-default)" }}>
            {initial ? "Edit Model" : "Custom Model"}
          </span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--origin-fg-muted)", display: "flex", padding: 0 }}
          >
            <X size={17} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
          {/* API Format */}
          <div style={{ marginBottom: 16 }}>
            <div style={FIELD_LABEL_STYLE}><RequiredMark />API Format</div>
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setFormatOpen(o => !o)}
                style={{
                  ...INPUT_FIELD_STYLE,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <span>{API_FORMAT_LABELS[draft.apiFormat]}</span>
                <ChevronDown size={15} style={{ color: "var(--origin-fg-subtle)", transform: formatOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
              </button>
              {formatOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 2,
                  backgroundColor: "var(--origin-bg-base)",
                  border: "1px solid var(--origin-border-default)",
                  borderRadius: 8,
                  overflow: "hidden",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                }}>
                  {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map(f => (
                    <button
                      key={f}
                      onClick={() => { set({ apiFormat: f }); setFormatOpen(false); }}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                        gap: 10, padding: "10px 12px", border: "none", background: "transparent",
                        cursor: "pointer", textAlign: "left",
                        fontSize: 13, color: "var(--origin-fg-default)",
                      }}
                    >
                      {API_FORMAT_LABELS[f]}
                      {f === draft.apiFormat && <Check size={14} style={{ color: "var(--origin-accent-blue)" }} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Custom Request URL */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={FIELD_LABEL_STYLE}><RequiredMark />Custom Request URL</span>
              <button
                onClick={() => set({ fullUrl: !draft.fullUrl })}
                style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                <Link2 size={13} style={{ color: "var(--origin-fg-muted)" }} />
                <span style={{ fontSize: 12.5, color: "var(--origin-fg-muted)" }}>Full URL</span>
                <Toggle on={draft.fullUrl} onToggle={() => set({ fullUrl: !draft.fullUrl })} />
              </button>
            </div>
            <div style={FIELD_HELP_STYLE}>
              {draft.fullUrl
                ? "The full request URL is used as-is, with no path appended."
                : `Enter the API endpoint without a trailing slash. ${draft.apiFormat === "anthropic" ? "/messages" : draft.apiFormat === "openai-responses" ? "/responses" : "/chat/completions"} will be appended to the URL you provide.`}
            </div>
            <input
              value={draft.baseUrl}
              onChange={e => set({ baseUrl: e.target.value })}
              placeholder="e.g. https://api.openai.com/v1"
              style={{ ...INPUT_FIELD_STYLE, fontFamily: "var(--font-mono)" }}
            />
          </div>

          {/* Model ID */}
          <div style={{ marginBottom: 16 }}>
            <div style={FIELD_LABEL_STYLE}><RequiredMark />Model ID</div>
            <input
              value={draft.modelId}
              onChange={e => set({ modelId: e.target.value })}
              placeholder="Input Model ID"
              style={{ ...INPUT_FIELD_STYLE, fontFamily: "var(--font-mono)" }}
            />
          </div>

          {/* Display Name */}
          <div style={{ marginBottom: 16 }}>
            <div style={FIELD_LABEL_STYLE}>Display Name</div>
            <div style={FIELD_HELP_STYLE}>Name shown in the model list. Defaults to Model ID if not set.</div>
            <div style={{ position: "relative" }}>
              <input
                value={draft.displayName}
                maxLength={DISPLAY_NAME_MAX}
                onChange={e => set({ displayName: e.target.value })}
                placeholder="Input Display Name"
                style={{ ...INPUT_FIELD_STYLE, paddingRight: 50 }}
              />
              <span style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                fontSize: 12, color: "var(--origin-fg-subtle)", pointerEvents: "none",
              }}>
                {draft.displayName.length}/{DISPLAY_NAME_MAX}
              </span>
            </div>
          </div>

          {/* API Key */}
          <div style={{ marginBottom: 16 }}>
            <div style={FIELD_LABEL_STYLE}><RequiredMark />API Key</div>
            <div style={{ position: "relative" }}>
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Enter API Key"
                style={{ ...INPUT_FIELD_STYLE, paddingRight: 36, fontFamily: "var(--font-mono)" }}
              />
              <button
                onClick={() => setShowKey(v => !v)}
                tabIndex={-1}
                style={{
                  position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--origin-fg-subtle)", padding: 0, display: "flex",
                }}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div style={{ ...FIELD_HELP_STYLE, marginTop: 6, marginBottom: 0 }}>
              Stored in your OS keychain. It never leaves your device.
            </div>
          </div>

          {/* Advanced Settings */}
          <div style={{ borderTop: "1px solid var(--origin-border-default)", paddingTop: 14 }}>
            <button
              onClick={() => setAdvanced(a => !a)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "none", border: "none", cursor: "pointer", padding: 0,
                fontSize: 13, fontWeight: 600, color: "var(--origin-fg-default)",
              }}
            >
              Advanced Settings
              <ChevronRight size={14} style={{ color: "var(--origin-fg-subtle)", transform: advanced ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
            </button>

            {advanced && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Model Series */}
                <div>
                  <div style={FIELD_LABEL_STYLE}>Model Series</div>
                  <div style={FIELD_HELP_STYLE}>
                    Optimized prompts and hyperparameters for the selected series. Uses default config if unselected.
                  </div>
                  <input
                    value={draft.modelSeries}
                    onChange={e => set({ modelSeries: e.target.value })}
                    placeholder="Default"
                    style={INPUT_FIELD_STYLE}
                  />
                </div>

                {/* Context Window */}
                <div>
                  <div style={FIELD_LABEL_STYLE}>Context Window (Token)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {([
                      { label: "Input", field: "contextInput" as const, presets: [128000, 256000, 512000, 1000000], presetLabels: ["128k", "256k", "512k", "1M"] },
                      { label: "Output", field: "contextOutput" as const, presets: [4000, 16000, 32000, 128000], presetLabels: ["4k", "16k", "32k", "128k"] },
                    ]).map(row => (
                      <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 52, flexShrink: 0, fontSize: 12.5, color: "var(--origin-fg-muted)" }}>{row.label}</span>
                        <input
                          value={draft[row.field]}
                          onChange={e => set({ [row.field]: e.target.value } as Partial<ModelDraft>)}
                          placeholder="Enter a value. Leave empty for optimal default"
                          style={{ ...INPUT_FIELD_STYLE, flex: 1, minWidth: 0 }}
                        />
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          {row.presets.map((val, i) => (
                            <button
                              key={val}
                              onClick={() => set({ [row.field]: String(val) } as Partial<ModelDraft>)}
                              style={{
                                background: "none", border: "none", cursor: "pointer", padding: 0,
                                fontSize: 12, color: "var(--origin-accent-blue)",
                                textDecoration: "underline", textUnderlineOffset: 2,
                              }}
                            >
                              {row.presetLabels[i]}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Tool Call Rounds */}
                <div>
                  <div style={FIELD_LABEL_STYLE}>Tool Call Rounds</div>
                  <input
                    value={draft.toolCallRounds}
                    onChange={e => set({ toolCallRounds: e.target.value.replace(/[^0-9]/g, "") })}
                    placeholder={String(DEFAULT_TOOL_CALL_ROUNDS)}
                    inputMode="numeric"
                    style={INPUT_FIELD_STYLE}
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div style={{
              marginTop: 14, padding: "8px 10px", borderRadius: 6,
              fontSize: 12.5, color: "var(--origin-semantic-error, #f85149)",
              backgroundColor: "color-mix(in srgb, var(--origin-semantic-error, #f85149) 12%, transparent)",
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "12px 16px",
          borderTop: "1px solid var(--origin-border-default)",
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <Info size={13} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              The connectivity test sends one real request and consumes a small number of tokens.
            </span>
          </div>
          <button
            onClick={() => { setDraft(initial ? draftFromStored(initial) : emptyDraft()); setApiKey(""); setError(null); }}
            style={{
              padding: "7px 14px", borderRadius: 6,
              border: "1px solid var(--origin-border-default)",
              backgroundColor: "transparent", color: "var(--origin-fg-muted)",
              fontSize: 13, fontWeight: 500, cursor: "pointer", flexShrink: 0,
            }}
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "7px 16px", borderRadius: 6, border: "none",
              backgroundColor: "var(--origin-accent-blue, #3b82f6)", color: "#fff",
              fontSize: 13, fontWeight: 600, cursor: saving ? "default" : "pointer", flexShrink: 0,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {initial ? "Save" : "Add Model"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function AIProvidersSection() {
  const [models, setModels] = useState<StoredCustomModel[]>(() => loadCustomModels());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StoredCustomModel | null>(null);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});

  // Le store notifie l'UI (même onglet) : la liste se rafraîchit après ajout,
  // édition ou suppression, sans rechargement de page.
  useEffect(() => {
    const refresh = () => setModels(loadCustomModels());
    return subscribeCustomModels(refresh);
  }, []);

  // Indicateur « clé enregistrée » : la clé vit dans le keychain, pas dans le
  // store — on la sonde donc à part, une fois par clé affichée.
  useEffect(() => {
    let alive = true;
    models.forEach(async m => {
      const k = await loadApiKey(m.key).catch(() => null);
      if (alive) setKeyStatus(prev => ({ ...prev, [m.key]: !!k }));
    });
    return () => { alive = false; };
  }, [models]);

  const openNew = useCallback(() => { setEditing(null); setModalOpen(true); }, []);
  const openEdit = useCallback((m: StoredCustomModel) => { setEditing(m); setModalOpen(true); }, []);

  async function handleDelete(m: StoredCustomModel) {
    removeCustomModel(m.key);
    // La clé keychain suit la vie du modèle : on ne laisse pas de secret
    // orphelin derrière une entrée supprimée.
    if (isCustomModelKey(m.key)) await deleteApiKey(m.key).catch(() => {});
    emitCustomModelsChanged();
  }

  return (
    <div style={{ padding: "2px 0 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <SectionHeading>Models</SectionHeading>
          <p style={{ fontSize: 12, color: "var(--origin-fg-muted)", margin: "2px 0 0", lineHeight: 1.5 }}>
            Add your own models by supplying the API endpoint, key and model ID. They become
            available in the model selector everywhere in the app.
          </p>
        </div>
        <button
          onClick={openNew}
          style={{
            display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
            padding: "7px 14px", borderRadius: 6, border: "none",
            backgroundColor: "var(--origin-accent-blue, #3b82f6)", color: "#fff",
            fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          <Plus size={15} />
          Add Model
        </button>
      </div>

      {models.length === 0 ? (
        <div style={{
          marginTop: 16, padding: "28px 16px", textAlign: "center",
          borderRadius: 8, border: "1px dashed var(--origin-border-default)",
          color: "var(--origin-fg-subtle)", fontSize: 12.5, lineHeight: 1.6,
        }}>
          No models configured yet.<br />Click “Add Model” to connect your first endpoint.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
          {models.map(m => {
            const accent = accentForModel(m.key);
            const hasKey = keyStatus[m.key];
            return (
              <div
                key={m.key}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 8,
                  border: "1px solid var(--origin-border-default)",
                  backgroundColor: "var(--origin-bg-base)",
                }}
              >
                <div style={{
                  width: 28, height: 28, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: 6, backgroundColor: accent,
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#fff" }}>
                    {m.displayName.slice(0, 2).toUpperCase()}
                  </span>
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--origin-fg-default)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m.displayName}
                    </span>
                    {hasKey && <Check size={11} style={{ color: "var(--origin-semantic-success)", flexShrink: 0 }} />}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {API_FORMAT_LABELS[m.apiFormat]} · {m.modelId}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => openEdit(m)}
                    style={{
                      padding: "5px 12px", borderRadius: 6,
                      border: "1px solid var(--origin-border-default)",
                      backgroundColor: "transparent", color: "var(--origin-fg-default)",
                      fontSize: 12, cursor: "pointer",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void handleDelete(m)}
                    title="Remove model"
                    style={{
                      padding: "5px 8px", borderRadius: 6,
                      border: "1px solid var(--origin-border-default)",
                      backgroundColor: "transparent", color: "var(--origin-fg-muted)",
                      cursor: "pointer", display: "flex", alignItems: "center",
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <CustomModelModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => setModels(loadCustomModels())}
        />
      )}
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
          No colour theme from an extension is installed yet. Installing a theme extension makes
          it appear here automatically (e.g. <span style={{ color: "var(--origin-fg-default)" }}>One Dark Pro</span>).
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

// ── Conversation Section ───────────────────────────────────────────────────────

/**
 * Réglages de la liste de conversations/tâches.
 * L'auto-fold replie les groupes de tâches entièrement terminés dans le TaskRail
 * (mode AI), exactement comme « To-Do List » > auto-collapse chez Trae.
 */
export const AUTO_FOLD_KEY = 'origin-conversation-auto-fold';

function ConversationSection() {
  const [autoFold, setAutoFold] = useState(
    () => localStorage.getItem(AUTO_FOLD_KEY) !== 'false'
  );

  function toggleAutoFold() {
    const next = !autoFold;
    setAutoFold(next);
    localStorage.setItem(AUTO_FOLD_KEY, String(next));
    // Prévient le TaskRail déjà monté (même onglet) sans rechargement.
    window.dispatchEvent(new CustomEvent('origin:conversation-prefs', { detail: { autoFold: next } }));
  }

  return (
    <div>
      <SectionHeading>Conversation history</SectionHeading>
      <SettingRow
        title="Auto-fold completed tasks"
        description="Fold groups of tasks that are entirely completed in the task list. Active tasks always stay visible."
      >
        <Toggle on={autoFold} onToggle={toggleAutoFold} />
      </SettingRow>
    </div>
  );
}

// ── Notifications Section ────────────────────────────────────────────────────
//
// Notifications de fin de travail, façon Trae : un TOAST (visuel) et un SON aux
// moments clés du cycle de l'agent — fin de tâche (surtout en arrière-plan),
// question posée (« ask user »), erreur et arrêt volontaire. Les préférences
// sont des clés localStorage PLATES, lues directement par les modules de
// notification (notify.ts / sound.ts) : aucun état React partagé nécessaire.

function NotificationsSection() {
  const [toast, setToast] = useState(() => localStorage.getItem(TOAST_PREF_KEY) !== 'false');
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_PREF_KEY) !== 'false');
  const [volume, setVolume] = useState(() => {
    const raw = Number.parseInt(localStorage.getItem(SOUND_VOLUME_KEY) ?? '', 10);
    return Number.isNaN(raw) ? 60 : Math.min(100, Math.max(0, raw));
  });

  function toggleToast() {
    const next = !toast;
    setToast(next);
    localStorage.setItem(TOAST_PREF_KEY, String(next));
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    localStorage.setItem(SOUND_PREF_KEY, String(next));
    // Retour immédiat : on rejoue le son « finish » pour que l'utilisateur
    // entende ce qu'il vient d'activer (force = on ignore la préférence qu'on
    // vient d'écrire, sinon l'écriture est déjà prise en compte).
    if (next) playSound('finish', { force: true });
  }

  function changeVolume(v: number) {
    setVolume(v);
    localStorage.setItem(SOUND_VOLUME_KEY, String(v));
  }

  return (
    <div>
      <SectionHeading>Notifications</SectionHeading>
      <SettingRow
        title="Show notifications"
        description="Display a toast when a background task finishes, when the agent asks a question, or when a run fails or is stopped."
      >
        <Toggle on={toast} onToggle={toggleToast} />
      </SettingRow>
      <SettingRow
        title="Notification sound"
        description="Play a short synthesized sound at the same key moments (task finished, question, error, stop)."
      >
        <Toggle on={sound} onToggle={toggleSound} />
      </SettingRow>
      <SettingRow title="Sound volume" description="Loudness of the notification sounds.">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          disabled={!sound}
          onChange={e => changeVolume(Number(e.target.value))}
          onMouseUp={() => sound && playSound('finish', { force: true })}
          style={{ width: 140, cursor: sound ? 'pointer' : 'not-allowed', opacity: sound ? 1 : 0.5 }}
        />
        <span style={{ fontSize: 12, color: 'var(--origin-fg-muted)', width: 34, textAlign: 'right' }}>{volume}%</span>
      </SettingRow>
    </div>
  );
}

// ── General Section ──────────────────────────────────────────────────────────

const AUTOCOMPLETE_DELAY_KEY = 'origin-editor-autocomplete-delay';
const AUTOCOMPLETE_DELAY_UNIT_KEY = 'origin-editor-autocomplete-delay-unit';
const AUTOCOMPLETE_DELAY_DEFAULT_MS = 350;
const FORMAT_ON_SAVE_KEY = 'origin-editor-format-on-save';
const AUTOSAVE_MODE_KEY = 'origin-editor-autosave';
const AUTOSAVE_DELAY_KEY = 'origin-editor-autosave-delay';
const AUTOSAVE_DELAY_DEFAULT_MS = 1000;

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
  const [formatOnSave, setFormatOnSave] = useState(
    () => localStorage.getItem(FORMAT_ON_SAVE_KEY) !== 'false'
  );
  const [autoSaveMode, setAutoSaveMode] = useState<AutoSaveMode>(
    () => (localStorage.getItem(AUTOSAVE_MODE_KEY) as AutoSaveMode | null) ?? 'off'
  );
  const [autoSaveDelay, setAutoSaveDelay] = useState(
    () => parseInt(localStorage.getItem(AUTOSAVE_DELAY_KEY) ?? String(AUTOSAVE_DELAY_DEFAULT_MS), 10)
  );
  const [autoSaveDelayInput, setAutoSaveDelayInput] = useState(
    () => String(parseInt(localStorage.getItem(AUTOSAVE_DELAY_KEY) ?? String(AUTOSAVE_DELAY_DEFAULT_MS), 10))
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

  function toggleFormatOnSave() {
    const next = !formatOnSave;
    localStorage.setItem(FORMAT_ON_SAVE_KEY, next ? 'true' : 'false');
    setFormatOnSave(next);
  }

  function changeAutoSaveMode(next: AutoSaveMode) {
    setAutoSaveMode(next);
    localStorage.setItem(AUTOSAVE_MODE_KEY, next);
    notifyAutoSaveChanged();
  }

  function commitAutoSaveDelay(raw: string) {
    const ms = parseInt(raw, 10);
    if (Number.isFinite(ms) && ms > 0) {
      setAutoSaveDelay(ms);
      setAutoSaveDelayInput(String(ms));
      localStorage.setItem(AUTOSAVE_DELAY_KEY, String(ms));
      notifyAutoSaveChanged();
    } else {
      setAutoSaveDelayInput(String(autoSaveDelay));
    }
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

      <SectionHeading>Editor</SectionHeading>
      <SettingRow
        title="Format on save"
        description="Run the language server formatter on the active file before it is written to disk."
      >
        <Toggle on={formatOnSave} onToggle={toggleFormatOnSave} />
      </SettingRow>

      <SettingRow
        title="Auto Save"
        description="Automatically save modified files. 'On Focus Change' saves when the editor loses focus; 'On Window Change' when the window does."
      >
        <select
          value={autoSaveMode}
          onChange={e => changeAutoSaveMode(e.target.value as AutoSaveMode)}
          style={selectStyle}
        >
          <option value="off">Off</option>
          <option value="afterDelay">After Delay</option>
          <option value="onFocusChange">On Focus Change</option>
          <option value="onWindowChange">On Window Change</option>
        </select>
      </SettingRow>

      {autoSaveMode === 'afterDelay' && (
        <SettingRow
          title="Auto Save Delay"
          description="Wait time after typing stops before saving the file."
        >
          <input
            type="number"
            min={100}
            step={50}
            value={autoSaveDelayInput}
            onChange={e => setAutoSaveDelayInput(e.target.value)}
            onBlur={e => { e.currentTarget.style.borderColor = "var(--origin-border-default)"; commitAutoSaveDelay(e.target.value); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = "var(--origin-fg-muted)"; }}
          />
          <span style={{ fontSize: "12px", color: "var(--origin-fg-muted)" }}>ms</span>
        </SettingRow>
      )}
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

/** Badge de disponibilité du binaire d'un serveur LSP (issu du probe Rust). */
function ServerStatusBadge({ status }: { status: LspProbeResult | 'loading' | 'error' | undefined }) {
  let color = "var(--origin-fg-subtle)";
  let label = "…";
  let title = "Checking availability…";
  if (status === 'error') {
    color = "var(--origin-fg-subtle)";
    label = "n/a";
    title = "Could not run the availability check";
  } else if (status && status !== 'loading') {
    if (status.found) {
      color = "var(--origin-semantic-success, #2ea043)";
      label = "found";
      const src = status.source === 'extension'
        ? 'bundled extension'
        : status.source === 'serverPath'
          ? 'configured path'
          : status.source === 'app'
            ? 'local install'
            : 'PATH';
      title = `Found via ${src}\n${status.path ?? ""}`;
    } else {
      color = "var(--origin-semantic-error, #f85149)";
      label = "not found";
      title = `Searched: ${status.searched.join(", ") || "PATH"}`;
    }
  } else if (status === 'loading') {
    label = "…";
  }
  return (
    <span
      title={title}
      style={{
        fontSize: 10, color, border: "1px solid currentColor", borderRadius: 4,
        padding: "0 4px", whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function LspSection() {
  // État local, initialisé depuis la config globale (localStorage).
  const [config, setConfig] = useState<LspConfig>(() => loadGlobalLspConfig());
  const [saved, setSaved] = useState(false);
  // Diagnostic par serveur : statut de disponibilité du binaire (probe Rust).
  const [probe, setProbe] = useState<Record<string, LspProbeResult | 'loading' | 'error'>>({});

  const knownIds = useMemo(() => new Set(KNOWN_SERVERS.map(s => s.id)), []);

  /** Interroge la disponibilité de tous les serveurs configurés. */
  const runProbe = useCallback(async (servers: LspServerConfig[]) => {
    // On ne met à jour le state qu'à la résolution de chaque probe : l'absence
    // d'entrée est interprétée comme « en cours » par le badge de statut.
    await Promise.all(servers.map(async s => {
      try {
        const result = await probeLspServer(s.serverId, s.serverPath);
        setProbe(prev => ({ ...prev, [s.serverId]: result }));
      } catch {
        setProbe(prev => ({ ...prev, [s.serverId]: 'error' }));
      }
    }));
  }, []);

  useEffect(() => { void runProbe(config.servers); }, [runProbe, config.servers]);

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
        extensions and controls how they are launched. The status badge shows whether the server binary
        was found on this machine.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button
          onClick={() => void runProbe(config.servers)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "5px 10px", borderRadius: 6, fontSize: 12,
            border: "1px solid var(--origin-border-default)",
            backgroundColor: "transparent", color: "var(--origin-fg-default)", cursor: "pointer",
          }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "var(--origin-bg-hover)"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <RefreshCw size={12} /> Rescan servers
        </button>
      </div>

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
                <ServerStatusBadge status={probe[server.serverId]} />
                <div style={{ flex: 1 }} />
                <Toggle on={!disabled} onToggle={() => toggleEnabled(idx)} />
                <TinyButton onClick={() => removeServer(idx)} title="Remove server" danger>
                  <X size={13} />
                </TinyButton>
              </div>

              {(() => {
                const info = KNOWN_SERVERS.find(s => s.id === server.serverId);
                if (!info?.needs) return null;
                const reason =
                  info.needs === 'NEEDS_GO_TOOLCHAIN'
                    ? 'Go toolchain required (gopls installs via "go install")'
                    : info.needs === 'NEEDS_LLVM_TOOLCHAIN'
                      ? 'LLVM toolchain required (clangd ships with LLVM)'
                      : 'Java toolchain required (install a JDK, then jdtls)';
                return (
                  <div style={{ fontSize: 11.5, color: "var(--origin-fg-subtle)", marginTop: 4, fontFamily: "var(--font-sans)" }}>
                    {reason}
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
                <label style={{ flex: "2 1 260px", minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--origin-fg-subtle)", marginBottom: 4 }}>
                    Server path <span style={{ opacity: 0.7 }}>(optional — overrides PATH)</span>
                  </div>
                  <input
                    defaultValue={server.serverPath ?? ""}
                    placeholder="/absolute/path/to/server"
                    onBlur={e => {
                      const v = e.target.value.trim();
                      updateServer(idx, { serverPath: v || undefined });
                    }}
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
  /** Onglet à ouvrir au montage (ex. « agents » depuis « Create Agent »). */
  initialSection?: string;
}

export default function SettingsPanel({ onClose, initialSection }: SettingsPanelProps) {
  const [section, setSection] = useState<Section>((initialSection as Section) ?? "dev-env");
  const [query, setQuery] = useState("");
  // Métadonnées de compte Mira (non sensibles), pour l'en-tête de la sidebar.
  // `signedIn` vient d'une source fiable (jeton côté Rust), pas du cache local :
  // un `localStorage` résiduel ne doit pas afficher une identité ni un plan.
  const { signedIn, account } = useAccount();
  // Dossier de projet courant, nécessaire aux pages Skills/Commands/Hooks pour
  // proposer la portée « projet » (`.mira` du workspace). Chargé au montage.
  const [workspace, setWorkspace] = useState<string | undefined>(undefined);
  useEffect(() => {
    void getSetting("workspace.folder").then(p => setWorkspace(p || undefined));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Ouverture ciblée depuis un autre composant (ex. « Create Agent » de l'input
  // chat) : `origin-open-settings` avec `{ section }` présélectionne l'onglet.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ section?: Section }>).detail;
      if (detail?.section) setSection(detail.section);
    }
    window.addEventListener("origin-open-settings", onOpen);
    return () => window.removeEventListener("origin-open-settings", onOpen);
  }, []);

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
          {/* Account header — reflète l'état de connexion réel. Masqué tant que
              l'utilisateur n'est pas connecté : on n'affiche pas d'identité ni
              de plan inventés. */}
          {signedIn && account && (
            <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px 16px" }}>
              <div style={{
                width: 40, height: 40, borderRadius: "10px",
                backgroundColor: "var(--origin-accent-blue)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: "17px", fontWeight: 700, flexShrink: 0,
              }}>
                {(account.email?.trim()?.[0] ?? "?").toUpperCase()}
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--origin-fg-default)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {account.email ?? "Mira account"}
                </span>
                {account.plan && (
                  <span style={{
                    fontSize: "10px", fontWeight: 600, color: "#10b981",
                    backgroundColor: "rgba(16,185,129,0.12)",
                    padding: "1px 6px", borderRadius: "4px", alignSelf: "flex-start",
                    marginTop: 3,
                  }}>
                    {account.plan}
                  </span>
                )}
              </div>
            </div>
          )}

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
              placeholder={`${formatShortcut("ctrl+f")} to search`}
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
            {section === "account"     && <AccountSection />}
            {section === "dev-env"     && <DevEnvironmentSection />}
            {section === "permission"  && <PermissionSection />}
            {section === "models"      && <AIProvidersSection />}
            {section === "appearance"  && <AppearanceSection />}
            {section === "general"     && <GeneralSection />}
            {section === "conversation" && <ConversationSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "skills"      && <SkillsSection workspace={workspace} />}
            {section === "commands"    && <CommandsSection workspace={workspace} />}
            {section === "rules"       && <RulesMemoriesSection workspace={workspace} />}
            {section === "mcp"         && <McpSection />}
            {section === "hooks"       && <HooksSection workspace={workspace} />}
            {section === "indexing"    && <IndexingSection workspace={workspace} />}
            {section === "cue"         && <CueSection />}
            {section === "browser"     && <BrowserSection workspace={workspace} />}
            {section === "agent"       && <AgentSection />}
            {section === "agents"      && <AgentsSection />}
            {section === "about"       && <AboutSection />}
            {section === "shortcuts"   && <KeybindingsSection />}
            {section === "languages"   && <LspSection />}
            {!["account", "dev-env", "permission", "models", "appearance", "general", "conversation", "notifications", "skills", "commands", "rules", "mcp", "hooks", "indexing", "cue", "browser", "agent", "agents", "about", "shortcuts", "languages"].includes(section) && (
              <ComingSoonSection label={NAV_ITEMS.find(s => s.id === section)?.label ?? ""} />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
