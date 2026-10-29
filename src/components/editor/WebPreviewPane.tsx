import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { RefreshCw, ExternalLink, ArrowLeft, ArrowRight, Globe, PictureInPicture2, X, Plus, Smartphone, Tablet, Monitor, Loader2, Bot } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Tooltip } from '../ui/Tooltip';
import { subscribePreviewNavigation, takePendingPreviewUrl } from '../../lib/ai/previewBus';
import {
  subscribePreviewTabs,
  getPreviewTabsSnapshot,
  openPreviewTab,
  activatePreviewTab,
  closePreviewTab,
  setPreviewTabUrl,
  replacePreviewTabs,
  panelIdForTab,
  navigateActiveOrCreate,
  runtimeFor,
} from '../../lib/ai/previewTabs';

/**
 * Panneau de prévisualisation web INTÉGRÉ, multi-onglets (parité Trae SOLO).
 *
 * VRAI NAVIGATEUR
 * ---------------
 * Chaque onglet possède SA webview native (`origin-web-preview-<id>`) qui reste
 * VIVANTE tant que l'onglet est ouvert : sa page, son scroll et son historique
 * natif sont préservés. Basculer d'onglet NE recharge PAS la page — on masque
 * simplement la webview de l'onglet sortant et on affiche celle de l'entrant
 * (redimensionnement hors écran / restauration des bornes).
 *
 * L'état des onglets (liste + actif) vit dans `previewTabs.ts`, partagé avec
 * `clineClient` qui y résout le `panelId` LOGIQUE envoyé par l'agent (voir
 * `resolvePreviewPanel`). Ainsi l'agent pilote toujours l'onglet actif sans
 * connaître l'existence des onglets.
 */

const COMMON_PORTS = [
  { port: 5173, label: 'Vite' },
  { port: 3000, label: 'Next / CRA' },
  { port: 4173, label: 'Vite preview' },
  { port: 8080, label: 'Generic' },
];

function normalize(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return `http://localhost:${trimmed}`;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `http://${trimmed}`;
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const pa = ua.pathname.replace(/\/$/, '') || '/';
    const pb = ub.pathname.replace(/\/$/, '') || '/';
    return ua.origin === ub.origin && pa === pb && ua.search === ub.search && ua.hash === ub.hash;
  } catch {
    return false;
  }
}

/** Titre d'onglet lisible : hôte + dernier segment du chemin. */
function tabLabel(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url;
  }
}

// ── Empty state shown before user picks a URL ──────────────────────────────

function UrlPicker({ onNavigate }: { onNavigate: (url: string) => void }) {
  const [input, setInput] = useState('');

  function go(raw: string) {
    const url = normalize(raw);
    if (url) onNavigate(url);
  }

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '20px',
    }}>
      <Globe size={36} style={{ color: 'var(--origin-fg-muted)', opacity: 0.35 }} />

      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--origin-fg-default)', marginBottom: '4px' }}>
          Live Preview
        </p>
        <p style={{ fontSize: '12px', color: 'var(--origin-fg-muted)' }}>
          Enter a URL or port to preview your dev server
        </p>
      </div>

      {/* URL / port input */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          backgroundColor: 'var(--origin-bg-hover)',
          border: '1px solid var(--origin-border-default)',
          borderRadius: '6px', padding: '6px 10px',
          width: '260px',
        }}>
          <Globe size={12} style={{ color: 'var(--origin-fg-subtle)', flexShrink: 0 }} />
          <input
            autoFocus
            placeholder="localhost:3000 or https://..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(input); }}
            spellCheck={false}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: '12px', color: 'var(--origin-fg-default)',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          />
        </div>
        <button
          onClick={() => go(input)}
          style={{
            padding: '0 16px',
            background: 'var(--origin-accent-blue)',
            color: '#fff',
            border: 'none', borderRadius: '6px',
            fontSize: '12px', cursor: 'pointer', fontWeight: 500,
          }}
        >
          Go
        </button>
      </div>

      {/* Common port shortcuts */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {COMMON_PORTS.map(({ port, label }) => (
          <button
            key={port}
            onClick={() => onNavigate(`http://localhost:${port}`)}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              border: '1px solid var(--origin-border-default)',
              borderRadius: '5px', cursor: 'pointer',
              fontSize: '11px', color: 'var(--origin-fg-muted)',
              transition: 'background 0.1s, color 0.1s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--origin-bg-hover)';
              e.currentTarget.style.color = 'var(--origin-fg-default)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--origin-fg-muted)';
            }}
          >
            :{port}{' '}
            <span style={{ opacity: 0.55 }}>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Nav button helper ──────────────────────────────────────────────────────

const navBtnBaseStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', flexShrink: 0,
  border: 'none', borderRadius: '4px', padding: 0,
  background: 'transparent', cursor: 'pointer',
  color: 'var(--origin-fg-muted)',
  transition: 'background 0.1s, color 0.1s',
};

function NavBtn({
  onClick, title, disabled = false, children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = {
    ...navBtnBaseStyle,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.35 : 1,
  };
  return (
    <Tooltip content={title} side="bottom">
      <button
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        style={style}
        onMouseEnter={e => {
          if (disabled) return;
          e.currentTarget.style.background = 'var(--origin-bg-hover)';
          e.currentTarget.style.color = 'var(--origin-fg-default)';
        }}
        onMouseLeave={e => {
          if (disabled) return;
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--origin-fg-muted)';
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

const LS_TABS = 'origin-preview-tabs';
// Persiste l'état « piloté par l'agent » pour que le badge survive à un
// remontage du panneau (changement d'onglet, rechargement du webview).
const LS_AGENT_ACTIVE = 'origin-preview-agent-active';

type PresetKey = 'mobile' | 'tablet' | 'desktop';

const PRESETS: Record<PresetKey, { w: number | null; h: number | null; label: string }> = {
  mobile:  { w: 375,  h: 812,  label: 'Mobile'  },
  tablet:  { w: 768,  h: 1024, label: 'Tablet'  },
  desktop: { w: null, h: null, label: 'Desktop' },
};

function detectPreset(w: number | null, h: number | null): PresetKey | null {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.w === w && p.h === h) return key as PresetKey;
  }
  return null;
}

// ── Inline editable dimension value ───────────────────────────────────────

function DimInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function commit() {
    const n = parseInt(draft, 10);
    if (!isNaN(n) && n > 0) onChange(n);
    else if (draft === '' || draft.toLowerCase() === 'auto') onChange(null);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
        onBlur={commit}
        style={{
          width: `${Math.max(3, draft.length)}ch`,
          background: 'var(--origin-bg-active)',
          border: '1px solid var(--origin-accent-blue)',
          borderRadius: '3px',
          color: 'var(--origin-fg-default)',
          fontSize: '11px',
          fontFamily: 'var(--font-mono, monospace)',
          outline: 'none',
          padding: '1px 3px',
          textAlign: 'center',
        }}
      />
    );
  }

  return (
    <span
      onClick={() => { setEditing(true); setDraft(value !== null ? String(value) : ''); }}
      style={{
        fontSize: '11px',
        fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--origin-fg-muted)',
        cursor: 'text',
        minWidth: '28px',
        display: 'inline-block',
        textAlign: 'center',
        padding: '1px 3px',
        borderRadius: '3px',
        transition: 'color 0.1s, background 0.1s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = 'var(--origin-fg-default)';
        e.currentTarget.style.background = 'var(--origin-bg-hover)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = 'var(--origin-fg-muted)';
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {value !== null ? value : 'Auto'}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function WebPreviewPane() {
  // État des onglets : source de vérité partagée avec l'agent (voir previewTabs).
  const { tabs, activeIndex } = useSyncExternalStore(subscribePreviewTabs, getPreviewTabsSnapshot);
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null;
  const activeId = activeTab?.id ?? null;

  // Re-rendu forcé quand un état runtime par onglet change (chargement, dims…).
  const [, forceRender] = useState(0);
  const refresh = useCallback(() => forceRender(n => n + 1), []);

  // Un conteneur par onglet : la webview native s'ancre sur le div correspondant.
  const containersRef = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const outerWrapperRef = useRef<HTMLDivElement | null>(null);

  const [inputUrl, setInputUrl] = useState(activeTab?.url ?? '');
  const [agentActive, setAgentActive] = useState<boolean>(() => localStorage.getItem(LS_AGENT_ACTIVE) === '1');

  const urlBarFocusedRef = useRef(false);
  // URL attendue d'une navigation déclenchée par NOUS (barre d'URL, lien, bus) :
  // évite que le polling ne réécrive la barre pendant la transition.
  const expectedNavUrlRef = useRef<string | null>(null);
  // Ids des webviews actuellement montées côté natif (pour n'embarquer qu'une fois).
  const mountedRef = useRef<Set<string>>(new Set());

  const activeRt = activeId ? runtimeFor(activeId) : null;
  const viewW = activeRt?.viewW ?? null;
  const viewH = activeRt?.viewH ?? null;
  const activePreset = detectPreset(viewW, viewH);
  const url = activeTab?.url ?? null;

  // La barre d'URL suit l'onglet actif.
  useEffect(() => {
    expectedNavUrlRef.current = null;
    setInputUrl(url ?? '');
    refresh();
  }, [url, activeId, refresh]);

  // ── Persistance des onglets ───────────────────────────────────────────────
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (tabs.length > 0) return; // déjà alimenté (agent / autre instance)
    try {
      const raw = localStorage.getItem(LS_TABS);
      if (raw) {
        const parsed = JSON.parse(raw) as { tabs?: { id: string; url: string }[]; activeIndex?: number };
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          replacePreviewTabs(
            parsed.tabs.filter(t => t && typeof t.url === 'string' && typeof t.id === 'string'),
            typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0,
          );
          return;
        }
      }
    } catch {
      // Persistance corrompue : on repart d'un état vide plutôt que de planter.
    }
  }, [tabs.length]);

  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      localStorage.setItem(LS_TABS, JSON.stringify({ tabs, activeIndex }));
    } catch {
      // Quota plein : la persistance est un confort, pas une garantie vitale.
    }
  }, [tabs, activeIndex]);

  // ── Géométrie d'un onglet, clippée aux bornes visibles du panneau ─────────
  const boundsFor = useCallback((id: string) => {
    const el = containersRef.current.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const outer = outerWrapperRef.current;
    let x = r.left, y = r.top, w = r.width, h = r.height;
    if (outer) {
      const o = outer.getBoundingClientRect();
      x = Math.max(r.left, o.left);
      y = Math.max(r.top,  o.top);
      w = Math.max(0, Math.min(r.right,  o.right)  - x);
      h = Math.max(0, Math.min(r.bottom, o.bottom) - y);
    }
    return { x, y, width: w, height: h };
  }, []);

  // ── Embed / destroy : une webview VIVANTE par onglet ──────────────────────
  // On embarque chaque onglet qui a une URL (une seule fois), on ré-embarque si
  // son URL change (navigation explicite) ou si on demande un reload, et on
  // détruit la webview quand l'onglet est fermé.
  useEffect(() => {
    let cancelled = false;
    const liveIds = new Set(tabs.map(t => t.id));

    // 1) Détruit les webviews des onglets fermés (clé = `<id>:<url>:<reload>`).
    for (const key of Array.from(mountedRef.current)) {
      const id = key.slice(0, key.indexOf(':'));
      if (!liveIds.has(id)) {
        mountedRef.current.delete(key);
        void invoke('destroy_ide_panel', { panelId: panelIdForTab(id) }).catch(() => {});
      }
    }

    // 2) Embarque / ré-embarque les onglets ayant une URL.
    for (const tab of tabs) {
      const rt = runtimeFor(tab.id);
      if (!tab.url) {
        // Onglet vide : aucune webview tant qu'aucune URL n'est saisie.
        for (const key of Array.from(mountedRef.current)) {
          if (key.startsWith(`${tab.id}:`)) {
            mountedRef.current.delete(key);
            void invoke('destroy_ide_panel', { panelId: panelIdForTab(tab.id) }).catch(() => {});
          }
        }
        continue;
      }
      const panelId = panelIdForTab(tab.id);
      const key = `${tab.id}:${tab.url}:${rt.reloadKey}`;
      if (mountedRef.current.has(key)) continue;

      const b = boundsFor(tab.id);
      if (!b) continue; // conteneur pas encore monté — l'effet repassera.

      // Une seule entrée par onglet : on retire l'ancienne avant d'ajouter.
      for (const k of Array.from(mountedRef.current)) {
        if (k !== key && k.startsWith(`${tab.id}:`)) mountedRef.current.delete(k);
      }
      mountedRef.current.add(key);

      rt.loading = true;
      rt.error = null;
      void invoke('embed_ide_panel', { panelId, url: tab.url, ...b })
        .then(() => { if (!cancelled) { rt.loading = false; refresh(); } })
        .catch((e) => {
          if (cancelled) return;
          rt.loading = false;
          rt.error = String(e ?? 'failed to load');
          refresh();
        });
    }
  }, [tabs, refresh, boundsFor]);

  // Détruit TOUTES les webviews au démontage du panneau (fermeture de l'onglet
  // outil « browser », bascule vers l'éditeur…). Sans cela, les webviews
  // natives resteraient vivantes, invisibles et non pilotables — surface fantôme.
  useEffect(() => {
    const mounted = mountedRef.current;
    return () => {
      for (const key of Array.from(mounted)) {
        const id = key.slice(0, key.indexOf(':'));
        void invoke('destroy_ide_panel', { panelId: panelIdForTab(id) }).catch(() => {});
      }
      mounted.clear();
    };
  }, []);

  // ── Masquer/afficher : seule la webview de l'onglet ACTIF est visible ─────
  // Les autres sont déplacées HORS ÉCRAN (elles restent vivantes et gardent
  // leur état) — c'est le comportement d'un vrai navigateur : rien n'est
  // rechargé quand on revient sur un onglet.
  useEffect(() => {
    const outer = outerWrapperRef.current;
    if (!outer) return;
    const o = outer.getBoundingClientRect();
    const off = { x: -100000, y: -100000, width: 1, height: 1 };

    for (const tab of tabs) {
      const panelId = panelIdForTab(tab.id);
      if (!tab.url || !mountedRef.current.has(`${tab.id}:${tab.url}:${runtimeFor(tab.id).reloadKey}`)) continue;
      const visible = tab.id === activeId;
      const b = visible ? boundsFor(tab.id) : null;
      // Hors écran si inactif ou si son conteneur n'est pas encore mesurable.
      const target = (visible && b) ? b : off;
      void invoke('resize_ide_panel', { panelId, ...target }).catch(() => {});
    }
    // `o` n'est lu que pour forcer un recalcul au bon moment.
    void o;
  }, [tabs, activeId, viewW, viewH, boundsFor]);

  // Resynchronise la géométrie de l'onglet actif après tout changement de
  // layout susceptible de déplacer son conteneur.
  //
  // Pourquoi observer TOUTE la chaîne d'ancêtres et pas seulement le wrapper :
  // la webview native est peinte AU-DESSUS du HTML, indépendamment du z-index.
  // Si sa géométrie n'est pas mise à jour dès que le layout bouge, elle reste à
  // ses anciennes coordonnées et recouvre le reste de l'UI — typiquement le
  // bouton Stop du panneau agent quand `AiPanel` s'élargit (drag du séparateur)
  // ou que la barre de progression apparaît.
  //
  // Un `ResizeObserver` ne se déclenche QUE sur changement de taille ; il rate
  // donc les translations pures (ex. glissement horizontal sans changement de
  // taille). On ajoute un `MutationObserver` sur les attributs `class`/`style`
  // des ancêtres pour capter ces cas. Tous deux notifient `scheduleSync`, qui
  // coalesce les rafales d'événements en une seule mesure avant le prochain
  // repaint (sinon on spamme l'invoke natif pendant un drag).
  useEffect(() => {
    const outer = outerWrapperRef.current;
    if (!outer || !activeId) return;

    let raf = 0;
    const runSync = () => {
      raf = 0;
      const panelId = panelIdForTab(activeId);
      const b = boundsFor(activeId);
      if (b) void invoke('resize_ide_panel', { panelId, ...b }).catch(() => {});
    };
    const scheduleSync = () => {
      if (raf) return;
      raf = requestAnimationFrame(runSync);
    };

    // 1) Taille : on observe le wrapper ET tous ses ancêtres (jusqu'au body) —
    //    le panneau central change de largeur quand AiPanel est redimensionné.
    const ro = new ResizeObserver(scheduleSync);
    const ancestors: Element[] = [];
    for (let el: Element | null = outer; el; el = el.parentElement) {
      ro.observe(el);
      ancestors.push(el);
      if (el === document.body) break;
    }

    // 2) Translation : les changements de `style`/`class` d'un ancêtre (drag du
    //    séparateur, apparition/disparition de la barre de tâches…) déplacent le
    //    conteneur sans changer sa taille. On surveille uniquement ces attributs
    //    du sous-arbre, jamais le contenu ni les enfants (coût négligeable).
    const mo = new MutationObserver(scheduleSync);
    for (const el of ancestors) {
      mo.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    }

    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', scheduleSync, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('scroll', scheduleSync, true);
    };
  }, [activeId, boundsFor]);

  // ── Navigation dans un onglet ─────────────────────────────────────────────
  /**
   * Ouvre `to` dans l'onglet actif. La webview native navigue et met à jour sa
   * propre pile ; notre pile (`rt.stack`) ne suit que les navigations que NOUS
   * déclenchons (barre d'URL, liens de messages), ce qui suffit à piloter
   * Back/Forward en synergie avec l'historique natif.
   */
  function navigateActive(to: string) {
    if (!activeId) return;
    const rt = runtimeFor(activeId);
    expectedNavUrlRef.current = to;
    rt.stack = [...rt.stack.slice(0, rt.index + 1), to];
    rt.index = rt.index + 1;
    rt.loading = true;
    setPreviewTabUrl(activeId, to);
    setInputUrl(to);
    refresh();
  }

  function handleUrlBarNavigate(raw: string) {
    const next = normalize(raw);
    if (!next) return;
    if (next === url) {
      // Même URL : recharge la webview de l'onglet actif.
      const rt = runtimeFor(activeId!);
      expectedNavUrlRef.current = next;
      rt.reloadKey += 1;
      rt.loading = true;
      refresh();
      return;
    }
    navigateActive(next);
  }

  function handleReload() {
    if (!activeId) return;
    const rt = runtimeFor(activeId);
    rt.reloadKey += 1;
    rt.loading = true;
    refresh();
  }

  // ── Vraie navigation : Back/Forward natifs ────────────────────────────────
  // Back/Forward pilotent la pile d'historique NATIVE de la webview (aucun
  // rechargement, aucun re-embed) — vrai comportement navigateur. On relit
  // ensuite l'URL atteinte pour resynchroniser la barre d'adresse.
  function handleBack() { void goHistory('back'); }
  function handleForward() { void goHistory('forward'); }
  async function goHistory(direction: 'back' | 'forward') {
    if (!activeId) return;
    expectedNavUrlRef.current = '__pending__';
    try {
      const res = await invoke<{ url?: string | null }>('browser_go', {
        panelId: panelIdForTab(activeId),
        direction,
      });
      const reached = res?.url ?? null;
      if (reached) {
        const rt = runtimeFor(activeId);
        rt.stack = [...rt.stack.slice(0, rt.index + 1), reached];
        rt.index = rt.index + 1;
        setPreviewTabUrl(activeId, reached);
        setInputUrl(reached);
      }
      expectedNavUrlRef.current = null;
    } catch {
      expectedNavUrlRef.current = null;
    }
    refresh();
  }

  /** Ouvre un NOUVEL onglet vide (l'utilisateur saisira une URL). */
  function handleNewTab() {
    openPreviewTab('');
  }

  /**
   * Ouvre la page courante dans le navigateur SYSTÈME.
   *
   * Remarque : on n'ouvre volontairement PAS de `WebviewWindow` « Live Preview ».
   * Chaque fenêtre ainsi créée portait un label unique (`preview-${Date.now()}`)
   * et n'était suivie par aucun état applicatif : impossible de la fermer
   * proprement. Le navigateur système offre le même besoin sans surface fantôme.
   */
  function handlePopout() {
    if (!url) return;
    void openUrl(url).catch(() => { /* échec d'ouverture externe — sans effet */ });
  }

  // ── Poll de l'URL + capacités d'historique de l'onglet ACTIF ─────────────
  // Les navigations internes à la page (clics de liens, SPA pushState) ne
  // remontent pas au front : on lit périodiquement l'URL réelle de l'onglet
  // actif et on l'affiche. On en profite pour savoir si la webview peut
  // revenir en arrière (`history.length > 1`) — l'historique natif étant la
  // seule vérité des boutons Back/Forward.
  useEffect(() => {
    if (!activeId) return;
    const panelId = panelIdForTab(activeId);
    const poll = async () => {
      try {
        const current: string = await invoke('get_ide_panel_url', { panelId });
        if (current && current !== 'about:blank') {
          if (expectedNavUrlRef.current !== null) {
            if (sameUrl(current, expectedNavUrlRef.current)) expectedNavUrlRef.current = null;
          } else if (!urlBarFocusedRef.current) {
            setInputUrl(current);
          }
        }
        // Sonde d'historique : `browser_status` exécute le script dans la page.
        const st = await invoke<{ ok?: boolean; value?: string }>('browser_status', { panelId });
        if (st?.ok && st.value) {
          const info = JSON.parse(st.value) as { canBack?: boolean };
          const rt = runtimeFor(activeId);
          const next = info.canBack === true;
          if (rt.canBack !== next) { rt.canBack = next; refresh(); }
        }
      } catch {
        // Panel pas encore créé ou déjà détruit — on ignore silencieusement.
      }
    };
    void poll();
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  }, [activeId, refresh]);

  // ── Indicateur « piloté par l'agent » ──────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ active?: boolean }>('browser-agent-active', (event) => {
      const active = event.payload?.active === true;
      setAgentActive(active);
      if (active) localStorage.setItem(LS_AGENT_ACTIVE, '1');
      else localStorage.removeItem(LS_AGENT_ACTIVE);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // ── Pilotage depuis l'agent / les liens de messages ───────────────────────
  // Un lien cliqué (ou un outil browser_* qui demande une navigation) publie une
  // URL sur le bus. On la charge dans l'onglet ACTIF s'il existe, sinon on crée
  // un nouvel onglet — comme un navigateur classique.
  useEffect(() => {
    const apply = (to: string) => {
      const id = navigateActiveOrCreate(to);
      const rt = runtimeFor(id);
      rt.stack = [to];
      rt.index = 0;
      rt.loading = true;
      setPreviewTabUrl(id, to);
      expectedNavUrlRef.current = to;
      setInputUrl(to);
      refresh();
    };

    const pending = takePendingPreviewUrl();
    if (pending) apply(pending);

    const unsub = subscribePreviewNavigation(apply);
    return unsub;
  }, [refresh]);

  // ── Aucun onglet — écran de démarrage ─────────────────────────────────────
  if (!activeTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden',
        backgroundColor: 'var(--origin-bg-editor)' }}>
        <UrlPicker onNavigate={(u) => openPreviewTab(u)} />
      </div>
    );
  }

  // Back/Forward : pilotés par la pile d'historique NATIVE de la webview.
  const canGoBack = activeRt?.canBack === true;
  const canGoForward = false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Barre d'onglets */}
      <PreviewTabStrip
        tabs={tabs} activeIndex={activeIndex}
        onActivate={activatePreviewTab} onClose={closePreviewTab} onNew={handleNewTab}
      />

      {/* Barre d'URL (reflète l'onglet actif) */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '5px 8px',
        borderBottom: '1px solid var(--origin-border-default)',
        backgroundColor: 'var(--origin-bg-base)',
        flexShrink: 0,
      }}>
        <NavBtn onClick={handleBack} title="Back" disabled={canGoBack}><ArrowLeft size={14} /></NavBtn>
        <NavBtn onClick={handleForward} title="Forward" disabled={canGoForward}><ArrowRight size={14} /></NavBtn>
        <NavBtn onClick={handleReload} title="Refresh">
          <RefreshCw size={14} />
        </NavBtn>

        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px', flex: 1,
          backgroundColor: 'var(--origin-bg-hover)',
          border: '1px solid var(--origin-border-default)',
          borderRadius: '6px', padding: '3px 8px',
        }}>
          <Globe size={12} style={{ color: 'var(--origin-fg-subtle)', flexShrink: 0 }} />
          <input
            value={inputUrl}
            onChange={e => setInputUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                handleUrlBarNavigate(inputUrl);
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                setInputUrl(url ?? '');
                (e.target as HTMLInputElement).blur();
              }
            }}
            onFocus={e => { urlBarFocusedRef.current = true; e.currentTarget.select(); }}
            onBlur={() => { urlBarFocusedRef.current = false; setInputUrl(url ?? ''); }}
            spellCheck={false}
            placeholder="localhost:3000 or https://..."
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: '12px', color: 'var(--origin-fg-default)',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          />
        </div>

        <div style={{ width: 1, height: 16, background: 'var(--origin-border-default)', flexShrink: 0, margin: '0 2px' }} />

        {/* Badge « agent » : visible quand un agent pilote la prévisualisation. */}
        {agentActive && (
          <Tooltip content="This preview is driven by the agent" side="bottom">
            <div style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '2px 8px', flexShrink: 0,
              borderRadius: '10px',
              border: '1px solid var(--origin-accent, #4f8cff)',
              background: 'color-mix(in srgb, var(--origin-accent, #4f8cff) 14%, transparent)',
              color: 'var(--origin-accent, #4f8cff)',
              fontSize: '11px', fontWeight: 500, userSelect: 'none',
            }}>
              <Bot size={12} />
              <span>Agent</span>
            </div>
          </Tooltip>
        )}

        {/* Viewport preset toggles */}
        {([
          { key: 'mobile'  as PresetKey, icon: <Smartphone size={14} /> },
          { key: 'tablet'  as PresetKey, icon: <Tablet size={14} /> },
          { key: 'desktop' as PresetKey, icon: <Monitor size={14} /> },
        ]).map(({ key, icon }) => {
          const active = activePreset === key;
          return (
            <Tooltip key={key} content={PRESETS[key].label} side="bottom">
              <button
                onClick={() => {
                  if (!activeId) return;
                  const rt = runtimeFor(activeId);
                  rt.viewW = PRESETS[key].w; rt.viewH = PRESETS[key].h;
                  refresh();
                }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '28px', height: '28px', flexShrink: 0,
                  border: 'none', borderRadius: '4px', padding: 0,
                  background: active ? 'var(--origin-bg-active)' : 'transparent',
                  cursor: 'pointer',
                  color: active ? 'var(--origin-fg-default)' : 'var(--origin-fg-muted)',
                  transition: 'background 0.1s, color 0.1s',
                }}
                onMouseEnter={e => {
                  if (!active) {
                    e.currentTarget.style.background = 'var(--origin-bg-hover)';
                    e.currentTarget.style.color = 'var(--origin-fg-default)';
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--origin-fg-muted)';
                  }
                }}
              >
                {icon}
              </button>
            </Tooltip>
          );
        })}

        {/* Editable W × H */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', paddingLeft: '4px' }}>
          <DimInput value={viewW} onChange={v => { if (activeId) { runtimeFor(activeId).viewW = v; refresh(); } }} />
          <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)', userSelect: 'none' }}>×</span>
          <DimInput value={viewH} onChange={v => { if (activeId) { runtimeFor(activeId).viewH = v; refresh(); } }} />
        </div>

        <div style={{ width: 1, height: 16, background: 'var(--origin-border-default)', flexShrink: 0, margin: '0 2px' }} />

        <NavBtn onClick={handlePopout} title="Pop out to new window">
          <PictureInPicture2 size={14} />
        </NavBtn>
        <NavBtn onClick={() => { if (url) void openUrl(url); }} title="Open in browser">
          <ExternalLink size={14} />
        </NavBtn>
      </div>

      {/* Zone d'affichage : un conteneur par onglet. La webview native est
          ancrée sur le conteneur de son onglet ; seule celle de l'onglet actif
          occupe la zone visible, les autres sont hors écran mais restent
          vivantes (scroll et état préservés). */}
      <div ref={outerWrapperRef} style={{
        flex: 1, overflow: 'hidden', position: 'relative',
        display: 'flex', justifyContent: 'center',
        alignItems: viewH !== null ? 'flex-start' : 'stretch',
        backgroundColor: viewW !== null ? 'var(--origin-bg-base)' : 'transparent',
        padding: viewH !== null ? '16px' : 0,
      }}>
        <div style={{
          position: 'relative',
          width: viewW !== null ? `${viewW}px` : '100%',
          height: viewH !== null ? `${viewH}px` : '100%',
          flexShrink: 0,
          border: viewW !== null ? '1px solid var(--origin-border-default)' : 'none',
          borderRadius: viewW !== null ? '4px' : 0,
          overflow: 'hidden',
        }}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              ref={el => { containersRef.current.set(tab.id, el); }}
              style={{
                position: 'absolute', inset: 0,
                // Le conteneur de l'onglet actif reste transparent (la webview
                // native s'y superpose) ; celui des autres est masqué.
                visibility: tab.id === activeId ? 'visible' : 'hidden',
                background: 'transparent',
              }}
            />
          ))}

          {/* Onglet actif sans URL : picker.
              Onglet actif avec URL : la webview native s'affiche par-dessus. */}
          {activeTab.url === '' && (
            <UrlPicker onNavigate={(u) => navigateActiveOrCreate(u)} />
          )}

          {activeRt?.loading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'var(--origin-bg-editor)',
            }}>
              <Loader2 size={28} className="animate-spin" style={{ color: 'var(--origin-fg-muted)' }} />
            </div>
          )}

          {activeRt?.error && !activeRt.loading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 2,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: '10px',
              backgroundColor: 'var(--origin-bg-editor)',
              padding: '24px', textAlign: 'center',
            }}>
              <Globe size={28} style={{ color: 'var(--origin-fg-muted)', opacity: 0.4 }} />
              <p style={{ fontSize: '13px', color: 'var(--origin-fg-default)', margin: 0 }}>
                Impossible de charger cette page
              </p>
              <p style={{ fontSize: '11px', color: 'var(--origin-fg-muted)', margin: 0, maxWidth: '420px' }}>
                {activeRt.error}
              </p>
              <NavBtn onClick={handleReload} title="Réessayer">
                <RefreshCw size={14} />
              </NavBtn>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Barre d'onglets ─────────────────────────────────────────────────────────

function PreviewTabStrip({
  tabs, activeIndex, onActivate, onClose, onNew,
}: {
  tabs: { id: string; url: string }[];
  activeIndex: number;
  onActivate: (index: number) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: '2px',
      padding: '3px 6px 0', flexShrink: 0,
      borderBottom: '1px solid var(--origin-border-default)',
      backgroundColor: 'var(--origin-bg-base)',
      overflowX: 'auto',
    }}>
      {tabs.map((t, i) => {
        const active = i === activeIndex;
        return (
          <div
            key={t.id}
            onClick={() => onActivate(i)}
            title={t.url || 'New tab'}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '4px 8px', maxWidth: '180px', minWidth: '36px',
              borderRadius: '6px 6px 0 0', cursor: 'pointer',
              fontSize: '11px', userSelect: 'none',
              color: active ? 'var(--origin-fg-default)' : 'var(--origin-fg-muted)',
              background: active ? 'var(--origin-bg-hover)' : 'transparent',
              borderBottom: active ? '1px solid transparent' : 'none',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--origin-bg-hover)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            <Globe size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {t.url ? tabLabel(t.url) : 'New tab'}
            </span>
            <button
              onClick={e => { e.stopPropagation(); onClose(t.id); }}
              title="Close tab"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '16px', height: '16px', flexShrink: 0,
                border: 'none', borderRadius: '3px', padding: 0,
                background: 'transparent', cursor: 'pointer',
                color: 'var(--origin-fg-muted)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-active)'; e.currentTarget.style.color = 'var(--origin-fg-default)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--origin-fg-muted)'; }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <Tooltip content="New tab" side="bottom">
        <button
          onClick={onNew}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', flexShrink: 0,
            border: 'none', borderRadius: '4px', padding: 0,
            background: 'transparent', cursor: 'pointer',
            color: 'var(--origin-fg-muted)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; e.currentTarget.style.color = 'var(--origin-fg-default)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--origin-fg-muted)'; }}
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
