/**
 * Breadcrumbs — fil d'Ariane des symboles au-dessus de l'éditeur.
 *
 * Affiche le chemin de symboles englobant la ligne du curseur, façon VS Code :
 *   chemin → dossier → fichier → classe → méthode
 *
 * Source des symboles : identique à l'Outline (`outlineFromLsp` si un serveur
 * est actif, sinon fallback regex local). On réutilise la même logique
 * anti-race / débounce que `OutlinePanel` pour rester cohérent et éviter les
 * requêtes LSP redondantes.
 *
 * Le clic sur un segment saute à la ligne du symbole.
 */
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

// ── Icônes par catégorie (mêmes conventions que l'Outline) ─────────────────────

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

interface Props {
  /** Chemin du fichier actif (onglet courant). */
  activePath?: string;
  /** Contenu courant du fichier (sert au fallback regex hors LSP). */
  content?: string;
  /** Racine du workspace (nécessaire pour démarrer le serveur LSP). */
  rootPath?: string;
  /** Ligne (1-based) du curseur — détermine le symbole courant. */
  cursorLine?: number;
  /** Saute à une ligne (et colonne) du fichier actif. */
  onJump: (line: number, col: number) => void;
}

/** Un cran du fil d'Ariane. */
interface Crumb {
  label: string;
  kind: OutlineKind;
  line: number;
  col: number;
}

/**
 * Trouve la chaîne de symboles englobant `cursorLine`, de la plus externe (la
 * racine) à la plus interne. Renvoie `[]` si aucun symbole ne contient la ligne.
 */
function crumbsForLine(
  symbols: OutlineSymbol[],
  cursorLine: number,
): OutlineSymbol[] {
  for (const sym of symbols) {
    // Un symbole englobe la ligne si elle est dans [line, endLine].
    if (cursorLine >= sym.line && cursorLine <= sym.endLine) {
      const inner = crumbsForLine(sym.children, cursorLine);
      // Le symbole courant d'abord, puis ses descendants englobants.
      return [sym, ...inner];
    }
  }
  return [];
}

/** Compose le chemin du dossier (segments) à partir de la racine. */
function folderCrumbs(activePath: string, rootPath?: string): Crumb[] {
  const norm = activePath.replace(/\\/g, '/');
  const root = (rootPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = norm;
  if (root && (norm === root || norm.startsWith(root + '/'))) {
    rel = norm.slice(root.length).replace(/^\/+/, '');
  }
  const parts = rel.split('/').filter(Boolean);
  parts.pop(); // retire le nom de fichier (affiché à part)
  return parts.map(p => ({ label: p, kind: 'namespace', line: 0, col: 0 }));
}

const SEP = (
  <Icon icon="lucide:chevron-right" width={12} style={{ color: 'var(--origin-fg-subtle)', flexShrink: 0 }} />
);

/**
 * Barre de fil d'Ariane. Ne rend rien si aucun fichier texte n'est actif.
 */
export default function Breadcrumbs({ activePath, content, rootPath, cursorLine, onJump }: Props) {
  const [lspSymbols, setLspSymbols] = useState<OutlineSymbol[] | null>(null);
  const reqId = useRef(0);

  const isVirtual = !activePath || activePath.startsWith('__');

  // Fallback regex dérivé du contenu (pas de setState synchrone dans un effet).
  const fallbackSymbols = useMemo(
    () => (isVirtual ? [] : outlineFromText(content ?? '', languageIdOf(activePath as string))),
    [isVirtual, activePath, content],
  );

  const useLsp = !isVirtual && !!rootPath && hasLspForFile(activePath as string);

  useEffect(() => {
    if (!useLsp || !activePath || !rootPath) return;
    const id = ++reqId.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      outlineFromLsp(activePath, rootPath).then(res => {
        if (cancelled || id !== reqId.current) return;
        setLspSymbols(res ?? null);
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activePath, content, rootPath, useLsp]);

  const symbols = useLsp ? lspSymbols ?? fallbackSymbols : fallbackSymbols;

  const crumbs = useMemo<Crumb[]>(() => {
    if (isVirtual || !activePath) return [];
    const folders = folderCrumbs(activePath, rootPath);
    const fileName = activePath.replace(/\\/g, '/').split('/').pop() ?? activePath;
    const line = cursorLine ?? 1;
    const symChain = crumbsForLine(symbols, line).map(s => ({
      label: s.name,
      kind: s.kind,
      line: s.line,
      col: 1,
    }));
    return [
      ...folders,
      { label: fileName, kind: 'file' as OutlineKind, line: 1, col: 1 },
      ...symChain,
    ];
  }, [isVirtual, activePath, rootPath, symbols, cursorLine]);

  if (isVirtual || crumbs.length === 0) return null;

  return (
    <div
      style={{
        height: 24, flexShrink: 0, display: 'flex', alignItems: 'center',
        gap: 2, padding: '0 10px', overflow: 'hidden', whiteSpace: 'nowrap',
        background: 'var(--origin-bg-editor)',
        borderBottom: '1px solid var(--origin-border-subtle)',
        fontSize: 12, userSelect: 'none',
      }}
    >
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${c.line}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
          {i > 0 && SEP}
          <span
            onClick={() => c.line > 0 && onJump(c.line, c.col)}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; e.currentTarget.style.color = 'var(--origin-fg-default)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--origin-fg-muted)'; }}
            title={c.label}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '1px 5px', borderRadius: 4, cursor: c.line > 0 ? 'pointer' : 'default',
              color: 'var(--origin-fg-muted)', maxWidth: 220,
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {c.kind !== 'namespace' && (
              <Icon icon={KIND_ICON[c.kind] ?? 'lucide:file'} width={12} style={{ flexShrink: 0, opacity: 0.8 }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
