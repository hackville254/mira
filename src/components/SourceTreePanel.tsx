import { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, Download, GitBranch, Check, RefreshCw, MoreHorizontal, ChevronDown, ChevronRight } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from './ui/Toast';
import {
  getStatusFiles, getGitLogFull, gitCommit, gitCommitPush,
  type StatusFile, type FullCommitEntry,
} from '../lib/git';

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(raw: string): string {
  const s = raw.replace(/\s/g, '');
  if (s === '??' || s === 'U') return 'var(--origin-git-untracked)';
  if (s[0] === 'A') return 'var(--origin-git-added)';
  if (s[0] === 'M' || s[1] === 'M') return 'var(--origin-git-modified)';
  if (s[0] === 'D' || s[1] === 'D') return 'var(--origin-git-deleted)';
  if (s[0] === 'R') return 'var(--origin-accent-blue)';
  return 'var(--origin-fg-muted)';
}

function statusLabel(raw: string): string {
  if (raw === '??') return 'U';
  const s = raw.replace(/\s/g, '');
  return s[0] ?? '?';
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const ROW_PL  = 10;
const DOT_W   = 8;
const RAIL_L  = ROW_PL + DOT_W / 2;

export default function SourceTreePanel() {
  const { folderPath } = useWorkspace();
  const [files, setFiles]       = useState<StatusFile[]>([]);
  const [history, setHistory]   = useState<FullCommitEntry[]>([]);
  const [title, setTitle]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [aiBusy, setAiBusy]     = useState(false);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const [agentReviewOpen, setAgentReviewOpen] = useState(false);
  const [graphOpen, setGraphOpen]     = useState(true);
  const { showToast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const historyScrollRef        = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop]   = useState(false);
  const [fadeBot, setFadeBot]   = useState(false);

  function updateFades() {
    const el = historyScrollRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 2);
    setFadeBot(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }

  useEffect(() => {
    const id = requestAnimationFrame(updateFades);
    return () => cancelAnimationFrame(id);
  }, [history]);

  const load = useCallback(async () => {
    if (!folderPath) return;
    const [f, h] = await Promise.all([
      getStatusFiles(folderPath),
      getGitLogFull(folderPath),
    ]);
    setFiles(f);
    setHistory(h);
    return { files: f, history: h };
  }, [folderPath]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() syncs external git state into React on mount/folder change
  useEffect(() => { load(); }, [load]);

  async function refresh() {
    if (!folderPath || refreshing) return;
    setRefreshing(true);
    try {
      const result = await load();
      const f = result?.files ?? [];
      const h = result?.history ?? [];
      showToast(
        `${f.length} change${f.length !== 1 ? 's' : ''} · ${h.length} commit${h.length !== 1 ? 's' : ''}`,
        'info',
      );
    } catch {
      showToast('Failed to refresh.', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function aiGenerateMessage() {
    if (!folderPath || aiBusy) return;
    setAiBusy(true);
    try {
      const names = files.map(f => shortPath(f.path)).join(', ');
      const counts = { M: 0, A: 0, D: 0, U: 0, R: 0 };
      for (const f of files) {
        const l = statusLabel(f.status);
        if (l in counts) (counts as Record<string, number>)[l]++;
      }
      const parts: string[] = [];
      if (counts.M) parts.push(`${counts.M} modified`);
      if (counts.A) parts.push(`${counts.A} added`);
      if (counts.D) parts.push(`${counts.D} deleted`);
      if (counts.U) parts.push(`${counts.U} untracked`);
      if (counts.R) parts.push(`${counts.R} renamed`);
      const summary = parts.join(', ') || 'changes';
      setTitle(`${summary}: ${names.slice(0, 60)}${names.length > 60 ? '…' : ''}`);
      showToast('Commit message generated.', 'success');
    } catch {
      showToast('Failed to generate message.', 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function commit(andPush: boolean) {
    if (!folderPath || !title.trim() || busy) return;
    setBusy(true);
    try {
      if (andPush) {
        await gitCommitPush(folderPath, title.trim(), '');
      } else {
        await gitCommit(folderPath, title.trim(), '');
      }
      setTitle('');
      showToast(andPush ? 'Committed and pushed.' : 'Committed successfully.', 'success');
      await load();
    } catch (e: unknown) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!folderPath) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <p style={{ fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center', lineHeight: 1.5 }}>
          Open a folder to use source control
        </p>
      </div>
    );
  }

  const canCommit = title.trim().length > 0 && !busy;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, position: 'relative' }}>

      {/* ── Changes section ─────────────────────────────────────────────── */}
      <div style={{
        borderBottom: '1px solid var(--origin-border-default)',
        display: 'flex', flexDirection: 'column',
        flex: changesOpen ? '0 0 auto' : '0 0 auto',
      }}>
        {/* Changes header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 8px 4px',
        }}>
          <button
            onClick={() => setChangesOpen(o => !o)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, color: 'var(--origin-fg-muted)', display: 'flex' }}
          >
            {changesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: 'var(--origin-fg-default)', flex: 1,
          }}>
            Changes
          </span>
          <button title="AI Commit" style={iconBtn}><Sparkles size={14} /></button>
          <button title="Download" style={iconBtn}><Download size={14} /></button>
          <button title="Branches" style={iconBtn}><GitBranch size={14} /></button>
          <button title="Check" style={iconBtn}><Check size={14} /></button>
          <button
            onClick={refresh}
            title="Refresh"
            style={iconBtn}
          >
            <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <button title="More" style={iconBtn}><MoreHorizontal size={14} /></button>
        </div>

        {changesOpen && (
          <>
            {/* Commit message input */}
            <div style={{ padding: '4px 8px' }}>
              <div style={{ position: 'relative' }}>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && canCommit && commit(false)}
                  placeholder="(⌘↵ to comm...)"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--origin-bg-base)',
                    border: '1px solid var(--origin-border-default)',
                    borderRadius: 5, padding: '6px 44px 6px 10px',
                    fontSize: 12, color: 'var(--origin-fg-default)',
                    fontFamily: 'var(--font-sans)', outline: 'none',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--origin-accent-blue)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--origin-border-default)'; }}
                />
                <div style={{
                  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                  display: 'flex', alignItems: 'center', gap: 2,
                }}>
                  <button
                    onClick={aiGenerateMessage}
                    disabled={aiBusy}
                    title="Generate commit message with AI"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 22, height: 22, borderRadius: 4, border: 'none',
                      background: 'transparent',
                      cursor: aiBusy ? 'wait' : 'pointer',
                      color: aiBusy ? 'var(--origin-fg-subtle)' : '#34d399',
                    }}
                    onMouseEnter={e => { if (!aiBusy) e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <Sparkles size={13} style={{ animation: aiBusy ? 'spin 0.7s linear infinite' : 'none' }} />
                  </button>
                </div>
              </div>

              {/* Commit button with dropdown */}
              <div style={{ display: 'flex', marginTop: 6, position: 'relative' }}>
                <button
                  onClick={() => commit(false)}
                  disabled={!canCommit}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '7px 0', borderRadius: '5px 0 0 5px', border: 'none',
                    cursor: canCommit ? 'pointer' : 'not-allowed',
                    background: canCommit ? 'var(--origin-accent-blue)' : 'var(--origin-bg-hover)',
                    color: canCommit ? '#fff' : 'var(--origin-fg-subtle)',
                    fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)',
                  }}
                >
                  <Check size={13} />
                  {busy ? 'Committing…' : `Commit ${String.fromCharCode(8984)}${String.fromCharCode(8617)}`}
                </button>
                <button
                  onClick={() => setCommitMenuOpen(o => !o)}
                  disabled={!canCommit}
                  title="More commit options"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 30, borderRadius: '0 5px 5px 0', border: 'none',
                    cursor: canCommit ? 'pointer' : 'not-allowed',
                    background: canCommit ? 'var(--origin-accent-blue)' : 'var(--origin-bg-hover)',
                    color: canCommit ? '#fff' : 'var(--origin-fg-subtle)',
                    borderLeft: '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <ChevronDown size={13} />
                </button>

                {commitMenuOpen && (
                  <>
                    <div
                      onClick={() => setCommitMenuOpen(false)}
                      style={{ position: 'fixed', inset: 0, zIndex: 50 }}
                    />
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, zIndex: 60,
                      marginTop: 4, minWidth: 200, padding: 6,
                      backgroundColor: 'var(--origin-bg-panel)',
                      border: '1px solid var(--origin-border-default)',
                      borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    }}>
                      {[
                        { label: 'Commit', action: () => commit(false) },
                        { label: 'Commit (Amend)', action: () => commit(false) },
                      ].map((o, i) => (
                        <button
                          key={i}
                          onClick={() => { o.action(); setCommitMenuOpen(false); }}
                          style={menuItemStyle}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          {o.label}
                        </button>
                      ))}
                      <div style={{ height: 1, margin: '4px 6px', backgroundColor: 'var(--origin-border-default)' }} />
                      {[
                        { label: 'Commit & Push', action: () => commit(true) },
                        { label: 'Commit & Sync', action: () => commit(true) },
                      ].map((o, i) => (
                        <button
                          key={i}
                          onClick={() => { o.action(); setCommitMenuOpen(false); }}
                          style={menuItemStyle}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Changed files list */}
            <div style={{
              flex: '1 1 auto', overflowY: 'auto', minHeight: 0,
              maxHeight: 260,
              display: 'flex', flexDirection: 'column',
            }}>
              {files.length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--origin-fg-subtle)' }}>
                  No changes detected.
                </div>
              ) : (
                files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px 3px 32px' }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                      color: statusColor(f.status), flexShrink: 0, width: 12, textAlign: 'center',
                    }}>
                      {statusLabel(f.status)}
                    </span>
                    <span style={{
                      fontSize: 12, color: 'var(--origin-fg-default)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {shortPath(f.path)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Bottom section : Agent Review + Graph ──────────────────────── */}
      <div style={{
        marginTop: 'auto',
        borderTop: '1px solid var(--origin-border-default)',
        display: 'flex', flexDirection: 'column',
        flexShrink: 0,
      }}>
      {/* ── Agent Review (placeholder) ─────────────────────────────────── */}
      <div style={{
        borderBottom: '1px solid var(--origin-border-default)',
      }}>
        <div
          onClick={() => setAgentReviewOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 8px', cursor: 'pointer',
          }}
        >
          <span style={{ display: 'flex', color: 'var(--origin-fg-muted)' }}>
            {agentReviewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--origin-fg-default)' }}>
            Agent Review
          </span>
        </div>
        {agentReviewOpen && (
          <div style={{ padding: '0 8px 10px 28px' }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--origin-fg-subtle)' }}>
              No review in progress.
            </p>
          </div>
        )}
      </div>

      {/* ── Graph section ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        minHeight: 0,
      }}>
        {/* Graph header */}
        <div
          onClick={() => setGraphOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px 4px', cursor: 'pointer',
          }}
        >
          <span style={{ display: 'flex', color: 'var(--origin-fg-muted)' }}>
            {graphOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--origin-fg-default)' }}>
            Graph
          </span>
          <div style={{ flex: 1 }} />
          <button title="Auto" style={{ ...iconBtn, gap: 4, padding: '0 6px' }} onClick={e => e.stopPropagation()}>
            <GitBranch size={13} /> <span style={{ fontSize: 11 }}>Auto</span>
          </button>
          <button title="Refresh" style={iconBtn} onClick={e => { e.stopPropagation(); refresh(); }}>
            <RefreshCw size={13} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <button title="More" style={iconBtn} onClick={e => e.stopPropagation()}>
            <MoreHorizontal size={13} />
          </button>
        </div>

        {graphOpen && (
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {fadeTop && (
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 24,
                background: 'linear-gradient(to bottom, var(--origin-bg-sidebar), transparent)',
                pointerEvents: 'none', zIndex: 2,
              }} />
            )}
            {fadeBot && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, height: 24,
                background: 'linear-gradient(to top, var(--origin-bg-sidebar), transparent)',
                pointerEvents: 'none', zIndex: 2,
              }} />
            )}
            <div ref={historyScrollRef} onScroll={updateFades} style={{ height: '100%', overflowY: 'auto' }}>
              {history.length === 0 ? (
                <p style={{ margin: 0, padding: '8px 12px', fontSize: 12, color: 'var(--origin-fg-subtle)' }}>
                  No commits yet
                </p>
              ) : (
                <div style={{ position: 'relative', padding: '4px 0' }}>
                  <div style={{
                    position: 'absolute', left: RAIL_L, top: 10, bottom: 10, width: 1,
                    background: 'var(--origin-border-default)', pointerEvents: 'none',
                  }} />
                  {history.map((c, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: `4px 8px 4px ${ROW_PL}px`,
                    }}>
                      <div style={{
                        flexShrink: 0, width: DOT_W, height: DOT_W,
                        borderRadius: '50%', marginTop: 4,
                        background: i === 0 ? 'transparent' : 'var(--origin-accent-blue)',
                        border: i === 0 ? '1px solid var(--origin-fg-default)' : 'none',
                        outline: '2px solid var(--origin-bg-sidebar)',
                        position: 'relative', zIndex: 1,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 12, color: 'var(--origin-fg-default)', lineHeight: 1.4,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {c.subject}
                          <span style={{ color: 'var(--origin-fg-subtle)', marginLeft: 8 }}>{c.author}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </div>{/* end bottom section */}

    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, borderRadius: 4, border: 'none',
  background: 'transparent', cursor: 'pointer',
  color: 'var(--origin-fg-muted)',
};

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '8px 10px', borderRadius: 6, border: 'none',
  background: 'transparent', cursor: 'pointer',
  fontSize: 13, color: 'var(--origin-fg-default)',
};
