import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Trash2 } from 'lucide-react';
import {
  clearOutput,
  getOutput,
  getOutputVersion,
  listOutputChannels,
  subscribeOutput,
  type OutputLine,
} from '../../lib/outputStore';

// Abonne le composant au store d'output (re-render sur nouvelle ligne).
function useOutputStore() {
  return useSyncExternalStore(subscribeOutput, getOutputVersion);
}

function lineColor(kind: OutputLine['kind']): string {
  if (kind === 'stderr') return 'var(--origin-semantic-error)';
  if (kind === 'system') return 'var(--origin-fg-subtle)';
  return 'var(--origin-fg-default)';
}

/**
 * Panel « Output » : console texte découplée du terminal, alimentée par les
 * tâches « Run ». Chaque exécution crée un canal nommé (programme + args).
 */
export default function OutputPanel() {
  useOutputStore();
  const channels = listOutputChannels();
  const [active, setActive] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Canal sélectionné : premier de la liste si l'actuel a disparu.
  const selected = useMemo(() => {
    if (active && channels.includes(active)) return active;
    return channels[0] ?? null;
  }, [active, channels]);

  const lines = selected ? getOutput(selected) : [];

  // Auto-scroll en bas quand de nouvelles lignes arrivent.
  useEffect(() => {
    if (!autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, autoScroll, selected]);

  if (channels.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <p style={{ fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center', lineHeight: 1.5 }}>
          No output yet. Run a task to see its output here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {/* Barre d'outils : sélection du canal + actions */}
      <div style={{
        height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 8px', borderBottom: '1px solid var(--origin-border-subtle)',
      }}>
        <select
          value={selected ?? ''}
          onChange={e => setActive(e.target.value)}
          style={{
            flex: 1, maxWidth: 360, height: 20, fontSize: 12,
            background: 'var(--origin-bg-input)', color: 'var(--origin-fg-default)',
            border: '1px solid var(--origin-border-default)', borderRadius: 3,
            fontFamily: 'var(--font-mono)', cursor: 'pointer',
          }}
        >
          {channels.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--origin-fg-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
        <button
          title="Clear Output"
          onClick={() => clearOutput(selected ?? undefined)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 20, border: 'none', borderRadius: 3,
            background: 'transparent', color: 'var(--origin-fg-muted)', cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; e.currentTarget.style.color = 'var(--origin-fg-default)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--origin-fg-muted)'; }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Corps : lignes de sortie */}
      <div
        ref={bodyRef}
        style={{
          flex: 1, overflow: 'auto', padding: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {lines.map((l, i) => (
          <div key={i} style={{ color: lineColor(l.kind) }}>{l.text || '\u00a0'}</div>
        ))}
      </div>
    </div>
  );
}
