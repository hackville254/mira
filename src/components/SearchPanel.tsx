import { useState, useEffect, useRef, useCallback } from 'react';
import { Replace, ChevronDown, ChevronRight, CaseSensitive, Regex, WholeWord, ReplaceAll, X } from 'lucide-react';
import {
  searchInFiles,
  replaceInFiles,
  replaceOne,
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

/**
 * Miroir front de `apply_preserve_case` (Rust) pour l'aperçu barré : calque la
 * casse du texte d'origine sur le remplacement. Utilisé uniquement à l'affichage.
 */
function applyPreserveCase(matched: string, replacement: string): string {
  if (!replacement) return replacement;
  if (!/[a-zA-Z]/.test(matched)) return replacement;
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
}

function MatchLine({
  match, query, opts, replacement, replaceOpen, preserveCase, onOpen, onReplaceOne, onDismiss, busy,
}: {
  match: SearchMatch;
  query: string;
  opts: SearchOptions;
  /** Texte de remplacement : si non vide, l'occurrence est barrée avec l'aperçu. */
  replacement: string;
  /** Vrai si la ligne de remplacement est dépliée. */
  replaceOpen: boolean;
  preserveCase: boolean;
  onOpen: () => void;
  onReplaceOne?: () => void;
  onDismiss?: () => void;
  busy?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const range = highlightRange(match.text, query, opts);
  const showDiff = replaceOpen && replacement.length > 0 && !!range;

  // Aperçu du remplacement façon VS Code : l'occurrence d'origine est barrée,
  // suivie du texte de remplacement (casse « Preserve Case » appliquée si activée).
  const previewReplacement = preserveCase && range
    ? applyPreserveCase(match.text.slice(range[0], range[1]), replacement)
    : replacement;

  const highlighted = range ? (
    <>
      {match.text.slice(0, range[0])}
      {showDiff ? (
        <>
          <span style={{ background: 'var(--origin-accent-red, #e06c75)', color: 'var(--origin-bg-base)', borderRadius: 2, padding: '0 1px', textDecoration: 'line-through' }}>
            {match.text.slice(range[0], range[1])}
          </span>
          <span style={{ background: 'var(--origin-accent-green, #98c379)', color: 'var(--origin-bg-base)', borderRadius: 2, padding: '0 1px', marginLeft: 2 }}>
            {previewReplacement}
          </span>
        </>
      ) : (
        <mark style={{ background: 'var(--origin-accent-blue)', color: 'var(--origin-bg-base)', borderRadius: 2, padding: '0 1px' }}>
          {match.text.slice(range[0], range[1])}
        </mark>
      )}
      {match.text.slice(range[1])}
    </>
  ) : match.text;

  const iconBtn = (label: string, onClick: () => void, icon: React.ReactNode) => (
    <button
      title={label}
      onClick={e => { e.stopPropagation(); onClick(); }}
      disabled={busy}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, border: 'none', borderRadius: 3, cursor: 'pointer',
        background: 'transparent', color: 'var(--origin-fg-muted)', padding: 0, flexShrink: 0,
      }}
    >
      {icon}
    </button>
  );

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
        fontSize: 12, color: 'var(--origin-fg-muted)', flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
      }}>
        {highlighted}
      </span>
      {/* Actions au survol (parité VS Code) : Replace l'occurrence / Dismiss. */}
      {hovered && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {onReplaceOne && iconBtn('Replace', onReplaceOne, <Replace size={12} />)}
          {onDismiss && iconBtn('Dismiss', onDismiss, <X size={12} />)}
        </span>
      )}
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
  const [preserveCase, setPreserveCase] = useState(false);
  const [excludes, setExcludes]   = useState('');
  const [includes, setIncludes]   = useState('');
  const [excludesOpen, setExcludesOpen] = useState(false);
  const [includesOpen, setIncludesOpen] = useState(false);
  const [opts, setOpts]           = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [results, setResults]     = useState<SearchMatch[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [loading, setLoading]     = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Identifie une occurrence de façon stable (fichier + ligne + colonne).
  const matchKey = (m: SearchMatch) => `${m.path}:${m.line}:${m.col}`;

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
      // Une nouvelle recherche repart d'une liste propre : les « dismissed » ne
      // s'appliquent qu'à l'ensemble de résultats courant.
      setDismissed(new Set());
      searchInFiles(folderPath, query, opts, excludes, includes)
        .then(r => { setResults(r); setError(null); setLoading(false); })
        .catch(e => { setResults([]); setError(String(e)); setLoading(false); });
    }, 350);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, folderPath, opts, excludes, includes]);

  // Filtre les occurrences écartées manuellement (bouton « Dismiss »).
  const visibleResults = results.filter(m => !dismissed.has(matchKey(m)));
  const groups = groupResults(visibleResults, folderPath);

  const toggleOpt = useCallback((key: keyof SearchOptions) => {
    setOpts(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const dismissMatch = useCallback((m: SearchMatch) => {
    setDismissed(prev => new Set(prev).add(matchKey(m)));
  }, []);

  // ── Remplacement ────────────────────────────────────────────────────────────
  const runReplace = useCallback(async (files?: string[]) => {
    if (!folderPath || !query.trim()) return;
    setReplacing(true);
    setError(null);
    try {
      const res = await replaceInFiles(folderPath, query, replacement, opts, excludes, files, preserveCase, includes);
      // Rafraîchit la liste de résultats. On relance la recherche AVANT de
      // notifier les fichiers modifiés : après remplacement, les correspondances
      // peuvent avoir disparu (liste vide), mais les onglets doivent malgré tout
      // être rechargés — on se base donc sur `res.files` (source de vérité).
      const fresh = await searchInFiles(folderPath, query, opts, excludes, includes);
      setResults(fresh);
      setDismissed(new Set());
      if (res.files.length > 0) onFilesChanged?.(res.files);
      if (res.replacements === 0) setError('No matches replaced');
    } catch (e) {
      setError(String(e));
    } finally {
      setReplacing(false);
    }
  }, [folderPath, query, replacement, opts, excludes, includes, preserveCase, onFilesChanged]);

  const replaceOneMatch = useCallback(async (m: SearchMatch) => {
    setError(null);
    try {
      const ok = await replaceOne(m.path, query, replacement, m.line, m.col, opts, preserveCase);
      if (!ok) { setError('Match no longer exists'); return; }
      // Rafraîchit la liste et recharge l'onglet éventuellement ouvert.
      if (folderPath) {
        const fresh = await searchInFiles(folderPath, query, opts, excludes, includes);
        setResults(fresh);
      }
      onFilesChanged?.([m.path]);
    } catch (e) {
      setError(String(e));
    }
  }, [query, replacement, opts, preserveCase, folderPath, excludes, includes, onFilesChanged]);

  const replaceOneFile = useCallback((path: string) => { void runReplace([path]); }, [runReplace]);

  // Raccourcis clavier (parité VS Code) : Ctrl+Alt+Enter = Replace All,
  // Entrée = recherche (ou navigue vers le 1er résultat).
  const onQueryKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      void runReplace();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visibleResults[0]) onFileOpenAtLine(visibleResults[0].path, visibleResults[0].line, visibleResults[0].col + 1);
    }
  };

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    border: 'none', cursor: 'pointer', borderRadius: 4,
    padding: '0 6px', height: 20, fontSize: 11, fontFamily: 'var(--font-mono)',
    background: active ? 'var(--origin-accent-blue)' : 'transparent',
    color: active ? 'var(--origin-bg-base)' : 'var(--origin-fg-subtle)',
  });

  // Bouton d'action carré (icône) façon VS Code.
  const actionBtn = (title: string, onClick: () => void, disabled: boolean, icon: React.ReactNode): React.ReactNode => (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, border: 'none', borderRadius: 4, padding: 0,
        cursor: disabled ? 'default' : 'pointer',
        background: 'transparent',
        color: disabled ? 'var(--origin-fg-subtle)' : 'var(--origin-fg-muted)',
        opacity: disabled ? 0.4 : 1, flexShrink: 0,
      }}
    >
      {icon}
    </button>
  );

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
        {/* Ligne 1 : chevron (de gauche à droite : toggle replace) + champ de recherche.
            Le chevron est à GAUCHE, comme dans VS Code. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            title={replaceOpen ? 'Hide replace' : 'Show replace'}
            onClick={() => { setReplaceOpen(v => !v); if (!replaceOpen) replaceInputRef.current?.focus(); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', width: 20, height: 24,
              cursor: 'pointer', color: 'var(--origin-fg-muted)', padding: 0, flexShrink: 0,
            }}
          >
            {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--origin-bg-input)',
            border: '1px solid var(--origin-border-default)',
            borderRadius: 6, padding: '3px 4px 3px 8px', minWidth: 0,
          }}>
            <input
              ref={queryInputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onQueryKeyDown}
              placeholder="Search"
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
                onClick={() => { setQuery(''); queryInputRef.current?.focus(); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--origin-fg-subtle)', padding: 0, fontSize: 14, lineHeight: 1,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Ligne 2 (si replace ouvert) : champ de remplacement aligné sous le
            champ de recherche, avec un espace à gauche pour s'aligner sur le
            chevron — exactement comme VS Code. Deux boutons : Replace (un
            résultat) et Replace All (tous). */}
        {replaceOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <span style={{ width: 20, flexShrink: 0 }} />
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--origin-bg-input)',
              border: '1px solid var(--origin-border-default)',
              borderRadius: 6, padding: '3px 4px 3px 8px', minWidth: 0,
            }}>
              <input
                ref={replaceInputRef}
                value={replacement}
                onChange={e => setReplacement(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
                    e.preventDefault();
                    void runReplace();
                  }
                }}
                placeholder={opts.isRegex ? 'Replace ($1 for groups)' : 'Replace'}
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  fontSize: 12, color: 'var(--origin-fg-default)', fontFamily: 'var(--font-sans)',
                  minWidth: 0,
                }}
              />
              <OptionToggle active={preserveCase} title="Preserve Case" onClick={() => setPreserveCase(v => !v)}>
                <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>AB</span>
              </OptionToggle>
            </div>
            {actionBtn('Replace All (Ctrl+Alt+Enter)', () => { void runReplace(); }, !query.trim() || replacing || visibleResults.length === 0, <ReplaceAll size={14} />)}
          </div>
        )}

        {/* Files to include (chevron + champ) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <button
            title={includesOpen ? 'Hide files to include' : 'Files to include'}
            onClick={() => setIncludesOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', width: 20, height: 24,
              cursor: 'pointer', color: 'var(--origin-fg-muted)', padding: 0, flexShrink: 0,
            }}
          >
            {includesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {includesOpen && (
            <input
              value={includes}
              onChange={e => setIncludes(e.target.value)}
              placeholder="files to include (e.g. src/**/*.ts)"
              style={{
                flex: 1, background: 'var(--origin-bg-input)',
                border: '1px solid var(--origin-border-default)', borderRadius: 6,
                padding: '4px 8px', outline: 'none', fontSize: 12,
                color: 'var(--origin-fg-default)', fontFamily: 'var(--font-mono)', minWidth: 0,
              }}
            />
          )}
        </div>

        {/* Files to exclude (chevron + champ) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <button
            title={excludesOpen ? 'Hide files to exclude' : 'Files to exclude'}
            onClick={() => setExcludesOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', width: 20, height: 24,
              cursor: 'pointer', color: 'var(--origin-fg-muted)', padding: 0, flexShrink: 0,
            }}
          >
            {excludesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
      </div>

      {/* Results summary */}
      {visibleResults.length > 0 && (
        <div style={{ padding: '0 12px 4px', fontSize: 10, color: 'var(--origin-fg-subtle)' }}>
          {visibleResults.length}{visibleResults.length >= 500 ? '+' : ''} result{visibleResults.length !== 1 ? 's' : ''} in {groups.length} file{groups.length !== 1 ? 's' : ''}
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

        {folderPath && query.trim() && !loading && visibleResults.length === 0 && !error && (
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
                  onClick={() => replaceOneFile(group.path)}
                  disabled={replacing}
                  title={`Replace all in ${group.name}`}
                  style={{ ...toggleStyle(false), display: 'flex', alignItems: 'center' }}
                >
                  <ReplaceAll size={12} />
                </button>
              )}
              <span style={{ fontSize: 10, color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>
                {group.matches.length}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--origin-fg-subtle)', padding: '0 10px 3px 24px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.rel}
            </div>
            {group.matches.map(m => (
              <MatchLine
                key={matchKey(m)}
                match={m}
                query={query}
                opts={opts}
                replacement={replacement}
                replaceOpen={replaceOpen}
                preserveCase={preserveCase}
                busy={replacing}
                onOpen={() => onFileOpenAtLine(m.path, m.line, m.col + 1)}
                onReplaceOne={replaceOpen ? () => { void replaceOneMatch(m); } : undefined}
                onDismiss={() => dismissMatch(m)}
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
