/**
 * Mira — page RÉGLAGES « Indexing & Docs ».
 *
 * RÔLE
 * ----
 * Piloter l'index local du workspace : le construire, l'annuler, le vider, et
 * voir son état (nombre de fichiers indexés, date du dernier build). C'est
 * l'équivalent de la page « Indexing & Docs » de Trae.
 *
 * CE QUE FAIT L'INDEX
 * -------------------
 * Un index inversé **local** (BM25) qui permet de retrouver un fichier par son
 * contenu ou son nom sans parcourir tout le disque à chaque fois. Il est 100 %
 * hors-ligne : aucune donnée ne quitte la machine. Les fichiers ignorés par
 * l'IDE (node_modules, .git, dossiers de build…) ne sont jamais indexés.
 *
 * SÉCURITÉ
 * --------
 *   - Le toggle « Indexation automatique » est une simple préférence locale
 *     (localStorage) : il NE déclenche aucune action dangereuse.
 *   - Rebuild / Cancel / Clear ne touchent QUE `<workspace>/.mira/index` (côté
 *     Rust, confiné et validé). « Clear » supprime l'index, jamais le code.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, RefreshCw, Trash2, X } from "lucide-react";
import {
  Badge, Button, EmptyState, ErrorLine, LoadingLine, PageHeader, Switch, sectionCard,
} from "./ui";

/** Clé de préférence locale (persistée dans localStorage). */
const AUTO_INDEX_KEY = "mira-indexing-auto";

/** État renvoyé par la commande Rust `index_status`. */
interface IndexStatus {
  built: boolean;
  building: boolean;
  file_count: number;
  root: string;
  built_at: number;
  large: boolean;
}

/** Lit la préférence d'indexation automatique (activée par défaut, comme Trae). */
function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_INDEX_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Formate un horodatage epoch-ms en libellé lisible (« 3 min ago »). */
function formatWhen(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export default function IndexingSection({ workspace }: { workspace?: string }) {
  const [auto, setAuto] = useState<boolean>(() => readAuto());
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Empêche le double-déclenchement de l'auto-index lors des re-rendus strict.
  const autoRanFor = useRef<string | null>(null);

  /** Rafraîchit l'état depuis le backend. */
  const refresh = useCallback(async () => {
    if (!workspace) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const s = await invoke<IndexStatus>("index_status", { workspace });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  /** Lance une (re)construction de l'index. */
  const build = useCallback(async () => {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("index_build", { workspace });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [workspace, busy, refresh]);

  // État initial + auto-indexation si activée et si aucun index n'existe.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!workspace) {
        setLoading(false);
        return;
      }
      try {
        const s = await invoke<IndexStatus>("index_status", { workspace });
        if (cancelled) return;
        setStatus(s);
        // Auto-index : une seule fois par workspace, et seulement si rien n'est
        // construit et que l'utilisateur n'a pas désactivé l'option.
        if (auto && !s.built && !s.building && autoRanFor.current !== workspace) {
          autoRanFor.current = workspace;
          setBusy(true);
          await invoke("index_build", { workspace });
          if (cancelled) return;
          const s2 = await invoke<IndexStatus>("index_status", { workspace });
          if (!cancelled) setStatus(s2);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setBusy(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // On ne dépend QUE du workspace : le toggle est géré par `toggleAuto`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  /** Bascule la préférence d'indexation automatique (préférence locale). */
  function toggleAuto() {
    const next = !auto;
    setAuto(next);
    try {
      localStorage.setItem(AUTO_INDEX_KEY, next ? "true" : "false");
    } catch {
      /* localStorage indisponible : on garde l'état en mémoire */
    }
  }

  /** Annule le build en cours. */
  async function cancel() {
    try {
      await invoke("index_cancel");
      // Laisse le worker s'arrêter puis relit l'état.
      setTimeout(() => { void refresh(); setBusy(false); }, 300);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Vide l'index (disque + mémoire). Ne touche jamais au code source. */
  async function clear() {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("index_clear", { workspace });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Indexing & Docs"
        description="Mira builds a local index of your workspace so you can quickly find files by their content or name. Everything stays on your machine."
      />

      {error && <ErrorLine message={error} />}

      {/* Préférence : indexation automatique */}
      <div style={{ ...sectionCard, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "var(--origin-fg-default)", fontWeight: 500 }}>
            Auto indexing
          </div>
          <div style={{ fontSize: 11.5, color: "var(--origin-fg-muted)", marginTop: 3, lineHeight: 1.5 }}>
            Build the index automatically when opening a project that doesn't have one yet.
          </div>
        </div>
        <Switch on={auto} onToggle={toggleAuto} title="Enable/disable automatic indexing" />
      </div>

      {/* Statut + actions */}
      <div style={sectionCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <Database size={15} style={{ color: "var(--origin-fg-muted)" }} />
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--origin-fg-default)" }}>
            Index status
          </div>
          {status && <StatusBadge status={status} busy={busy} />}
          {/* Actions ancrées à DROITE de la ligne de statut (façon Trae). */}
          {workspace && !loading && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
              {busy || status?.building ? (
                <Button variant="secondary" onClick={cancel} disabled={!busy && !status?.building}>
                  <X size={13} style={{ marginRight: 4 }} /> Cancel
                </Button>
              ) : (
                <Button variant="primary" onClick={build} disabled={busy}>
                  <RefreshCw size={13} style={{ marginRight: 4 }} />
                  {status?.built ? "Rebuild" : "Build index"}
                </Button>
              )}
              <Button variant="danger" onClick={clear} disabled={busy || !status?.built}>
                <Trash2 size={13} style={{ marginRight: 4 }} /> Clear index
              </Button>
            </div>
          )}
        </div>

        {!workspace ? (
          <EmptyState
            title="No project open"
            hint="Open a project folder to build and use the index."
          />
        ) : loading ? (
          <LoadingLine label="Reading index status…" />
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--origin-fg-muted)", lineHeight: 1.7 }}>
            {status?.built ? (
              <>
                <div>
                  <strong style={{ color: "var(--origin-fg-default)" }}>{status.file_count.toLocaleString("en-US")}</strong> file
                  {status.file_count > 1 ? "s" : ""} indexed
                </div>
                <div>Last build: {formatWhen(status.built_at)}</div>
                {status.large && (
                  <div style={{ marginTop: 6, color: "var(--origin-semantic-warning, #d29922)" }}>
                    Large project: the build may take a while.
                  </div>
                )}
              </>
            ) : (
              <div>No index has been built for this project yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pastille d'état : construit / en cours / absent. */
function StatusBadge({ status, busy }: { status: IndexStatus; busy: boolean }) {
  if (busy || status.building) return <Badge tone="warning">Indexing…</Badge>;
  if (status.built) return <Badge tone="success">Index built</Badge>;
  return <Badge tone="neutral">Index not built</Badge>;
}
