import { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, GitBranch, Check, RefreshCw, MoreHorizontal, ChevronDown, ChevronRight, Plus, Minus, Undo2, CloudDownload } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from './ui/Toast';
import {
  getStatusFiles, getGitLogFull, gitCommit, gitCommitPush,
  gitStage, gitStageAll, gitUnstage, gitDiscard,
  gitPull, gitPush, gitFetch,
  gitListBranches, gitCheckout, gitCreateBranch,
  gitCommitAmend, gitCommitSync,
  notifyGitChanged,
  type StatusFile, type FullCommitEntry, type BranchEntry,
} from '../lib/git';
import { generateCommitMessage } from '../lib/gitCommitMessage';

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

/** Un fichier est "staged" si son index (1er caractère du porcelain) n'est ni
 *  vide ni '?' : X='M'/'A'/'D'/'R'/'C'/'U'. Les untracked sont `??`. */
function isStaged(raw: string): boolean {
  if (raw.length < 2) return false;
  const x = raw[0];
  return x !== ' ' && x !== '?';
}

/** Un fichier untracked (`??`) ne peut pas être unstage : il faut le discard. */
function isUntracked(raw: string): boolean {
  return raw.trim() === '??';
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
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [branches, setBranches]         = useState<BranchEntry[]>([]);
  const [moreOpen, setMoreOpen]         = useState(false);
  const { showToast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
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

  const load = useCallback(async (notify = false) => {
    if (!folderPath) return;
    const [f, h] = await Promise.all([
      getStatusFiles(folderPath),
      getGitLogFull(folderPath),
    ]);
    setFiles(f);
    setHistory(h);
    // Signale aux éditeurs ouverts de recharger leur référence HEAD (gutter).
    if (notify) notifyGitChanged();
    return { files: f, history: h };
  }, [folderPath]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() syncs external git state into React on mount/folder change
  useEffect(() => { load(); }, [load]);

  // Auto-refresh : recharge l'état git périodiquement tant qu'il est activé.
  useEffect(() => {
    if (!autoRefresh || !folderPath) return;
    const id = setInterval(() => { load(); }, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, folderPath, load]);

  async function refresh() {
    if (!folderPath || refreshing) return;
    setRefreshing(true);
    try {
      const result = await load(true);
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
    if (files.length === 0) {
      showToast('No changes to describe.', 'info');
      return;
    }
    setAiBusy(true);
    try {
      const msg = await generateCommitMessage(folderPath);
      if (!msg) {
        showToast('Configure an AI provider in Settings to use AI commit.', 'error');
        return;
      }
      setTitle(msg);
      showToast('Commit message generated.', 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to generate message.', 'error');
    } finally {
      setAiBusy(false);
    }
  }

  type CommitMode = 'commit' | 'amend' | 'push' | 'sync';

  async function commit(mode: CommitMode) {
    if (!folderPath || !title.trim() || busy) return;
    setBusy(true);
    try {
      const desc = '';
      if (mode === 'amend')      await gitCommitAmend(folderPath, title.trim(), desc);
      else if (mode === 'push')  await gitCommitPush(folderPath, title.trim(), desc);
      else if (mode === 'sync')  await gitCommitSync(folderPath, title.trim(), desc);
      else                       await gitCommit(folderPath, title.trim(), desc);
      setTitle('');
      const labels: Record<CommitMode, string> = {
        commit: 'Committed successfully.',
        amend:  'Commit amended.',
        push:   'Committed and pushed.',
        sync:   'Committed, synced and pushed.',
      };
      showToast(labels[mode], 'success');
      await load(true);
    } catch (e: unknown) {
      showToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Staging ────────────────────────────────────────────────────────────────
  async function stageFile(file: string) {
    if (!folderPath) return;
    try { await gitStage(folderPath, file); await load(true); }
    catch (e: unknown) { showToast(String(e), 'error'); }
  }
  async function unstageFile(file: string) {
    if (!folderPath) return;
    try { await gitUnstage(folderPath, file); await load(true); }
    catch (e: unknown) { showToast(String(e), 'error'); }
  }
  async function stageAllFiles() {
    if (!folderPath) return;
    try { await gitStageAll(folderPath); showToast('All changes staged.', 'success'); await load(true); }
    catch (e: unknown) { showToast(String(e), 'error'); }
  }
  async function unstageAllFiles() {
    if (!folderPath) return;
    const staged = files.filter(f => isStaged(f.status) && !isUntracked(f.status));
    if (staged.length === 0) { showToast('No staged changes.', 'info'); return; }
    try {
      for (const f of staged) await gitUnstage(folderPath, f.path);
      showToast('All changes unstaged.', 'success');
      await load(true);
    } catch (e: unknown) { showToast(String(e), 'error'); }
  }
  async function discardFile(file: string) {
    if (!folderPath) return;
    try { await gitDiscard(folderPath, file); showToast('Changes discarded.', 'success'); }
    catch (e: unknown) { showToast(String(e), 'error'); }
    setPendingDelete(null);
    await load(true);
  }

  // ── Remote ─────────────────────────────────────────────────────────────────
  async function runRemote(kind: 'pull' | 'push' | 'fetch', silent = false) {
    if (!folderPath || remoteBusy) return;
    setRemoteBusy(true);
    try {
      if (kind === 'pull')       await gitPull(folderPath);
      else if (kind === 'push')  await gitPush(folderPath);
      else                       await gitFetch(folderPath);
      if (!silent) showToast(`${kind.charAt(0).toUpperCase()}${kind.slice(1)} done.`, 'success');
      await load(true);
    } catch (e: unknown) {
      showToast(String(e), 'error');
    } finally {
      setRemoteBusy(false);
    }
  }

  // ── Branches ───────────────────────────────────────────────────────────────
  async function openBranches() {
    if (!folderPath) return;
    setBranches(await gitListBranches(folderPath));
    setBranchesOpen(true);
  }
  async function checkoutBranch(branch: string) {
    if (!folderPath) return;
    try { await gitCheckout(folderPath, branch); showToast(`Switched to ${branch}.`, 'success'); await load(true); }
    catch (e: unknown) { showToast(String(e), 'error'); }
  }
  async function createBranch() {
    if (!folderPath) return;
    const name = window.prompt('New branch name:');
    if (!name || !name.trim()) return;
    try { await gitCreateBranch(folderPath, name.trim()); showToast(`Created ${name.trim()}.`, 'success'); await load(true); }
    catch (e: unknown) { showToast(String(e), 'error'); }
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
          <button onClick={aiGenerateMessage} disabled={aiBusy} title="Generate commit message with AI" style={iconBtn}>
            <Sparkles size={14} style={{ color: aiBusy ? 'var(--origin-fg-subtle)' : '#34d399', animation: aiBusy ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <button onClick={() => runRemote('fetch')} disabled={remoteBusy} title="Fetch" style={iconBtn}>
            <CloudDownload size={14} style={{ animation: remoteBusy ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <div style={{ position: 'relative', display: 'flex' }}>
            <button onClick={() => branchesOpen ? setBranchesOpen(false) : openBranches()} title="Branches" style={iconBtn}>
              <GitBranch size={14} />
            </button>
            {branchesOpen && (
              <>
                <div onClick={() => setBranchesOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                <div style={{ ...dropdownStyle, minWidth: 220, maxHeight: 300, overflowY: 'auto' }}>
                  <button
                    onClick={() => { createBranch(); setBranchesOpen(false); }}
                    style={{ ...menuItemStyle, display: 'flex', alignItems: 'center', gap: 6 }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <Plus size={13} /> Create Branch…
                  </button>
                  <div style={{ height: 1, margin: '4px 6px', backgroundColor: 'var(--origin-border-default)' }} />
                  {branches.length === 0 ? (
                    <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--origin-fg-subtle)' }}>No branches</div>
                  ) : branches.map((b, i) => (
                    <button
                      key={i}
                      onClick={() => { checkoutBranch(b.name); setBranchesOpen(false); }}
                      style={{ ...menuItemStyle, display: 'flex', alignItems: 'center', gap: 6, color: b.current ? 'var(--origin-accent-blue)' : 'var(--origin-fg-default)' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <GitBranch size={13} style={{ opacity: b.remote ? 0.5 : 1 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                      {b.current && <Check size={13} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button onClick={stageAllFiles} title="Stage all changes" style={iconBtn}>
            <Check size={14} />
          </button>
          <button
            onClick={refresh}
            title="Refresh"
            style={iconBtn}
          >
            <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <div style={{ position: 'relative', display: 'flex' }}>
            <button onClick={() => setMoreOpen(o => !o)} title="More" style={iconBtn}>
              <MoreHorizontal size={14} />
            </button>
            {moreOpen && (
              <>
                <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                <div style={dropdownStyle}>
                  {[
                    { label: 'Pull',        action: () => runRemote('pull') },
                    { label: 'Push',        action: () => runRemote('push') },
                    { label: 'Fetch',       action: () => runRemote('fetch') },
                    { label: 'Unstage All', action: () => unstageAllFiles() },
                  ].map((o, i) => (
                    <button
                      key={i}
                      onClick={() => { o.action(); setMoreOpen(false); }}
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

        {changesOpen && (
          <>
            {/* Commit message input */}
            <div style={{ padding: '4px 8px' }}>
              <div style={{ position: 'relative' }}>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && canCommit && commit('commit')}
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
                  onClick={() => commit('commit')}
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
                    <div style={{ ...dropdownStyle, minWidth: 200 }}>
                      {([
                        { label: 'Commit',         mode: 'commit' as CommitMode },
                        { label: 'Commit (Amend)', mode: 'amend'  as CommitMode },
                      ]).map((o, i) => (
                        <button
                          key={i}
                          onClick={() => { commit(o.mode); setCommitMenuOpen(false); }}
                          style={menuItemStyle}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--origin-bg-hover)'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          {o.label}
                        </button>
                      ))}
                      <div style={{ height: 1, margin: '4px 6px', backgroundColor: 'var(--origin-border-default)' }} />
                      {([
                        { label: 'Commit & Push', mode: 'push' as CommitMode },
                        { label: 'Commit & Sync', mode: 'sync' as CommitMode },
                      ]).map((o, i) => (
                        <button
                          key={i}
                          onClick={() => { commit(o.mode); setCommitMenuOpen(false); }}
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
                files.map((f, i) => {
                  const staged = isStaged(f.status);
                  const untracked = isUntracked(f.status);
                  const confirming = pendingDelete === f.path;
                  return (
                  <div
                    key={i}
                    className="origin-scm-row"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px 3px 32px' }}
                  >
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                      color: statusColor(f.status), flexShrink: 0, width: 12, textAlign: 'center',
                    }}>
                      {statusLabel(f.status)}
                    </span>
                    <span style={{
                      fontSize: 12, color: 'var(--origin-fg-default)', flex: 1, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {shortPath(f.path)}
                    </span>
                    {confirming ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: 'var(--origin-fg-subtle)' }}>Discard?</span>
                        <button onClick={() => discardFile(f.path)} title="Confirm discard" style={rowBtn}>
                          <Check size={13} style={{ color: 'var(--origin-semantic-error)' }} />
                        </button>
                        <button onClick={() => setPendingDelete(null)} title="Cancel" style={rowBtn}>
                          <Minus size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="origin-scm-actions" style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                        {staged || untracked ? (
                          <button onClick={() => unstageFile(f.path)} title="Unstage" style={rowBtn}>
                            <Minus size={13} />
                          </button>
                        ) : (
                          <button onClick={() => stageFile(f.path)} title="Stage" style={rowBtn}>
                            <Plus size={13} />
                          </button>
                        )}
                        <button onClick={() => setPendingDelete(f.path)} title="Discard changes" style={rowBtn}>
                          <Undo2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  );
                })
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
          <button
            title="Auto-refresh every 5s"
            style={{ ...iconBtn, gap: 4, padding: '0 6px', color: autoRefresh ? 'var(--origin-accent-blue)' : 'var(--origin-fg-muted)' }}
            onClick={e => { e.stopPropagation(); setAutoRefresh(a => !a); }}
          >
            <GitBranch size={13} /> <span style={{ fontSize: 11 }}>Auto</span>
          </button>
          <button title="Refresh" style={iconBtn} onClick={e => { e.stopPropagation(); refresh(); }}>
            <RefreshCw size={13} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
          </button>
          <button title="More" style={iconBtn} onClick={e => { e.stopPropagation(); setMoreOpen(o => !o); }}>
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

const rowBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: 4, border: 'none',
  background: 'transparent', cursor: 'pointer',
  color: 'var(--origin-fg-muted)',
};

const dropdownStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', right: 0, zIndex: 60,
  marginTop: 4, minWidth: 180, padding: 6,
  backgroundColor: 'var(--origin-bg-panel)',
  border: '1px solid var(--origin-border-default)',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
};

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '8px 10px', borderRadius: 6, border: 'none',
  background: 'transparent', cursor: 'pointer',
  fontSize: 13, color: 'var(--origin-fg-default)',
};
