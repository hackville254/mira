import { useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useDebugContext } from '../../context/DebugContext';

/**
 * Debug Console : REPL d'évaluation d'expressions dans le contexte du point
 * d'arrêt courant (commande DAP `evaluate`, contexte `repl`).
 *
 * Historique en mémoire (session) : chaque entrée porte l'expression, le
 * résultat ou l'erreur. Les entrées structurées (variablesReference > 0) sont
 * affichées mais non dépliables ici — l'inspection détaillée passe par le
 * panneau Variables.
 */
export default function DebugConsole() {
  const { session, evaluateExpression, clearConsole } = useDebugContext();
  const { evalEntries } = session;
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const consoleEntries = evalEntries.filter(e => e.kind === 'console');

  async function submit() {
    const expr = input.trim();
    if (!expr) return;
    setHistory(h => [...h, expr]);
    setHistoryIdx(-1);
    setInput('');
    await evaluateExpression(expr);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); void submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(history[next]);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const next = historyIdx + 1;
      if (next >= history.length) { setHistoryIdx(-1); setInput(''); }
      else { setHistoryIdx(next); setInput(history[next]); }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Historique */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, minHeight: 80, overflowY: 'auto',
          fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5,
          padding: '4px 8px',
        }}
      >
        {consoleEntries.length === 0 ? (
          <span style={{ color: 'var(--origin-fg-subtle)' }}>
            Evaluate expressions in the debuggee's current context.
          </span>
        ) : consoleEntries.map(e => (
          <div key={e.id} style={{ marginBottom: 2, wordBreak: 'break-all' }}>
            <span style={{ color: 'var(--origin-fg-subtle)' }}>› </span>
            <span style={{ color: 'var(--origin-syntax-variable)' }}>{e.expression}</span>
            <span style={{ color: 'var(--origin-fg-subtle)' }}> = </span>
            {e.error
              ? <span style={{ color: 'var(--origin-semantic-error)' }}>{e.error}</span>
              : (
                <span style={{ color: 'var(--origin-syntax-string)' }}>
                  {e.value}
                  {e.type && <span style={{ color: 'var(--origin-fg-subtle)' }}> ({e.type})</span>}
                </span>
              )}
          </div>
        ))}
      </div>

      {/* Saisie */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        borderTop: '1px solid var(--origin-border-default)', padding: '3px 6px',
      }}>
        <span style={{ color: 'var(--origin-fg-subtle)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>›</span>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="expression… (↑/↓ historique)"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--origin-fg-default)', fontFamily: 'var(--font-mono)', fontSize: 11,
          }}
        />
        <button
          onClick={clearConsole}
          title="Clear console"
          style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--origin-fg-subtle)', display: 'flex' }}
        >
          <Icon icon="lucide:trash-2" width={12} />
        </button>
        <button
          onClick={() => void submit()}
          disabled={!input.trim()}
          title="Evaluate"
          style={{
            background: 'none', border: 'none', padding: 2, display: 'flex',
            cursor: input.trim() ? 'pointer' : 'not-allowed',
            color: input.trim() ? 'var(--origin-fg-default)' : 'var(--origin-fg-subtle)',
          }}
        >
          <Icon icon="lucide:corner-down-left" width={12} />
        </button>
      </div>
    </div>
  );
}
