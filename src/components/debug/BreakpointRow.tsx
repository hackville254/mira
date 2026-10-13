import { useState } from 'react';
import { Icon } from '@iconify/react';
import type { BreakpointEntry } from '../../context/DebugContext';

interface Props {
  filePath: string;
  entry: BreakpointEntry;
  onOpen: () => void;
  onRemove: () => void;
  onCondition: (v: string) => void;
  onHitCondition: (v: string) => void;
  onLogMessage: (v: string) => void;
}

/**
 * Ligne d'un breakpoint dans le panneau Debug. Le bouton « crayon » déplie un
 * éditeur inline pour la condition d'arrêt, le hit count et le log point —
 * équivalent des options VS Code, poussées à l'adaptateur via `setBreakpoints`.
 */
export default function BreakpointRow({
  filePath, entry, onOpen, onRemove, onCondition, onHitCondition, onLogMessage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState(entry.condition ?? '');
  const [hitCondition, setHitCondition] = useState(entry.hitCondition ?? '');
  const [logMessage, setLogMessage] = useState(entry.logMessage ?? '');

  const isLog = !!(entry.logMessage && entry.logMessage.trim());
  const isCond = !!((entry.condition && entry.condition.trim()) || (entry.hitCondition && entry.hitCondition.trim()));

  const fieldStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'var(--origin-bg-input)',
    border: '1px solid var(--origin-border-default)',
    borderRadius: 4, outline: 'none', padding: '2px 5px',
    color: 'var(--origin-fg-default)', fontFamily: 'var(--font-mono)', fontSize: 10,
  };

  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 16px', fontSize: 11 }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          border: entry.verified ? 'none' : '1.5px solid var(--origin-semantic-error)',
          backgroundColor: entry.verified ? 'var(--origin-semantic-error)' : 'transparent',
        }} />
        <span style={{ flex: 1, cursor: 'pointer', color: 'var(--origin-fg-default)' }} onClick={onOpen}>
          Ln {entry.line}
        </span>
        {isLog && <span title="Log point" style={{ display: 'flex', flexShrink: 0, color: 'var(--origin-accent-yellow)' }}><Icon icon="lucide:message-square-text" width={11} /></span>}
        {isCond && !isLog && <span title="Conditional" style={{ display: 'flex', flexShrink: 0, color: 'var(--origin-accent-yellow)' }}><Icon icon="lucide:filter" width={11} /></span>}
        <button
          onClick={() => setOpen(o => !o)}
          title="Edit breakpoint"
          style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--origin-fg-subtle)', display: 'flex', flexShrink: 0 }}
        >
          <Icon icon="lucide:pencil" width={10} />
        </button>
        <button
          onClick={onRemove}
          title="Remove breakpoint"
          style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--origin-fg-subtle)', display: 'flex', flexShrink: 0 }}
        >
          <Icon icon="lucide:x" width={10} />
        </button>
      </div>

      {open && (
        <div style={{ padding: '4px 8px 6px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 10, color: 'var(--origin-fg-subtle)' }}>Condition</label>
          <input
            value={condition}
            spellCheck={false}
            placeholder="e.g. i === 10"
            onChange={e => setCondition(e.target.value)}
            onBlur={() => onCondition(condition)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onCondition(condition); } }}
            style={fieldStyle}
          />
          <label style={{ fontSize: 10, color: 'var(--origin-fg-subtle)' }}>Hit count</label>
          <input
            value={hitCondition}
            spellCheck={false}
            placeholder="e.g. 5 or >3"
            onChange={e => setHitCondition(e.target.value)}
            onBlur={() => onHitCondition(hitCondition)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onHitCondition(hitCondition); } }}
            style={fieldStyle}
          />
          <label style={{ fontSize: 10, color: 'var(--origin-fg-subtle)' }}>Log message (log point)</label>
          <input
            value={logMessage}
            spellCheck={false}
            placeholder="e.g. i={i} (arrête si vide)"
            onChange={e => setLogMessage(e.target.value)}
            onBlur={() => onLogMessage(logMessage)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onLogMessage(logMessage); } }}
            style={fieldStyle}
          />
          <span style={{ fontSize: 9, color: 'var(--origin-fg-subtle)' }} title={filePath}>
            Un log point n'interrompt pas l'exécution — la condition et le hit count, si.
          </span>
        </div>
      )}
    </div>
  );
}
