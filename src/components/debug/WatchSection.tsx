import { useState } from 'react';
import { Icon } from '@iconify/react';
import { useDebugContext } from '../../context/DebugContext';

/**
 * Section « Watch » du panneau Debug : liste d'expressions réévaluées à chaque
 * arrêt (commande DAP `evaluate`, contexte `watch`). Les résultats proviennent de
 * `session.evalEntries` (kind === 'watch').
 */
export default function WatchSection() {
  const { session, addWatchExpression, removeWatchExpression } = useDebugContext();
  const { watchExpressions, evalEntries } = session;
  const [input, setInput] = useState('');

  const valueFor = (expr: string) =>
    evalEntries.find(e => e.kind === 'watch' && e.expression === expr);

  function submit() {
    const expr = input.trim();
    if (!expr) return;
    addWatchExpression(expr);
    setInput('');
  }

  return (
    <div>
      {watchExpressions.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--origin-fg-subtle)', padding: '6px 12px' }}>
          No watch expressions.
        </p>
      )}
      {watchExpressions.map(expr => {
        const entry = valueFor(expr);
        return (
          <div
            key={expr}
            style={{ display: 'flex', alignItems: 'baseline', gap: 4, padding: '2px 8px', fontSize: 11 }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span style={{ color: 'var(--origin-syntax-variable)', flexShrink: 0 }}>{expr}</span>
            <span style={{ color: 'var(--origin-fg-subtle)', flexShrink: 0 }}>=</span>
            {!entry
              ? <span style={{ color: 'var(--origin-fg-subtle)' }}>not available</span>
              : entry.error
                ? <span style={{ color: 'var(--origin-semantic-error)', wordBreak: 'break-all' }}>{entry.error}</span>
                : <span style={{ color: 'var(--origin-syntax-string)', wordBreak: 'break-all' }}>{entry.value}</span>}
            <button
              onClick={() => removeWatchExpression(expr)}
              title="Remove watch"
              style={{
                marginLeft: 'auto', background: 'none', border: 'none', padding: 2,
                cursor: 'pointer', color: 'var(--origin-fg-subtle)', display: 'flex', flexShrink: 0,
              }}
            >
              <Icon icon="lucide:x" width={10} />
            </button>
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder="Add expression…"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box',
            background: 'var(--origin-bg-input)', border: '1px solid var(--origin-border-default)',
            borderRadius: 4, outline: 'none', padding: '2px 6px',
            color: 'var(--origin-fg-default)', fontFamily: 'var(--font-mono)', fontSize: 11,
          }}
        />
        <button
          onClick={submit}
          disabled={!input.trim()}
          title="Add watch expression"
          style={{
            background: 'none', border: 'none', padding: 2, display: 'flex',
            cursor: input.trim() ? 'pointer' : 'not-allowed',
            color: input.trim() ? 'var(--origin-fg-default)' : 'var(--origin-fg-subtle)',
          }}
        >
          <Icon icon="lucide:plus" width={12} />
        </button>
      </div>
    </div>
  );
}
