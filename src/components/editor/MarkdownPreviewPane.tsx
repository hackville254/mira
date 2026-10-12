import { useMemo, useRef, useState, useEffect } from 'react';
import { Eye, Code2 } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import MarkdownMessage from '../ai/MarkdownMessage';

interface Props {
  /** Contenu Markdown brut du fichier. */
  content: string;
  /** Nom affiché (barre d'outils). */
  fileName: string;
}

type ViewMode = 'preview' | 'source';

/**
 * Onglet de prévisualisation Markdown pleine page.
 *
 * Réutilise `MarkdownMessage` (react-markdown + remark-gfm, déjà utilisé par le
 * chat IA) : rendu GFM complet (tableaux, listes de tâches, blocs de code…),
 * sans HTML brut exécutable (react-markdown v10 échappe le HTML par défaut, donc
 * aucun vecteur XSS). Deux modes : rendu (« Preview ») et source (« Source »).
 */
export default function MarkdownPreviewPane({ content, fileName }: Props) {
  const [mode, setMode] = useState<ViewMode>('preview');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Conserve la position de scroll lors du passage rendu ↔ source.
  const scrollPos = useRef(0);

  // Statistiques simples affichées en barre d'état (mots / caractères).
  const stats = useMemo(() => {
    const chars = content.length;
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return { words, chars };
  }, [content]);

  function switchMode(next: ViewMode) {
    if (next === mode) return;
    scrollPos.current = scrollRef.current?.scrollTop ?? 0;
    setMode(next);
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollPos.current;
  }, [mode]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden',
      backgroundColor: 'var(--origin-bg-editor)' }}>
      {/* Barre d'outils */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '5px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--origin-border-default)',
        backgroundColor: 'var(--origin-bg-base)',
      }}>
        <Eye size={14} style={{ color: 'var(--origin-accent-blue)', flexShrink: 0 }} />
        <span style={{
          fontSize: '12px', fontWeight: 500, color: 'var(--origin-fg-default)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {fileName}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>· Markdown Preview</span>

        <div style={{ flex: 1 }} />

        {/* Bascule Preview / Source */}
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '1px solid var(--origin-border-default)',
          borderRadius: '5px', overflow: 'hidden',
        }}>
          <ModeButton active={mode === 'preview'} title="Preview" onClick={() => switchMode('preview')}>
            <Eye size={13} />
          </ModeButton>
          <ModeButton active={mode === 'source'} title="Source" onClick={() => switchMode('source')}>
            <Code2 size={13} />
          </ModeButton>
        </div>
      </div>

      {/* Contenu */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {mode === 'preview' ? (
          <div style={{ maxWidth: '820px', margin: '0 auto', padding: '28px 40px 64px' }}>
            <MarkdownMessage content={content} />
          </div>
        ) : (
          <pre style={{
            margin: 0, padding: '20px 24px 64px',
            fontSize: '12px', lineHeight: 1.6,
            fontFamily: 'var(--font-mono, monospace)',
            color: 'var(--origin-fg-default)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {content}
          </pre>
        )}
      </div>

      {/* Barre d'état */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '3px 10px', flexShrink: 0,
        borderTop: '1px solid var(--origin-border-default)',
        backgroundColor: 'var(--origin-bg-base)',
        fontSize: '11px', color: 'var(--origin-fg-subtle)',
      }}>
        <span>{stats.words} mots</span>
        <span>{stats.chars} caractères</span>
        <div style={{ flex: 1 }} />
        <span style={{ opacity: 0.7 }}>GFM · tables · tâches</span>
      </div>
    </div>
  );
}

function ModeButton({
  active, title, onClick, children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={title} side="bottom">
      <button
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '30px', height: '24px',
          border: 'none', padding: 0, cursor: 'pointer',
          background: active ? 'var(--origin-bg-active)' : 'transparent',
          color: active ? 'var(--origin-fg-default)' : 'var(--origin-fg-muted)',
          transition: 'background 0.1s, color 0.1s',
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--origin-bg-hover)'; }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      >
        {children}
      </button>
    </Tooltip>
  );
}
