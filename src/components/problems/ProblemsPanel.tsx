import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, XCircle, AlertTriangle, Info, Lightbulb } from 'lucide-react';
import { useDiagnostics, type DiagnosticEntry, type DiagnosticSeverity } from '../../context/DiagnosticsContext';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

function severityIcon(sev: DiagnosticSeverity, size = 13) {
  switch (sev) {
    case 'error':   return <XCircle size={size} style={{ color: 'var(--origin-semantic-error)' }} />;
    case 'warning': return <AlertTriangle size={size} style={{ color: 'var(--origin-accent-yellow)' }} />;
    case 'info':    return <Info size={size} style={{ color: 'var(--origin-accent-blue)' }} />;
    case 'hint':    return <Lightbulb size={size} style={{ color: 'var(--origin-fg-muted)' }} />;
  }
}

function relPath(abs: string, root: string | null): string {
  if (!root) return abs;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root), a = norm(abs);
  if (a === r) return a.split('/').pop() ?? a;
  if (a.startsWith(r + '/')) return a.slice(r.length + 1);
  return abs;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  rootPath: string | null;
  onOpenFile: (path: string, line: number, col: number) => void;
}

export default function ProblemsPanel({ rootPath, onOpenFile }: Props) {
  const { byFile } = useDiagnostics();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<DiagnosticSeverity | 'all'>('all');

  // Fichiers triés par chemin, diagnostics triés par (sévérité, ligne).
  const groups = useMemo(() => {
    const arr: Array<{ path: string; entries: DiagnosticEntry[] }> = [];
    for (const [path, entries] of byFile.entries()) {
      const filtered = filter === 'all' ? entries : entries.filter(e => e.severity === filter);
      if (filtered.length === 0) continue;
      const sorted = [...filtered].sort((a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line,
      );
      arr.push({ path, entries: sorted });
    }
    arr.sort((a, b) => relPath(a.path, rootPath).localeCompare(relPath(b.path, rootPath)));
    return arr;
  }, [byFile, filter, rootPath]);

  const totalShown = groups.reduce((n, g) => n + g.entries.length, 0);

  function toggle(path: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  const filters: Array<{ id: DiagnosticSeverity | 'all'; label: string }> = [
    { id: 'all',     label: 'All' },
    { id: 'error',   label: 'Errors' },
    { id: 'warning', label: 'Warnings' },
    { id: 'info',    label: 'Info' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '5px 8px', flexShrink: 0,
        borderBottom: '1px solid var(--origin-border-subtle)',
      }}>
        {filters.map(f => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                padding: '2px 8px', borderRadius: 4, border: 'none',
                fontSize: 11, cursor: 'pointer',
                background: active ? 'var(--origin-bg-active)' : 'transparent',
                color: active ? 'var(--origin-fg-default)' : 'var(--origin-fg-muted)',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--origin-bg-hover)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              {f.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--origin-fg-subtle)' }}>
          {totalShown} problem{totalShown !== 1 ? 's' : ''}
        </span>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {groups.length === 0 ? (
          <div style={{ padding: '12px', fontSize: 12, color: 'var(--origin-fg-subtle)' }}>
            No problems detected.
          </div>
        ) : groups.map(group => {
          const isCollapsed = collapsed.has(group.path);
          return (
            <div key={group.path}>
              {/* File header */}
              <button
                onClick={() => toggle(group.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  width: '100%', padding: '4px 8px', border: 'none', cursor: 'pointer',
                  background: 'transparent', textAlign: 'left',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--origin-bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {isCollapsed ? <ChevronRight size={13} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />
                             : <ChevronDown size={13} style={{ color: 'var(--origin-fg-muted)', flexShrink: 0 }} />}
                <span style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--origin-fg-default)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }} title={group.path}>
                  {relPath(group.path, rootPath)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>
                  {group.entries.length}
                </span>
              </button>

              {/* Diagnostics */}
              {!isCollapsed && group.entries.map((d, i) => (
                <div
                  key={i}
                  onClick={() => onOpenFile(group.path, d.line, d.col)}
                  title={d.message}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                    padding: '3px 8px 3px 28px', cursor: 'pointer',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--origin-bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ flexShrink: 0, marginTop: 1 }}>{severityIcon(d.severity, 13)}</span>
                  <span style={{
                    fontSize: 12, color: 'var(--origin-fg-default)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {d.message}
                  </span>
                  {d.code && (
                    <span style={{ fontSize: 11, color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>{d.code}</span>
                  )}
                  <span style={{
                    fontSize: 11, color: 'var(--origin-fg-subtle)', flexShrink: 0,
                    fontFamily: 'var(--font-mono)',
                  }}>
                    [{d.line}, {d.col}]
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
