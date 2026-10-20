import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import {
  outlineFromLsp,
  outlineFromText,
  languageIdOf,
  hasLspForFile,
  type OutlineSymbol,
  type OutlineKind,
} from '../../lib/outline';

// ── Mapping catégorie de symbole → icône (lucide) + couleur CSS ────────────────

const KIND_ICON: Record<OutlineKind, string> = {
  file: 'lucide:file',
  module: 'lucide:package',
  namespace: 'lucide:braces',
  package: 'lucide:box',
  class: 'lucide:box',
  method: 'lucide:function-square',
  property: 'lucide:at-sign',
  field: 'lucide:square-dashed-bottom',
  constructor: 'lucide:wrench',
  enum: 'lucide:list',
  enumMember: 'lucide:dot',
  interface: 'lucide:link',
  function: 'lucide:function-square',
  variable: 'lucide:variable',
  constant: 'lucide:hash',
  string: 'lucide:text-quote',
  number: 'lucide:hash',
  boolean: 'lucide:toggle-right',
  array: 'lucide:brackets',
  object: 'lucide:braces',
  key: 'lucide:key',
  null: 'lucide:circle-slash',
  struct: 'lucide:box',
  event: 'lucide:zap',
  operator: 'lucide:plus-circle',
  typeParameter: 'lucide:type',
};

const KIND_COLOR: Partial<Record<OutlineKind, string>> = {
  class: 'var(--origin-syntax-type)',
  struct: 'var(--origin-syntax-type)',
  interface: 'var(--origin-syntax-type)',
  enum: 'var(--origin-syntax-type)',
  namespace: 'var(--origin-syntax-keyword)',
  module: 'var(--origin-syntax-keyword)',
  package: 'var(--origin-syntax-keyword)',
  function: 'var(--origin-syntax-function)',
  method: 'var(--origin-syntax-function)',
  constructor: 'var(--origin-syntax-function)',
  property: 'var(--origin-syntax-variable)',
  field: 'var(--origin-syntax-variable)',
  variable: 'var(--origin-syntax-variable)',
  constant: 'var(--origin-syntax-constant)',
  string: 'var(--origin-syntax-string)',
  number: 'var(--origin-syntax-constant)',
  boolean: 'var(--origin-syntax-constant)',
};

interface Props {
  /** Chemin du fichier actif (onglet courant). */
  activePath?: string;
  /** Contenu courant du fichier (pour le fallback regex hors LSP). */
  content?: string;
  /** Racine du workspace (nécessaire pour démarrer le serveur LSP). */
  rootPath?: string;
  onFileOpenAtLine: (path: string, line: number, col: number) => void;
}

/** Rendu récursif d'un nœud de l'outline (avec repli/dépli local). */
function OutlineNode({ sym, depth, onJump }: {
  sym: OutlineSymbol;
  depth: number;
  onJump: (line: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = sym.children.length > 0;
  const color = KIND_COLOR[sym.kind] ?? 'var(--origin-fg-muted)';

  return (
    <div>
      <div
        onClick={() => onJump(sym.line)}
        title={sym.detail ? `${sym.name} — ${sym.detail}` : sym.name}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          height: 22, paddingLeft: 6 + depth * 12, paddingRight: 6,
          cursor: 'pointer', fontSize: 12.5, color: 'var(--origin-fg-default)',
          whiteSpace: 'nowrap', overflow: 'hidden',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        {/* Chevron de repli (espace réservé même sans enfants pour l'alignement) */}
        <span
          onClick={e => { e.stopPropagation(); if (hasChildren) setOpen(o => !o); }}
          style={{ display: 'flex', alignItems: 'center', width: 12, flexShrink: 0, color: 'var(--origin-fg-subtle)' }}
        >
          {hasChildren && (
            <Icon icon={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} width={12} />
          )}
        </span>
        <Icon icon={KIND_ICON[sym.kind]} width={13} style={{ color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sym.name}</span>
        {sym.detail && (
          <span style={{ color: 'var(--origin-fg-subtle)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {sym.detail}
          </span>
        )}
      </div>
      {open && hasChildren && sym.children.map((c, i) => (
        <OutlineNode key={`${c.name}-${c.line}-${i}`} sym={c} depth={depth + 1} onJump={onJump} />
      ))}
    </div>
  );
}

/**
 * Panel « Outline » : arbre des symboles du fichier actif.
 * Source : LSP `documentSymbol` si un serveur est actif, sinon regex locale.
 */
export default function OutlinePanel({ activePath, content, rootPath, onFileOpenAtLine }: Props) {
  const [lspSymbols, setLspSymbols] = useState<OutlineSymbol[] | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const isVirtual = !activePath || activePath.startsWith('__');

  // Fallback regex : dérivation pure du contenu, pas d'effet (évite un setState synchrone).
  const fallbackSymbols = useMemo(
    () => (isVirtual ? [] : outlineFromText(content ?? '', languageIdOf(activePath as string))),
    [isVirtual, activePath, content],
  );

  const useLsp = !isVirtual && !!rootPath && hasLspForFile(activePath as string);

  // Charge les symboles LSP (asynchrone uniquement). Le fallback est dérivé, pas stocké.
  useEffect(() => {
    if (!useLsp || !activePath || !rootPath) return;
    const id = ++reqId.current;
    let cancelled = false;
    // Débounce léger : évite de marteler le serveur à chaque frappe.
    const timer = setTimeout(() => {
      setLoading(true);
      outlineFromLsp(activePath, rootPath).then(res => {
        if (cancelled || id !== reqId.current) return;
        setLspSymbols(res ?? null);
        setLoading(false);
      });
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [activePath, content, rootPath, useLsp]);

  // Source affichée : LSP si disponible, sinon fallback regex dérivé.
  const symbols = useLsp ? lspSymbols ?? fallbackSymbols : fallbackSymbols;

  const jump = useMemo(() => (line: number) => {
    if (activePath) onFileOpenAtLine(activePath, line, 1);
  }, [activePath, onFileOpenAtLine]);

  if (isVirtual) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <p style={{ fontSize: 12, color: 'var(--origin-fg-subtle)', textAlign: 'center' }}>
          No file open.
        </p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* En-tête : nom du fichier */}
      <div style={{
        height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 10px', borderBottom: '1px solid var(--origin-border-subtle)',
        fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4,
        color: 'var(--origin-fg-subtle)', userSelect: 'none',
      }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activePath.replace(/\\/g, '/').split('/').pop()}
        </span>
        {loading && <Icon icon="lucide:loader-circle" width={12} className="animate-spin" />}
      </div>

      <div style={{ flex: 1, overflow: 'auto', paddingTop: 4 }}>
        {symbols.length > 0 ? (
          symbols.map((s, i) => (
            <OutlineNode key={`${s.name}-${s.line}-${i}`} sym={s} depth={0} onJump={jump} />
          ))
        ) : (
          <p style={{ fontSize: 12, color: 'var(--origin-fg-subtle)', padding: '12px 10px', lineHeight: 1.5 }}>
            No symbols found in this file.
          </p>
        )}
      </div>
    </div>
  );
}
