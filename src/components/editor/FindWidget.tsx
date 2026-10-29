/**
 * Barre de recherche « Find » de l'éditeur, façon VS Code.
 *
 * Overlay flottant ancré en **haut à droite** de la zone d'édition (et non un
 * panneau pleine largeur). Elle pilote directement l'API `@codemirror/search` :
 *   - champ de recherche + compteur « N of M » ;
 *   - toggles Aa (casse), .* (regex), ab (mot entier) ;
 *   - navigation ↑ / ↓ (comme Entrée / Maj+Entrée) ;
 *   - fermeture ✕ (Échap) ;
 *   - ligne de remplacement dépliable (Ctrl+H) avec « Replace » / « Replace All ».
 *
 * Le composant est purement présentationnel : toute la logique CodeMirror vit
 * dans l'instance d'éditeur et est exposée via `EditorHandle` (props ci-dessous).
 */
import { useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, X, Replace, ReplaceAll, CaseSensitive, Regex, WholeWord, ChevronRight } from 'lucide-react';
import type { SearchOptions, SearchStatus } from './findController';

interface FindWidgetProps {
  /** Options courantes (casse / regex / mot entier) — reflètent l'état CM. */
  options: SearchOptions;
  /** Disponibilité du remplacement (Ctrl+H) — masque/affiche la ligne replace. */
  replaceOpen: boolean;
  /** Statut courant du compteur (« 3 of 12 » ou vide). */
  status: SearchStatus;
  onChangeOptions: (patch: Partial<SearchOptions>) => void;
  onChangeQuery: (query: string) => void;
  onChangeReplace: (value: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
  onToggleReplace: () => void;
  onClose: () => void;
}

// Styles partagés des boutons-icônes (état actif = fond accentué).
function iconBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, padding: 0,
    border: 'none', borderRadius: 4, cursor: 'pointer',
    background: active ? 'var(--origin-accent-blue)' : 'transparent',
    color: active ? '#fff' : 'var(--origin-fg-muted)',
    flexShrink: 0,
  };
}

function IconButton({ active, title, onClick, children }: {
  active?: boolean; title: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={iconBtnStyle(!!active)}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export default function FindWidget({
  options, replaceOpen, status,
  onChangeOptions, onChangeQuery, onChangeReplace,
  onFindNext, onFindPrevious, onReplaceNext, onReplaceAll, onToggleReplace, onClose,
}: FindWidgetProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  // Focus auto sur le champ de recherche à l'ouverture (parité VS Code).
  useEffect(() => { searchRef.current?.focus(); searchRef.current?.select(); }, []);
  // Focus sur le champ de remplacement quand la ligne replace s'ouvre.
  useEffect(() => { if (replaceOpen) replaceRef.current?.focus(); }, [replaceOpen]);

  const inputStyle: React.CSSProperties = {
    background: 'var(--origin-bg-input)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: 4,
    color: 'var(--origin-fg-default)',
    padding: '3px 7px',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    outline: 'none',
    width: 220,
  };

  return (
    <div
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) onFindPrevious(); else onFindNext();
        }
      }}
      style={{
        position: 'absolute',
        top: 6,
        right: 18,
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 4,
        padding: '5px 6px',
        background: 'var(--origin-bg-panel, var(--origin-bg-base))',
        border: '1px solid var(--origin-border-default)',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--origin-fg-default)',
      }}
    >
      {/* Chevron : déplie/replie la ligne de remplacement (comme VS Code). */}
      <IconButton title={replaceOpen ? 'Hide Replace' : 'Show Replace'} onClick={onToggleReplace}>
        <ChevronRight size={14} style={{ transform: replaceOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s' }} />
      </IconButton>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Ligne 1 : recherche */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            ref={searchRef}
            value={status.query}
            spellCheck={false}
            placeholder="Find"
            onChange={e => onChangeQuery(e.target.value)}
            style={inputStyle}
          />
          <span style={{
            fontSize: 11, color: 'var(--origin-fg-subtle)', minWidth: 54, textAlign: 'center',
            userSelect: 'none', flexShrink: 0,
          }}>
            {status.label}
          </span>
          <IconButton title="Previous Match (Shift+Enter)" onClick={onFindPrevious}><ChevronUp size={14} /></IconButton>
          <IconButton title="Next Match (Enter)" onClick={onFindNext}><ChevronDown size={14} /></IconButton>
          <IconButton title="Match Case" active={options.caseSensitive} onClick={() => onChangeOptions({ caseSensitive: !options.caseSensitive })}><CaseSensitive size={14} /></IconButton>
          <IconButton title="Use Regular Expression" active={options.regexp} onClick={() => onChangeOptions({ regexp: !options.regexp })}><Regex size={14} /></IconButton>
          <IconButton title="Match Whole Word" active={options.wholeWord} onClick={() => onChangeOptions({ wholeWord: !options.wholeWord })}><WholeWord size={14} /></IconButton>
          <IconButton title="Close (Esc)" onClick={onClose}><X size={14} /></IconButton>
        </div>

        {/* Ligne 2 : remplacement (visible seulement si déplié) */}
        {replaceOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              ref={replaceRef}
              value={status.replace}
              spellCheck={false}
              placeholder="Replace"
              onChange={e => onChangeReplace(e.target.value)}
              style={inputStyle}
            />
            <IconButton title="Replace" onClick={onReplaceNext}><Replace size={14} /></IconButton>
            <IconButton title="Replace All" onClick={onReplaceAll}><ReplaceAll size={14} /></IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
