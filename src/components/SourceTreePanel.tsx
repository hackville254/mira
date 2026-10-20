import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles, GitBranch, GitCommitHorizontal, Check, RefreshCw, MoreHorizontal,
  ChevronDown, ChevronRight, Plus, Minus, Undo2, CloudDownload, CloudUpload,
  Download, Archive, X,
} from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from './ui/Toast';
import { formatShortcut } from '../lib/platform';
import DropdownMenu, { type MenuEntry } from './ui/DropdownMenu';
import {
  getStatusFiles, getGitLogFull, gitCommit, gitCommitPush,
  gitStage, gitStageAll, gitUnstage, gitDiscard,
  gitPull, gitPush, gitFetch,
  gitListBranches, gitCheckout, gitCreateBranch,
  gitCommitAmend, gitCommitSync,
  gitStashSave, gitStashList, gitStashPop, gitStashApply, gitStashDrop,
  notifyGitChanged,
  type StatusFile, type FullCommitEntry, type BranchEntry, type StashEntry,
} from '../lib/git';
import { generateCommitMessage } from '../lib/gitCommitMessage';
import { openGitDiff } from '../lib/gitDiffBus';
import FileIcon from './FileIcon';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extrait un message exploitable d'une erreur remontée par Tauri.
 *
 * Les commandes Rust renvoient `Result<_, String>` : en cas d'échec, la promesse
 * `invoke` est rejetée avec une **chaîne**, pas une `Error`. Les anciens appels
 * `String(e)` affichaient « [object Object] » pour une erreur structurée, et le
 * motif `e instanceof Error ? e.message : '...'` masquait le vrai message derrière
 * un fallback générique — l'utilisateur ne pouvait jamais savoir ce qui avait
 * échoué. On normalise donc ici les trois formes possibles : `Error`, chaîne,
 * objet sérialisé.
 */
function errMsg(e: unknown, fallback = 'Operation failed.'): string {
  if (typeof e === 'string' && e.trim()) return e.trim();
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim();
    try {
      const s = JSON.stringify(e);
      if (s && s !== '{}') return s;
    } catch { /* objet circulaire : on retombe sur le fallback */ }
  }
  return fallback;
}

/** Couleur du marqueur de statut (M/A/D/R/U) selon le code porcelain. */
function statusColor(raw: string): string {
  const s = raw.replace(/\s/g, '');
  if (s === '??' || s === 'U') return 'var(--origin-git-untracked)';
  if (s[0] === 'A') return 'var(--origin-git-added)';
  if (s[0] === 'M' || s[1] === 'M') return 'var(--origin-git-modified)';
  if (s[0] === 'D' || s[1] === 'D') return 'var(--origin-git-deleted)';
  if (s[0] === 'R') return 'var(--origin-accent-blue)';
  return 'var(--origin-fg-muted)';
}

/** Lettre affichée pour un code porcelain donné. */
function statusLabel(raw: string): string {
  if (raw === '??') return 'U';
  const s = raw.replace(/\s/g, '');
  return s[0] ?? '?';
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

/** Nom de fichier seul (dernier segment de chemin). */
function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const ROW_PL = 10;
const DOT_W  = 8;
const RAIL_L = ROW_PL + DOT_W / 2;

export default function SourceTreePanel() {
  const { folderPath } = useWorkspace();
  const { showToast } = useToast();

  const [files, setFiles]       = useState<StatusFile[]>([]);
  const [history, setHistory]   = useState<FullCommitEntry[]>([]);
  const [stashes, setStashes]   = useState<StashEntry[]>([]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);

  const [title, setTitle]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState<'pull' | 'push' | 'fetch' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [changesOpen, setChangesOpen]   = useState(true);
  const [stagedOpen, setStagedOpen]     = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [graphOpen, setGraphOpen]       = useState(true);
  const [stashesOpen, setStashesOpen]   = useState(false);
  const [autoRefresh, setAutoRefresh]   = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null);

  // Ancre du menu déroulant « More » et du menu de commit, positionnées par le
  // composant `DropdownMenu` (portal) pour ne jamais déborder de l'écran.
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [commitAnchor, setCommitAnchor] = useState<HTMLElement | null>(null);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);

  // Dialogue de saisie inline (remplacement de `window.prompt`, indisponible /
  // moche dans une webview et bloquant pour le fil de rendu).
  const [input, setInput] = useState<
    | { kind: 'branch' }
    | { kind: 'stash' }
    | null
  >(null);
  const [inputValue, setInputValue] = useState('');

  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBot, setFadeBot] = useState(false);

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

  // ── Chargement de l'état git ────────────────────────────────────────────────
  const load = useCallback(async (notify = false) => {
    if (!folderPath) return { files: [] as StatusFile[], history: [] as FullCommitEntry[] };
    const [f, h, s] = await Promise.all([
      getStatusFiles(folderPath),
      getGitLogFull(folderPath),
      gitStashList(folderPath),
    ]);
    setFiles(f);
    setHistory(h);
    setStashes(s);
    // Signale aux éditeurs ouverts de recharger leur référence HEAD (gutter).
    if (notify) notifyGitChanged();
    return { files: f, history: h };
  }, [folderPath]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() syncs external git state into React on mount/folder change
  useEffect(() => { void load(); }, [load]);

  // Auto-refresh : recharge l'état git périodiquement tant qu'il est activé.
  useEffect(() => {
    if (!autoRefresh || !folderPath) return;
    const id = setInterval(() => { void load(); }, 5000);
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
    } catch (e: unknown) {
      showToast(errMsg(e, 'Failed to refresh.'), 'error');
    } finally {
      setRefreshing(false);
    }
  }

  // ── Génération du message de commit par IA ──────────────────────────────────
  async function aiGenerateMessage() {
    if (!folderPath || aiBusy) return;
    setAiBusy(true);
    try {
      // On rafraîchit l'état affiché, mais on ne s'en sert PAS pour décider s'il
      // y a des changements : `getStatusFiles` retombe sur `[]` en cas d'erreur
      // IPC, ce qui produirait un « No changes to describe » trompeur alors que
      // le diff (calculé côté Rust sur le dépôt réel) contient bien des
      // modifications. L'autorité sur « y a-t-il des changements » est le diff.
      await load();
      const result = await generateCommitMessage(folderPath);
      if (!result.ok) {
        // Message PRÉCIS par cause : l'utilisateur sait s'il doit committer des
        // changements ou reconfigurer son modèle, au lieu d'un message ambigu.
        if (result.reason === 'no-provider') {
          showToast(
            result.detail
              ? `No usable AI model: ${result.detail}. Pick a model in Settings → Connect AI.`
              : 'No AI provider configured. Add an API key in Settings → Connect AI, or pick a local model.',
            'error',
          );
        } else if (result.reason === 'git-unavailable') {
          showToast('Git could not be found. Install Git (or add it to your shell PATH), then restart Mira.', 'error');
        } else if (result.reason === 'not-a-repo') {
          showToast('This folder is not a git repository. Initialize git first (git init) to describe changes.', 'error');
        } else if (result.reason === 'empty-input') {
          showToast('No changes to describe.', 'info');
        } else {
          showToast(result.detail ? `AI call failed: ${result.detail}` : 'AI call failed.', 'error');
        }
        return;
      }
      setTitle(result.text);
      showToast('Commit message generated.', 'success');
    } catch (e: unknown) {
      showToast(errMsg(e, 'Failed to generate message.'), 'error');
    } finally {
      setAiBusy(false);
    }
  }

  // ── Commit ──────────────────────────────────────────────────────────────────
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
      showToast(errMsg(e, 'Commit failed.'), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Staging ────────────────────────────────────────────────────────────────
  async function stageFile(file: string) {
    if (!folderPath) return;
    try { await gitStage(folderPath, file); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Stage failed.'), 'error'); }
  }

  async function unstageFile(file: string) {
    if (!folderPath) return;
    try { await gitUnstage(folderPath, file); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Unstage failed.'), 'error'); }
  }

  async function stageAllFiles() {
    if (!folderPath) return;
    try { await gitStageAll(folderPath); showToast('All changes staged.', 'success'); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Stage all failed.'), 'error'); }
  }

  async function unstageAllFiles() {
    if (!folderPath) return;
    const staged = files.filter(f => isStaged(f.status) && !isUntracked(f.status));
    if (staged.length === 0) { showToast('No staged changes.', 'info'); return; }
    try {
      for (const f of staged) await gitUnstage(folderPath, f.path);
      showToast('All changes unstaged.', 'success');
      await load(true);
    } catch (e: unknown) { showToast(errMsg(e, 'Unstage all failed.'), 'error'); }
  }

  async function discardFile(file: string) {
    if (!folderPath) return;
    try { await gitDiscard(folderPath, file); showToast('Changes discarded.', 'success'); }
    catch (e: unknown) { showToast(errMsg(e, 'Discard failed.'), 'error'); }
    setPendingDiscard(null);
    await load(true);
  }

  // ── Remote ─────────────────────────────────────────────────────────────────
  async function runRemote(kind: 'pull' | 'push' | 'fetch') {
    if (!folderPath || remoteBusy) return;
    setRemoteBusy(kind);
    try {
      if (kind === 'pull')       await gitPull(folderPath);
      else if (kind === 'push')  await gitPush(folderPath);
      else                       await gitFetch(folderPath);
      showToast(`${kind.charAt(0).toUpperCase()}${kind.slice(1)} done.`, 'success');
      await load(true);
    } catch (e: unknown) {
      showToast(errMsg(e, `${kind} failed.`), 'error');
    } finally {
      setRemoteBusy(null);
    }
  }

  // ── Branches ───────────────────────────────────────────────────────────────
  async function openBranches() {
    if (!folderPath) return;
    try { setBranches(await gitListBranches(folderPath)); }
    catch (e: unknown) { showToast(errMsg(e, 'Could not list branches.'), 'error'); setBranches([]); }
  }

  async function checkoutBranch(branch: string) {
    if (!folderPath) return;
    try { await gitCheckout(folderPath, branch); showToast(`Switched to ${branch}.`, 'success'); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Checkout failed.'), 'error'); }
  }

  // ── Saisie inline (branche / stash) ────────────────────────────────────────
  function openInput(kind: 'branch' | 'stash') {
    setInputValue('');
    setInput({ kind });
  }

  async function submitInput() {
    if (!folderPath || !input) return;
    const value = inputValue.trim();
    const kind = input.kind;
    setInput(null);
    if (kind === 'branch') {
      if (!value) return;
      try { await gitCreateBranch(folderPath, value); showToast(`Created ${value}.`, 'success'); await load(true); }
      catch (e: unknown) { showToast(errMsg(e, 'Create branch failed.'), 'error'); }
    } else {
      if (files.length === 0) { showToast('No changes to stash.', 'info'); return; }
      try {
        await gitStashSave(folderPath, value || undefined, true);
        showToast('Changes stashed.', 'success');
        await load(true);
      } catch (e: unknown) { showToast(errMsg(e, 'Stash failed.'), 'error'); }
    }
  }

  async function popStash(index: number) {
    if (!folderPath) return;
    try { await gitStashPop(folderPath, index); showToast('Stash popped.', 'success'); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Pop stash failed.'), 'error'); }
  }

  async function applyStash(index: number) {
    if (!folderPath) return;
    try { await gitStashApply(folderPath, index); showToast('Stash applied.', 'success'); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Apply stash failed.'), 'error'); }
  }

  async function dropStash(index: number) {
    if (!folderPath) return;
    const s = stashes.find(x => x.index === index);
    if (!window.confirm(`Drop stash "${s?.message ?? `#${index}`}"? This cannot be undone.`)) return;
    try { await gitStashDrop(folderPath, index); showToast('Stash dropped.', 'success'); await load(true); }
    catch (e: unknown) { showToast(errMsg(e, 'Drop stash failed.'), 'error'); }
  }

  // ── Dérivés ────────────────────────────────────────────────────────────────
  const stagedFiles   = files.filter(f => isStaged(f.status) && !isUntracked(f.status));
  const unstagedFiles = files.filter(f => !isStaged(f.status) || isUntracked(f.status));

  if (!folderPath) {
    return (
      <div style={centerBox}>
        <GitBranch size={22} style={{ color: 'var(--origin-fg-subtle)', marginBottom: 8 }} />
        <p style={{ margin: 0, fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center', lineHeight: 1.5 }}>
          Open a folder to use source control
        </p>
      </div>
    );
  }

  const canCommit = title.trim().length > 0 && !busy;
  const currentBranch = branches.find(b => b.current)?.name;

  const moreEntries: MenuEntry[] = [
    { type: 'item', label: 'Pull',           onClick: () => void runRemote('pull') },
    { type: 'item', label: 'Push',           onClick: () => void runRemote('push') },
    { type: 'item', label: 'Fetch',          onClick: () => void runRemote('fetch') },
    { type: 'separator' },
    { type: 'item', label: 'Stash Changes…', onClick: () => openInput('stash') },
    { type: 'item', label: 'Unstage All',    onClick: () => void unstageAllFiles() },
  ];

  const commitEntries: MenuEntry[] = [
    { type: 'item', label: 'Commit',         shortcut: formatShortcut('ctrl+enter'), onClick: () => void commit('commit') },
    { type: 'item', label: 'Commit (Amend)', onClick: () => void commit('amend') },
    { type: 'separator' },
    { type: 'item', label: 'Commit & Push',  onClick: () => void commit('push') },
    { type: 'item', label: 'Commit & Sync',  onClick: () => void commit('sync') },
  ];

  const branchEntries: MenuEntry[] = [
    { type: 'item', label: 'Create Branch…', onClick: () => openInput('branch') },
    { type: 'separator' },
    ...(branches.length === 0
      ? [{ type: 'item' as const, label: 'No branches', disabled: true }]
      : branches.map<MenuEntry>(b => ({
          type: 'item',
          label: b.current ? `${b.name}  ✓` : b.name,
          onClick: () => void checkoutBranch(b.name),
        }))),
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, position: 'relative' }}>

      {/* ── En-tête : marqueur git + actions globales ────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px 4px',
        borderBottom: '1px solid var(--origin-border-default)',
      }}>
        <button onClick={() => setChangesOpen(o => !o)} style={iconBtn} title={changesOpen ? 'Collapse' : 'Expand'}>
          {changesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--origin-fg-default)', flex: 1 }}>
          Source Control
          {files.length > 0 && (
            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--origin-fg-subtle)' }}>{files.length}</span>
          )}
        </span>
        <button onClick={aiGenerateMessage} disabled={aiBusy} title="Generate commit message with AI" style={iconBtn}>
          <Sparkles size={14} style={{ color: aiBusy ? 'var(--origin-fg-subtle)' : 'var(--origin-accent-green)', animation: aiBusy ? 'spin 0.7s linear infinite' : 'none' }} />
        </button>
        <button onClick={() => void runRemote('fetch')} disabled={!!remoteBusy} title="Fetch" style={iconBtn}>
          <CloudDownload size={14} style={{ animation: remoteBusy === 'fetch' ? 'spin 0.7s linear infinite' : 'none' }} />
        </button>
        <button
          onClick={e => setBranchAnchor(branchAnchor ? null : e.currentTarget)}
          title={currentBranch ? `Branch: ${currentBranch}` : 'Branches'}
          style={iconBtn}
        >
          <GitBranch size={14} />
        </button>
        <button onClick={stageAllFiles} title="Stage all changes" style={iconBtn}>
          <Plus size={14} />
        </button>
        <button onClick={refresh} title="Refresh" style={iconBtn}>
          <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
        </button>
        <button onClick={e => setMoreAnchor(moreAnchor ? null : e.currentTarget)} title="More" style={iconBtn}>
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* ── Corps scrollable ─────────────────────────────────────────────── */}
      {changesOpen && (
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 }}>

          {/* Zone de commit */}
          <div style={{ padding: '8px 8px 6px' }}>
            <div style={{ position: 'relative' }}>
              <textarea
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && canCommit) {
                    e.preventDefault();
                    void commit('commit');
                  }
                }}
                rows={2}
                placeholder={`Message (${formatShortcut('ctrl+enter')} to commit)`}
                style={{
                  width: '100%', boxSizing: 'border-box', resize: 'vertical',
                  minHeight: 46, maxHeight: 140,
                  background: 'var(--origin-bg-input)',
                  border: '1px solid var(--origin-border-default)',
                  borderRadius: 6, padding: '7px 30px 7px 10px',
                  fontSize: 12, color: 'var(--origin-fg-default)',
                  fontFamily: 'var(--font-sans)', outline: 'none', lineHeight: 1.4,
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--origin-accent-blue)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--origin-border-default)'; }}
              />
              <button
                onClick={aiGenerateMessage}
                disabled={aiBusy}
                title="Generate commit message with AI"
                style={{ ...rowBtn, position: 'absolute', right: 4, top: 4 }}
              >
                <Sparkles size={13} style={{ color: aiBusy ? 'var(--origin-fg-subtle)' : 'var(--origin-accent-green)', animation: aiBusy ? 'spin 0.7s linear infinite' : 'none' }} />
              </button>
            </div>

            {/* Bouton Commit + menu déroulant */}
            <div style={{ display: 'flex', marginTop: 6 }}>
              <button
                onClick={() => void commit('commit')}
                disabled={!canCommit}
                style={{
                  ...commitBtnStyle, flex: 1, borderRadius: '6px 0 0 6px',
                  background: canCommit ? 'var(--origin-accent-blue)' : 'var(--origin-bg-hover)',
                  color: canCommit ? '#fff' : 'var(--origin-fg-subtle)',
                  cursor: canCommit ? 'pointer' : 'not-allowed',
                }}
              >
                <Check size={13} />
                {busy ? 'Committing…' : 'Commit'}
              </button>
              <button
                onClick={e => setCommitAnchor(commitAnchor ? null : e.currentTarget)}
                disabled={!canCommit}
                title="More commit options"
                style={{
                  ...commitBtnStyle, width: 30, borderRadius: '0 6px 6px 0',
                  background: canCommit ? 'var(--origin-accent-blue)' : 'var(--origin-bg-hover)',
                  color: canCommit ? '#fff' : 'var(--origin-fg-subtle)',
                  cursor: canCommit ? 'pointer' : 'not-allowed',
                  borderLeft: '1px solid rgba(255,255,255,0.15)',
                }}
              >
                <ChevronDown size={13} />
              </button>
            </div>
          </div>

          {/* Liste des changements, groupée Staged / Changes (parité Trae) */}
          <div style={{ borderTop: '1px solid var(--origin-border-default)' }}>
            {files.length === 0 ? (
              <div style={emptyBox}>
                <Check size={16} style={{ color: 'var(--origin-accent-green)', marginBottom: 6 }} />
                <span style={{ fontSize: 12, color: 'var(--origin-fg-subtle)' }}>No changes detected</span>
              </div>
            ) : (
              <>
                <FileGroup
                  title="Staged"
                  files={stagedFiles}
                  open={stagedOpen}
                  onToggle={() => setStagedOpen(o => !o)}
                  folderPath={folderPath}
                  mode="staged"
                  pendingDiscard={pendingDiscard}
                  onStage={stageFile}
                  onUnstage={unstageFile}
                  onRequestDiscard={setPendingDiscard}
                  onDiscard={discardFile}
                />
                <FileGroup
                  title="Changes"
                  files={unstagedFiles}
                  open={unstagedOpen}
                  onToggle={() => setUnstagedOpen(o => !o)}
                  folderPath={folderPath}
                  mode="unstaged"
                  pendingDiscard={pendingDiscard}
                  onStage={stageFile}
                  onUnstage={unstageFile}
                  onRequestDiscard={setPendingDiscard}
                  onDiscard={discardFile}
                />
              </>
            )}
          </div>

          {/* Stashes */}
          <div style={{ borderTop: '1px solid var(--origin-border-default)' }}>
            <SectionHeader
              icon={<Archive size={13} />}
              title="Stashes"
              count={stashes.length}
              open={stashesOpen}
              onToggle={() => setStashesOpen(o => !o)}
              action={
                <button
                  title="Stash changes"
                  style={iconBtn}
                  onClick={e => { e.stopPropagation(); openInput('stash'); }}
                >
                  <Plus size={13} />
                </button>
              }
            />
            {stashesOpen && (
              <div style={{ paddingBottom: 4 }}>
                {stashes.length === 0 ? (
                  <p style={emptyLine}>No stashes</p>
                ) : stashes.map(s => (
                  <div key={s.index} className="origin-scm-row" style={stashRowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={ellipsisText}>{s.message || `stash@{${s.index}}`}</div>
                      <div style={{ ...ellipsisText, fontSize: 10, color: 'var(--origin-fg-subtle)' }}>
                        {`stash@{${s.index}} · ${s.branch}`}
                      </div>
                    </div>
                    <div className="origin-scm-actions" style={{ display: 'flex', gap: 2 }}>
                      <button title="Apply stash (keep in list)" style={rowBtn} onClick={() => void applyStash(s.index)}>
                        <CloudDownload size={13} />
                      </button>
                      <button title="Pop stash (apply + remove)" style={rowBtn} onClick={() => void popStash(s.index)}>
                        <Undo2 size={13} />
                      </button>
                      <button title="Drop stash" style={rowBtn} onClick={() => void dropStash(s.index)}>
                        <Minus size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Graph / Historique */}
          <div style={{ borderTop: '1px solid var(--origin-border-default)', flex: '0 0 auto' }}>
            <SectionHeader
              icon={<GitCommitHorizontal size={13} />}
              title="Graph"
              count={history.length}
              open={graphOpen}
              onToggle={() => setGraphOpen(o => !o)}
              action={
                <>
                  <button
                    title="Auto-refresh every 5s"
                    style={{ ...iconBtn, width: 'auto', gap: 4, padding: '0 6px', color: autoRefresh ? 'var(--origin-accent-blue)' : 'var(--origin-fg-muted)' }}
                    onClick={e => { e.stopPropagation(); setAutoRefresh(a => !a); }}
                  >
                    <span style={{ fontSize: 11 }}>Auto</span>
                  </button>
                  <button title="Refresh" style={iconBtn} onClick={e => { e.stopPropagation(); void refresh(); }}>
                    <RefreshCw size={13} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
                  </button>
                </>
              }
            />
            {graphOpen && (
              <div style={{ position: 'relative', minHeight: 0 }}>
                {fadeTop && <div style={fadeStyle('top')} />}
                {fadeBot && <div style={fadeStyle('bottom')} />}
                <div ref={historyScrollRef} onScroll={updateFades} style={{ overflowY: 'auto', maxHeight: 300 }}>
                  {history.length === 0 ? (
                    <p style={emptyLine}>No commits yet</p>
                  ) : (
                    <div style={{ position: 'relative', padding: '4px 0' }}>
                      <div style={{
                        position: 'absolute', left: RAIL_L, top: 10, bottom: 10, width: 1,
                        background: 'var(--origin-border-default)', pointerEvents: 'none',
                      }} />
                      {history.map((c, i) => (
                        <div key={c.hash} title={`${c.hash} · ${c.author} · ${c.date}`} style={{
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
                            <div style={ellipsisText}>{c.subject}</div>
                            <div style={{ display: 'flex', gap: 6, fontSize: 10, color: 'var(--origin-fg-subtle)', minWidth: 0 }}>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{c.hash}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author}</span>
                              <span style={{ flexShrink: 0 }}>{c.date}</span>
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
        </div>
      )}

      {/* ── Menus (portal) ────────────────────────────────────────────────── */}
      {moreAnchor && (
        <DropdownMenu entries={moreEntries} anchorEl={moreAnchor} onClose={() => setMoreAnchor(null)} />
      )}
      {commitAnchor && (
        <DropdownMenu entries={commitEntries} anchorEl={commitAnchor} onClose={() => setCommitAnchor(null)} />
      )}
      {branchAnchor && (
        <DropdownMenu
          entries={branchEntries}
          anchorEl={branchAnchor}
          onClose={() => { setBranchAnchor(null); }}
        />
      )}

      {/* ── Dialogue de saisie inline (branche / stash) ───────────────────── */}
      {input && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setInput(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)', padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 360,
              background: 'var(--origin-bg-base)',
              border: '1px solid var(--origin-border-default)',
              borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
              overflow: 'hidden', fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--origin-border-default)' }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--origin-fg-default)' }}>
                {input.kind === 'branch' ? 'Create branch' : 'Stash changes'}
              </span>
              <button onClick={() => setInput(null)} style={rowBtn} title="Close"><X size={14} /></button>
            </div>
            <div style={{ padding: '12px 14px' }}>
              <input
                autoFocus
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); void submitInput(); }
                  if (e.key === 'Escape') setInput(null);
                }}
                placeholder={input.kind === 'branch' ? 'New branch name' : 'Stash message (optional)'}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'var(--origin-bg-input)',
                  border: '1px solid var(--origin-border-default)',
                  borderRadius: 6, padding: '7px 10px',
                  fontSize: 12, color: 'var(--origin-fg-default)',
                  fontFamily: 'var(--font-sans)', outline: 'none',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--origin-accent-blue)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--origin-border-default)'; }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--origin-border-default)', background: 'var(--origin-bg-editor)' }}>
              <button onClick={() => setInput(null)} style={dialogBtn}>Cancel</button>
              <button
                onClick={() => void submitInput()}
                disabled={input.kind === 'branch' && !inputValue.trim()}
                style={{
                  ...dialogBtn,
                  background: 'var(--origin-accent-blue)', color: '#fff', border: '1px solid var(--origin-accent-blue)',
                  fontWeight: 500,
                  opacity: input.kind === 'branch' && !inputValue.trim() ? 0.5 : 1,
                }}
              >
                {input.kind === 'branch' ? 'Create' : 'Stash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sous-composants ───────────────────────────────────────────────────────────

/** En-tête de section repliable, avec compteur et actions optionnelles. */
function SectionHeader({
  icon, title, count, open, onToggle, action,
}: {
  icon?: React.ReactNode;
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div
      onClick={onToggle}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 4px', cursor: 'pointer' }}
    >
      <span style={{ display: 'flex', color: 'var(--origin-fg-muted)' }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </span>
      {icon && <span style={{ display: 'flex', color: 'var(--origin-fg-muted)' }}>{icon}</span>}
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--origin-fg-default)' }}>{title}</span>
      {count !== undefined && count > 0 && (
        <span style={{ fontSize: 10, color: 'var(--origin-fg-subtle)' }}>{count}</span>
      )}
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );
}

/** Groupe de fichiers (Staged ou Changes) repliable. */
function FileGroup({
  title, files, open, onToggle, folderPath, mode,
  pendingDiscard, onStage, onUnstage, onRequestDiscard, onDiscard,
}: {
  title: string;
  files: StatusFile[];
  open: boolean;
  onToggle: () => void;
  folderPath: string;
  mode: 'staged' | 'unstaged';
  pendingDiscard: string | null;
  onStage: (f: string) => void;
  onUnstage: (f: string) => void;
  onRequestDiscard: (f: string | null) => void;
  onDiscard: (f: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <SectionHeader title={title} count={files.length} open={open} onToggle={onToggle} />
      {open && files.map(f => (
        <FileRow
          key={`${mode}:${f.path}`}
          file={f}
          folderPath={folderPath}
          staged={mode === 'staged'}
          confirming={pendingDiscard === f.path}
          onStage={onStage}
          onUnstage={onUnstage}
          onRequestDiscard={onRequestDiscard}
          onDiscard={onDiscard}
        />
      ))}
    </div>
  );
}

/** Une ligne de fichier modifié : clic = diff, survol = actions. */
function FileRow({
  file, folderPath, staged, confirming,
  onStage, onUnstage, onRequestDiscard, onDiscard,
}: {
  file: StatusFile;
  folderPath: string;
  staged: boolean;
  confirming: boolean;
  onStage: (f: string) => void;
  onUnstage: (f: string) => void;
  onRequestDiscard: (f: string | null) => void;
  onDiscard: (f: string) => void;
}) {
  const untracked = isUntracked(file.status);
  // Chemin absolu : `git_status_files` renvoie un chemin relatif au dépôt (avec
  // `/`), il faut le recomposer pour ouvrir l'onglet diff.
  const absPath = file.path.startsWith('/')
    ? file.path
    : `${folderPath.replace(/[/\\]+$/, '')}/${file.path}`;

  return (
    <div
      className="origin-scm-row"
      onClick={() => openGitDiff({ filePath: absPath, repoPath: folderPath })}
      title={`Open changes of ${file.path}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 22px', cursor: 'pointer' }}
    >
      <FileIcon name={baseName(file.path)} size={13} />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
        color: statusColor(file.status), flexShrink: 0, width: 12, textAlign: 'center',
      }}>
        {statusLabel(file.status)}
      </span>
      <span style={{ ...ellipsisText, fontSize: 12, color: 'var(--origin-fg-default)', flex: 1, minWidth: 0 }}>
        {file.path}
      </span>
      {confirming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--origin-fg-subtle)' }}>Discard?</span>
          <button onClick={e => { e.stopPropagation(); onDiscard(file.path); }} title="Confirm discard" style={rowBtn}>
            <Check size={13} style={{ color: 'var(--origin-semantic-error)' }} />
          </button>
          <button onClick={e => { e.stopPropagation(); onRequestDiscard(null); }} title="Cancel" style={rowBtn}>
            <Minus size={13} />
          </button>
        </div>
      ) : (
        <div className="origin-scm-actions" style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {staged || untracked ? (
            <button onClick={e => { e.stopPropagation(); onUnstage(file.path); }} title="Unstage" style={rowBtn}>
              <Minus size={13} />
            </button>
          ) : (
            <button onClick={e => { e.stopPropagation(); onStage(file.path); }} title="Stage" style={rowBtn}>
              <Plus size={13} />
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); onRequestDiscard(file.path); }} title="Discard changes" style={rowBtn}>
            <Undo2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Styles partagés ───────────────────────────────────────────────────────────

const centerBox: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', padding: 20,
};

const emptyBox: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '18px 12px',
};

const emptyLine: React.CSSProperties = {
  margin: 0, padding: '4px 12px 8px', fontSize: 12, color: 'var(--origin-fg-subtle)',
};

const stashRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 20px',
};

const ellipsisText: React.CSSProperties = {
  fontSize: 12, color: 'var(--origin-fg-default)', lineHeight: 1.4,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const commitBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '7px 0', border: 'none',
  fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)',
};

const dialogBtn: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, fontSize: 12,
  cursor: 'pointer', border: '1px solid var(--origin-border-default)',
  background: 'transparent', color: 'var(--origin-fg-default)',
};

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

/** Dégradé de fondu en haut/bas de la liste d'historique. */
function fadeStyle(edge: 'top' | 'bottom'): React.CSSProperties {
  return {
    position: 'absolute', left: 0, right: 0,
    [edge]: 0, height: 24,
    background: `linear-gradient(to ${edge === 'top' ? 'bottom' : 'top'}, var(--origin-bg-sidebar), transparent)`,
    pointerEvents: 'none', zIndex: 2,
  };
}
