import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Puzzle, Trash2, RefreshCw, Download, FileCode2, AlertTriangle, Package,
  Search, Loader2, Check, BadgeCheck, Star, Play, Square, ChevronDown, ChevronRight, ShieldCheck,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  installExtension, uninstallExtension, marketSearch, marketInstall,
  type ExtensionInfo, type MarketExtension,
} from "../lib/extensions";
import { useExtensions, revokeConsent } from "../context/ExtensionsContext";
import { useTheme } from "../themes/ThemeContext";
import {
  CAPABILITY_INFO, consentStatus, requiredCapabilities, setGrantedCapabilities,
  type Capability,
} from "../lib/extensions/permissions";
import type { ExtensionHostRecord } from "../lib/extensions/host";

type Tab = "installed" | "marketplace";

/** Compact number formatting for download counts. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 22, height: 22, border: "none", borderRadius: 4,
  background: "transparent", cursor: "pointer", color: "var(--origin-fg-muted)",
};

/**
 * Extensions sidebar panel.
 *
 * Two tabs:
 *  - Installed  : extensions extracted locally, install-from-`.vsix`, uninstall.
 *  - Marketplace: search the Open VSX registry and install directly.
 *
 * Level 1 only: assets (grammars/snippets/themes) are used, no code is run.
 */
export default function ExtensionsPanel() {
  const { extensions, loading, error, reload, activate, deactivate, hostRecords } = useExtensions();
  const { refreshThemes } = useTheme();
  const [tab, setTab] = useState<Tab>("installed");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Extension awaiting a consent decision (opens the permissions modal). */
  const [consentFor, setConsentFor] = useState<ExtensionInfo | null>(null);

  const recordById = useMemo(() => {
    const map = new Map<string, ExtensionHostRecord>();
    for (const r of hostRecords) map.set(r.extensionId, r);
    return map;
  }, [hostRecords]);

  // --- Marketplace state ---------------------------------------------------
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketExtension[]>([]);
  const [searching, setSearching] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const installedIds = useMemo(() => new Set(extensions.map(e => e.id)), [extensions]);

  useEffect(() => { setNotice(null); }, [extensions.length]);

  // Debounced marketplace search. A sequence guard drops stale responses so a
  // slow earlier request can never overwrite a newer one. All state updates run
  // inside the timer callback (never synchronously in the effect body).
  useEffect(() => {
    if (tab !== "marketplace") return;
    const q = query.trim();
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      if (seq !== searchSeq.current) return;
      if (q.length === 0) {
        setResults([]);
        setMarketError(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const res = await marketSearch(q);
        if (seq !== searchSeq.current) return;
        setResults(res.extensions);
        setMarketError(null);
      } catch (e) {
        if (seq !== searchSeq.current) return;
        setMarketError(String(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, tab]);

  async function handleInstallFromFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "VS Code Extension", extensions: ["vsix"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setBusy(true);
    setNotice(null);
    try {
      const info = await installExtension(selected);
      await reload();
      await refreshThemes();
      setNotice(`Installed ${info.display_name}`);
    } catch (e) {
      setNotice(`Install failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall(id: string, label: string) {
    setBusy(true);
    try {
      await deactivate(id);
      await uninstallExtension(id);
      revokeConsent(id); // never leave stale permissions behind
      await reload();
      await refreshThemes();
      setNotice(`Removed ${label}`);
    } catch (e) {
      setNotice(`Uninstall failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Toggle an extension's code on/off, prompting for consent when needed. */
  const handleToggleActive = useCallback(async (ext: ExtensionInfo) => {
    const rec = recordById.get(ext.id);
    if (rec?.state === "active") {
      setBusy(true);
      try {
        await deactivate(ext.id);
      } finally {
        setBusy(false);
      }
      return;
    }
    const required = requiredCapabilities({
      main: ext.main, commands: ext.commands, activation_events: ext.activation_events,
    });
    if (required.length > 0 && !consentStatus(ext.id, required).granted) {
      setConsentFor(ext); // ask first — nothing runs without approval
      return;
    }
    setBusy(true);
    try {
      await activate(ext);
    } catch (e) {
      setNotice(`Activation failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [recordById, activate, deactivate]);

  const handleGrant = useCallback(async (ext: ExtensionInfo, caps: Capability[]) => {
    setGrantedCapabilities(ext.id, caps);
    setConsentFor(null);
    setBusy(true);
    try {
      await activate(ext);
    } catch (e) {
      setNotice(`Activation failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activate]);

  const handleMarketInstall = useCallback(async (ext: MarketExtension) => {
    setInstallingId(ext.id);
    setNotice(null);
    try {
      const info = await marketInstall(ext.namespace, ext.name, ext.version);
      await reload();
      await refreshThemes();
      setNotice(`Installed ${info.display_name}`);
    } catch (e) {
      setNotice(`Install failed: ${String(e)}`);
    } finally {
      setInstallingId(null);
    }
  }, [reload]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header + tabs */}
      <div className="flex items-center justify-between shrink-0" style={{ padding: "8px 10px 6px" }}>
        <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--origin-fg-muted)" }}>
          Extensions
        </span>
        <div className="flex items-center gap-1">
          {tab === "installed" && (
            <>
              <button onClick={() => void reload()} title="Refresh" disabled={busy || loading}
                style={{ ...iconBtnStyle, cursor: busy || loading ? "default" : "pointer" }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                <RefreshCw size={13} style={{ opacity: loading ? 0.5 : 1 }} />
              </button>
              <button onClick={() => void handleInstallFromFile()} title="Install from VSIX…" disabled={busy}
                style={{ ...iconBtnStyle, cursor: busy ? "default" : "pointer" }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                <Download size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex shrink-0" style={{ padding: "0 8px 6px", gap: 4 }}>
        {(["installed", "marketplace"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              flex: 1, fontSize: "11px", padding: "4px 0", border: "none", borderRadius: 4, cursor: "pointer",
              background: tab === t ? "var(--origin-bg-active)" : "transparent",
              color: tab === t ? "var(--origin-fg-default)" : "var(--origin-fg-muted)",
            }}>
            {t === "installed" ? "Installed" : "Marketplace"}
          </button>
        ))}
      </div>

      {/* Notice / errors (shared) */}
      {notice && (
        <div style={{ padding: "6px 10px", fontSize: "11px", color: "var(--origin-fg-subtle)", borderBottom: "1px solid var(--origin-border-default)" }}>
          {notice}
        </div>
      )}

      {tab === "installed" ? (
        <InstalledList
          extensions={extensions}
          loading={loading}
          error={error}
          busy={busy}
          recordById={recordById}
          onUninstall={handleUninstall}
          onToggleActive={handleToggleActive}
        />
      ) : (
        <MarketplaceList
          query={query}
          onQuery={setQuery}
          results={results}
          searching={searching}
          error={marketError}
          installedIds={installedIds}
          installingId={installingId}
          onInstall={handleMarketInstall}
        />
      )}

      {consentFor && (
        <ConsentModal
          ext={consentFor}
          onCancel={() => setConsentFor(null)}
          onGrant={caps => void handleGrant(consentFor, caps)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed tab
// ---------------------------------------------------------------------------

function InstalledList({ extensions, loading, error, busy, recordById, onUninstall, onToggleActive }: {
  extensions: ExtensionInfo[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  recordById: Map<string, ExtensionHostRecord>;
  onUninstall: (id: string, label: string) => void;
  onToggleActive: (ext: ExtensionInfo) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto">
      {error && (
        <div className="flex items-center gap-2" style={{ padding: "6px 10px", fontSize: "11px", color: "var(--origin-fg-subtle)", borderBottom: "1px solid var(--origin-border-default)" }}>
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      {extensions.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center gap-2" style={{ padding: "32px 16px", color: "var(--origin-fg-subtle)" }}>
          <Puzzle size={22} />
          <p style={{ fontSize: "11px", textAlign: "center", lineHeight: 1.5 }}>
            No extensions installed.
            <br />
            Install a <code>.vsix</code> or browse the Marketplace.
          </p>
        </div>
      )}
      {extensions.map(ext => {
        const rec = recordById.get(ext.id);
        const state = rec?.state ?? "inactive";
        // Le bouton Activer n'a de sens que si un entrypoint est déclaré ET
        // résolvable, et que les prérequis (`extensionDependencies`) sont
        // satisfaits. On grise dans les deux cas : rien d'utile à exécuter.
        const canRun = !!ext.main && state !== "unsupported" && state !== "prerequisites-missing";
        const expanded = expandedId === ext.id;
        const hasLog = (rec?.log.length ?? 0) > 0;
        return (
        <div key={ext.id} className="group" style={{ padding: "8px 10px", borderBottom: "1px solid var(--origin-border-default)" }}>
          <div className="flex items-start gap-2">
            <Package size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--origin-fg-muted)" }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ext.display_name}
                </span>
                <span style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>v{ext.version}</span>
                {state === "active" && <ActiveBadge />}
                {state === "error" && <ErrorBadge />}
                {state === "unsupported" && <UnsupportedBadge />}
                {state === "prerequisites-missing" && <PrereqBadge />}
              </div>
              {ext.publisher && (
                <div style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ext.publisher}
                </div>
              )}
              {ext.description && (
                <div style={{ fontSize: "11px", color: "var(--origin-fg-muted)", marginTop: 2, lineHeight: 1.4 }}>{ext.description}</div>
              )}
              <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                {ext.contributions.map((c, i) => (
                  <span key={i} className="flex items-center gap-1"
                    style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "var(--origin-bg-hover)", color: "var(--origin-fg-subtle)" }}>
                    <FileCode2 size={9} />
                    {c.kind}{c.language ? `: ${c.language}` : ""}
                  </span>
                ))}
                {ext.has_main && (
                  <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "var(--origin-bg-hover)", color: "var(--origin-fg-subtle)" }}
                    title="This extension ships code. Activate to run it in the sandbox.">
                    code{state !== "active" ? " (inactive)" : ""}
                  </span>
                )}
              </div>
              {state === "error" && rec?.error && (
                <div style={{ fontSize: "10px", color: "var(--origin-semantic-error)", marginTop: 4, lineHeight: 1.4 }}>
                  {rec.error}
                </div>
              )}
              {state === "unsupported" && (
                <div style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", marginTop: 4, lineHeight: 1.4 }}>
                  Code non supporté en mode léger. Les contributions (thèmes, grammaires, snippets) restent actives.
                </div>
              )}
              {state === "prerequisites-missing" && (
                <div style={{ fontSize: "10px", color: "var(--origin-fg-subtle)", marginTop: 4, lineHeight: 1.4 }}>
                  {rec?.error ?? "Dépendances manquantes."} — installe la ou les extensions requises pour l'activer.
                </div>
              )}
            </div>
            <div className="flex items-center gap-0.5" style={{ flexShrink: 0 }}>
              {canRun && (
                <button
                  onClick={() => onToggleActive(ext)}
                  disabled={busy}
                  title={state === "active" ? "Deactivate" : "Activate"}
                  style={{ ...iconBtnStyle, color: state === "active" ? "var(--origin-semantic-success)" : "var(--origin-fg-muted)", cursor: busy ? "default" : "pointer" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  {state === "active" ? <Square size={11} /> : <Play size={12} />}
                </button>
              )}
              {hasLog && (
                <button
                  onClick={() => setExpandedId(expanded ? null : ext.id)}
                  title="Show console"
                  style={iconBtnStyle}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              )}
              <button onClick={() => onUninstall(ext.id, ext.display_name)} title="Uninstall" disabled={busy}
                className="opacity-0 group-hover:opacity-100"
                style={{ ...iconBtnStyle, transition: "opacity 0.1s, background 0.1s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--origin-bg-hover)"; e.currentTarget.style.color = "var(--origin-fg-default)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--origin-fg-muted)"; }}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          {expanded && rec && (
            <pre style={{
              margin: "6px 0 0", padding: "6px 8px", maxHeight: 160, overflow: "auto",
              background: "var(--origin-bg-base)", border: "1px solid var(--origin-border-default)",
              borderRadius: 4, fontSize: "10px", lineHeight: 1.5, color: "var(--origin-fg-muted)",
              fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {rec.log.join("\n")}
            </pre>
          )}
        </div>
        );
      })}
    </div>
  );
}

function ActiveBadge() {
  return (
    <span className="flex items-center gap-1" style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "color-mix(in srgb, var(--origin-semantic-success) 18%, transparent)", color: "var(--origin-semantic-success)", flexShrink: 0 }}>
      <ShieldCheck size={9} /> active
    </span>
  );
}

function ErrorBadge() {
  return (
    <span className="flex items-center gap-1" style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "color-mix(in srgb, var(--origin-semantic-error) 18%, transparent)", color: "var(--origin-semantic-error)", flexShrink: 0 }}>
      <AlertTriangle size={9} /> error
    </span>
  );
}

/**
 * État « code non supporté en mode léger » : l'extension est valide, mais son
 * entrypoint exécutable est introuvable. Ce n'est PAS une erreur — les
 * contributions passives restent actives. Badge neutre volontairement.
 */
function UnsupportedBadge() {
  return (
    <span className="flex items-center gap-1" style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "var(--origin-bg-hover)", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>
      <FileCode2 size={9} /> code léger
    </span>
  );
}

/**
 * État « prérequis manquants » : une `extensionDependencies` déclarée n'est pas
 * installée. Ce n'est PAS une erreur — l'extension reste installée et activable
 * dès que la dépendance est présente. Badge neutre, action = installer la dépend.
 */
function PrereqBadge() {
  return (
    <span className="flex items-center gap-1" style={{ fontSize: "10px", padding: "1px 5px", borderRadius: 3, background: "var(--origin-bg-hover)", color: "var(--origin-fg-subtle)", flexShrink: 0 }}>
      <Puzzle size={9} /> dépendance
    </span>
  );
}

// ---------------------------------------------------------------------------
// Marketplace tab
// ---------------------------------------------------------------------------

function MarketplaceList({ query, onQuery, results, searching, error, installedIds, installingId, onInstall }: {
  query: string;
  onQuery: (q: string) => void;
  results: MarketExtension[];
  searching: boolean;
  error: string | null;
  installedIds: Set<string>;
  installingId: string | null;
  onInstall: (ext: MarketExtension) => void;
}) {
  const hasQuery = query.trim().length > 0;
  return (
    <>
      {/* Search box */}
      <div className="shrink-0" style={{ padding: "0 10px 8px" }}>
        <div className="flex items-center gap-2" style={{
          padding: "4px 8px", borderRadius: 4,
          background: "var(--origin-bg-hover)",
          border: "1px solid var(--origin-border-default)",
        }}>
          <Search size={13} style={{ color: "var(--origin-fg-subtle)", flexShrink: 0 }} />
          <input
            value={query}
            onChange={e => onQuery(e.target.value)}
            placeholder="Search Open VSX…"
            spellCheck={false}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: "12px", color: "var(--origin-fg-default)" }}
          />
          {searching && <Loader2 size={12} className="animate-spin" style={{ color: "var(--origin-fg-subtle)" }} />}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2" style={{ padding: "6px 10px", fontSize: "11px", color: "var(--origin-fg-subtle)", borderBottom: "1px solid var(--origin-border-default)" }}>
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        {!hasQuery && (
          <div className="flex flex-col items-center justify-center gap-2" style={{ padding: "32px 16px", color: "var(--origin-fg-subtle)" }}>
            <Search size={20} />
            <p style={{ fontSize: "11px", textAlign: "center", lineHeight: 1.5 }}>
              Search the Open VSX registry to
              <br />
              discover extensions.
            </p>
          </div>
        )}

        {hasQuery && !searching && results.length === 0 && !error && (
          <div style={{ padding: "24px 16px", fontSize: "11px", textAlign: "center", color: "var(--origin-fg-subtle)" }}>
            No results for “{query.trim()}”.
          </div>
        )}

        {results.map(ext => {
          const installed = installedIds.has(ext.id);
          const installing = installingId === ext.id;
          return (
            <div key={ext.id} style={{ padding: "8px 10px", borderBottom: "1px solid var(--origin-border-default)" }}>
              <div className="flex items-start gap-2">
                {ext.icon_url ? (
                  <img src={ext.icon_url} alt="" width={28} height={28}
                    style={{ flexShrink: 0, borderRadius: 4, objectFit: "contain", background: "var(--origin-bg-hover)" }}
                    onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                ) : (
                  <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 4, background: "var(--origin-bg-hover)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Package size={14} style={{ color: "var(--origin-fg-muted)" }} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--origin-fg-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ext.display_name}
                    </span>
                    {ext.verified && <BadgeCheck size={12} style={{ color: "#3b9eff", flexShrink: 0 }} />}
                  </div>
                  <div className="flex items-center gap-2" style={{ fontSize: "10px", color: "var(--origin-fg-subtle)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ext.namespace}</span>
                    <span className="flex items-center gap-1"><Download size={9} />{formatCount(ext.download_count)}</span>
                    {ext.average_rating > 0 && (
                      <span className="flex items-center gap-1"><Star size={9} />{ext.average_rating.toFixed(1)}</span>
                    )}
                  </div>
                  {ext.description && (
                    <div style={{ fontSize: "11px", color: "var(--origin-fg-muted)", marginTop: 2, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {ext.description}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onInstall(ext)}
                  disabled={installed || installing}
                  title={installed ? "Already installed" : "Install"}
                  style={{
                    display: "flex", alignItems: "center", gap: 3, flexShrink: 0,
                    fontSize: "10px", padding: "3px 7px", borderRadius: 4, border: "none",
                    background: installed ? "transparent" : "var(--origin-bg-active)",
                    color: installed ? "var(--origin-fg-subtle)" : "var(--origin-fg-default)",
                    cursor: installed || installing ? "default" : "pointer",
                  }}>
                  {installing ? <Loader2 size={11} className="animate-spin" />
                    : installed ? <><Check size={11} /> Installed</>
                    : <><Download size={11} /> Install</>}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Consent modal — shown before an extension's code is ever executed
// ---------------------------------------------------------------------------

/**
 * Explicit-consent dialog. The extension cannot be activated until the user
 * approves every capability its manifest implies; capabilities are opt-in and
 * individually listed so nothing runs invisibly.
 */
function ConsentModal({ ext, onCancel, onGrant }: {
  ext: ExtensionInfo;
  onCancel: () => void;
  onGrant: (caps: Capability[]) => void;
}) {
  const required = useMemo(
    () => requiredCapabilities({ main: ext.main, commands: ext.commands, activation_events: ext.activation_events }),
    [ext],
  );
  const [checked, setChecked] = useState<Set<Capability>>(() => new Set(required));
  const isModal = typeof document !== "undefined";

  const toggle = (cap: Capability) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap); else next.add(cap);
      return next;
    });
  };

  const allGranted = required.every(c => checked.has(c));

  if (!isModal) return null;

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 460, maxWidth: "90vw",
          background: "var(--origin-bg-surface)",
          border: "1px solid var(--origin-border-default)",
          borderRadius: 10, padding: "22px 24px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
          display: "flex", flexDirection: "column", gap: 14,
        }}>
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} style={{ color: "var(--origin-accent-blue)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--origin-fg-default)" }}>
            Permissions for {ext.display_name}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--origin-fg-muted)", margin: 0, lineHeight: 1.5 }}>
          This extension ships code. It runs sandboxed — no network, no DOM, no files outside the
          workspace — but it needs the permissions below before it can start.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {required.map(cap => {
            const info = CAPABILITY_INFO[cap];
            const on = checked.has(cap);
            return (
              <label key={cap} className="flex items-start gap-2" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={on} onChange={() => toggle(cap)}
                  style={{ marginTop: 3, flexShrink: 0 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, color: "var(--origin-fg-default)", fontWeight: 500 }}>
                    {info.label}
                  </span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--origin-fg-subtle)", lineHeight: 1.4 }}>
                    {info.detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2" style={{ marginTop: 4 }}>
          <button onClick={onCancel}
            style={{
              padding: "6px 14px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              background: "var(--origin-bg-hover)", color: "var(--origin-fg-default)",
              border: "1px solid var(--origin-border-default)",
            }}>
            Cancel
          </button>
          <button onClick={() => onGrant(Array.from(checked))} disabled={!allGranted}
            title={allGranted ? "Activate now" : "Grant every capability to continue"}
            style={{
              padding: "6px 14px", fontSize: 12, borderRadius: 6,
              cursor: allGranted ? "pointer" : "default",
              background: allGranted ? "var(--origin-accent-blue)" : "var(--origin-bg-hover)",
              color: allGranted ? "#fff" : "var(--origin-fg-subtle)",
              border: "1px solid transparent", fontWeight: 500,
            }}>
            Grant &amp; Activate
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
