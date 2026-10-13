import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Replace, ChevronDown, ChevronRight, CaseSensitive, Regex, WholeWord } from 'lucide-react';
import {
  searchInFiles,
  replaceInFiles,
  DEFAULT_SEARCH_OPTIONS,
  type SearchMatch,
  type SearchOptions,
} from '../lib/search';
import FileIcon from './FileIcon';
import { useWorkspace } from '../context/WorkspaceContext';

interface Props {
  onFileOpenAtLine: (path: string, line: number, col: number) => void;
  /** Notifie le parent qu'un fichier a été modifié sur disque (rafraîchissement). */
  onFilesChanged?: (paths: string[]) => void;
}

interface Group {
  path: string;
  name: string;
  rel: string;
  matches: SearchMatch[];
}

function groupResults(matches: SearchMatch[], base: string | null): Group[] {
  const map = new Map<string, Group>();
  for (const m of matches) {
    if (!map.has(m.path)) {
      const name = m.path.split(/[/\\]/).pop() ?? m.path;
      const rel = base && m.path.startsWith(base)
        ? m.path.slice(base.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
        : m.path;
      map.set(m.path, { path: m.path, name, rel, matches: [] });
    }
    map.get(m.path)!.matches.push(m);
  }
  return [...map.values()];
}

/** Calcule l'intervalle à surligner dans une ligne, en tenant compte des options. */
function highlightRange(text: string, query: string, opts: SearchOptions): [number, number] | null {
  if (!query) return null;
  try {
    const source = opts.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = opts.wholeWord ? `\\b(?:${source})\\b` : source;
    const re = new RegExp(pattern, opts.caseSensitive ? '' : 'i');
    const m = re.exec(text);
    return m && m[0].length > 0 ? [m.index, m.index + m[0].length] : null;
  } catch {
    // Regex invalide en cours de frappe : pas de surlignage.
    return null;
  }
}

function MatchLine({ match, query, opts, onOpen }: { match: SearchMatch; query: string; opts: SearchOptions; onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);
  const range = highlightRange(match.text, query, opts);

  const highlighted = range ? (
    <>
      {match.text.slice(0, range[0])}
      <mark style={{ background: 'var(--origin-accent-blue)', color: 'var(--origin-bg-base)', borderRadius: 2, padding: '0 1px' }}>
        {match.text.slice(range[0], range[1])}
      </mark>
      {match.text.slice(range[1])}
    </>
  ) : match.text;

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        padding: '2px 10px 2px 24px', cursor: 'pointer',
        background: hovered ? 'var(--origin-bg-hover)' : 'transparent',
        transition: 'background 0.08s',
      }}
    >
      <span style={{
        fontSize: 10, color: 'var(--origin-fg-subtle)', flexShrink: 0,
        fontFamily: 'var(--font-mono)', minWidth: 26, textAlign: 'right',
      }}>
        {match.line}
      </span>
      <span style={{
        fontSize: 12, color: 'var(--origin-fg-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
      }}>
        {highlighted}
      </span>
    </div>
  );
}

/** Petit bouton à bascule pour les options de recherche. */
function OptionToggle({
  active, title, onClick, children,
}: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer',
        background: active ? 'var(--origin-accent-blue)' : 'transparent',
        color: active ? 'var(--origin-bg-base)' : 'var(--origin-fg-muted)',
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

export default function SearchPanel({ onFileOpenAtLine, onFilesChanged }: Props) {
  const { folderPath } = useWorkspace();
  const [query, setQuery]         = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [excludes, setExcludes]   = useState('');
  const [excludesOpen, setExcludesOpen] = useState(false);
  const [opts, setOpts]           = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [results, setResults]     = useState<SearchMatch[]>([]);
  const [loading, setLoading]     = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Recherche (debounce) ────────────────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim() || !folderPath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard reset when query/folder is empty
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(() => {
      searchInFiles(folderPath, query, opts, excludes)
        .then(r => { setResults(r); setError(null); setLoading(false); })
        .catch(e => { setResults([]); setError(String(e)); setLoading(false); });
    }, 350);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, folderPath, opts, excludes]);

  const groups = groupResults(results, folderPath);

  const toggleOpt = useCallback((key: keyof SearchOptions) => {
    setOpts(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ── Remplacement ────────────────────────────────────────────────────────────
  const runReplace = useCallback(async (files?: string[]) => {
    if (!folderPath || !query.trim()) return;
    setReplacing(true);
    setError(null);
    try {
      const res = await replaceInFiles(folderPath, query, replacement, opts, excludes, files);
      // Rafraîchit la liste de résultats. On relance la recherche AVANT de
      // notifier les fichiers modifiés : après remplacement, les correspondances
      // peuvent avoir disparu (liste vide), mais les onglets doivent malgré tout
      // être rechargés — on se base donc sur `res.files` (source de vérité).
      const fresh = await searchInFiles(folderPath, query, opts, excludes);
      setResults(fresh);
      if (res.files.length > 0) onFilesChanged?.(res.files);
      if (res.replacements === 0) setError('No matches replaced');
    } catch (e) {
      setError(String(e));
    } finally {
      setReplacing(false);
    }
  }, [folderPath, query, replacement, opts, excludes, onFilesChanged]);

  const replaceOne = useCallback((path: string) => { void runReplace([path]); }, [runReplace]);

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    border: 'none', cursor: 'pointer', borderRadius: 4,
    padding: '0 6px', height: 20, fontSize: 11, fontFamily: 'var(--font-mono)',
    background: active ? 'var(--origin-accent-blue)' : 'transparent',
    color: active ? 'var(--origin-bg-base)' : 'var(--origin-fg-subtle)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Section label */}
      <div style={{
        padding: '10px 12px 6px', fontSize: 11, fontWeight: 600,
        letterSpacing: '0.8px', textTransform: 'uppercase',
        color: 'var(--origin-fg-muted)',
      }}>
        Search
      </div>

      {/* Input + options */}
      <div style={{ padding: '0 8px 8px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--origin-bg-input)',
          border: '1px solid var(--origin-border-default)',
          borderRadius: 6, padding: '3px 4px 3px 8px',
        }}>
          <button
            title={replaceOpen ? 'Hide replace' : 'Show replace'}
            onClick={() => setReplaceOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--origin-fg-muted)', padding: 0, flexShrink: 0,
            }}
          >
            {replaceOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Search size={12} style={{
              opacity: loading ? 0.4 : 1,
              animation: loading ? 'pulse 1s ease-in-out infinite' : 'none',
            }} />
          </button>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search files…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--origin-fg-default)', fontFamily: 'var(--font-sans)',
              minWidth: 0,
            }}
          />
          <OptionToggle active={opts.caseSensitive} title="Match Case" onClick={() => toggleOpt('caseSensitive')}>
            <CaseSensitive size={13} />
          </OptionToggle>
          <OptionToggle active={opts.wholeWord} title="Match Whole Word" onClick={() => toggleOpt('wholeWord')}>
            <WholeWord size={13} />
          </OptionToggle>
          <OptionToggle active={opts.isRegex} title="Use Regular Expression" onClick={() => toggleOpt('isRegex')}>
            <Regex size={13} />
          </OptionToggle>
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--origin-fg-subtle)', padding: 0, fontSize: 14, lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>

        {/* Exclusions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <button
            title={excludesOpen ? 'Hide files to exclude' : 'Files to exclude'}
            onClick={() => setExcludesOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--origin-fg-muted)', padding: 0,
            }}
          >
            {excludesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {excludesOpen && (
            <input
              value={excludes}
              onChange={e => setExcludes(e.target.value)}
              placeholder="files to exclude (e.g. *.lock, dist/**)"
              style={{
                flex: 1, background: 'var(--origin-bg-input)',
                border: '1px solid var(--origin-border-default)', borderRadius: 6,
                padding: '4px 8px', outline: 'none', fontSize: 12,
                color: 'var(--origin-fg-default)', fontFamily: 'var(--font-mono)', minWidth: 0,
              }}
            />
          )}
        </div>

        {/* Replace row */}
        {replaceOpen && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
            background: 'var(--origin-bg-input)',
            border: '1px solid var(--origin-border-default)',
            borderRadius: 6, padding: '3px 4px 3px 8px',
          }}>
            <Replace size={12} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />
            <input
              value={replacement}
              onChange={e => setReplacement(e.target.value)}
              placeholder={opts.isRegex ? 'Replace… ($1 for groups)' : 'Replace…'}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontSize: 12, color: 'var(--origin-fg-default)', fontFamily: 'var(--font-sans)',
                minWidth: 0,
              }}
            />
            <button
              onClick={() => { void runReplace(); }}
              disabled={!query.trim() || replacing || results.length === 0}
              title="Replace All"
              style={toggleStyle(false)}
            >
              {replacing ? '…' : 'All'}
            </button>
          </div>
        )}
      </div>

      {/* Results summary */}
      {results.length > 0 && (
        <div style={{ padding: '0 12px 4px', fontSize: 10, color: 'var(--origin-fg-subtle)' }}>
          {results.length}{results.length >= 500 ? '+' : ''} result{results.length !== 1 ? 's' : ''} in {groups.length} file{groups.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Error / info */}
      {error && (
        <div style={{ padding: '0 12px 4px', fontSize: 10, color: 'var(--origin-accent-red, #e06c75)' }}>
          {error}
        </div>
      )}

      {/* Result list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!folderPath && (
          <div style={{ padding: '20px 12px', fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center' }}>
            Open a folder to search
          </div>
        )}

        {folderPath && query.trim() && !loading && results.length === 0 && !error && (
          <div style={{ padding: '20px 12px', fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center' }}>
            No results for "{query}"
          </div>
        )}

        {groups.map(group => (
          <div key={group.path}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px 2px', fontSize: 12, fontWeight: 500,
              color: 'var(--origin-fg-default)',
              position: 'sticky', top: 0,
              background: 'var(--origin-bg-sidebar)',
            }}>
              <FileIcon name={group.name} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {group.name}
              </span>
              {replaceOpen && (
                <button
                  onClick={() => replaceOne(group.path)}
                  disabled={replacing}
                  title={`Replace all in ${group.name}`}
                  style={toggleStyle(false)}
                >
                  All
                </button>
              )}
              <span style={{ fontSize: 10, color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>
                {group.matches.length}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--origin-fg-subtle)', padding: '0 10px 3px 24px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.rel}
            </div>
            {group.matches.map((m, i) => (
              <MatchLine
                key={i}
                match={m}
                query={query}
                opts={opts}
                onOpen={() => onFileOpenAtLine(m.path, m.line, m.col + 1)}
              />
            ))}
          </div>
        ))}

        {results.length >= 500 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--origin-fg-subtle)', fontStyle: 'italic' }}>
            Showing first 500 matches — refine your query to narrow results
          </div>
        )}
      </div>
    </div>
  );
}
