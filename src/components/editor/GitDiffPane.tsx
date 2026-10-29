import { useEffect, useRef, useState } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { GitCompare } from 'lucide-react';
import { originBaseTheme, originHighlight } from './Editor';
import { getLanguageExtension } from './languageSupport';
import { gitFileHead } from '../../lib/git';
import { relativeToRoot } from '../../lib/gitGutter';
import { readFile } from '../../lib/fs';

interface Props {
  /** Chemin ABSOLU du fichier à comparer à HEAD. */
  filePath: string;
  /** Racine du dépôt (workspace) — sert de base pour `git_file_head`. */
  repoPath: string;
}

/**
 * Onglet « Git diff » (lecture seule, parité VS Code) : affiche le contenu
 * courant du fichier comparé à sa version HEAD, en merge view (ajouts/retraits).
 *
 * Contrairement à `AiDiffPane` (proposition IA approuvable), ce panneau ne
 * modifie rien : il montre l'état du working tree face au dernier commit.
 *
 * Cas particuliers gérés explicitement :
 *   - fichier **non suivi** (absent de HEAD) → tout est un ajout ;
 *   - fichier **supprimé** dans le working tree → contenu courant vide, tout est
 *     un retrait ;
 *   - `repoPath` hors dépôt → on affiche le contenu courant sans comparaison.
 */
export default function GitDiffPane({ filePath, repoPath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;

    async function build() {
      setLoading(true);
      setError(null);

      // Contenu courant du fichier (working tree). Peut être absent si supprimé.
      let current = '';
      try {
        current = await readFile(filePath);
      } catch {
        current = ''; // supprimé ou illisible → on le montre comme « tout retiré »
      }

      // Version HEAD. `untracked` → original vide (tout apparaît en ajout).
      let original = '';
      const rel = relativeToRoot(repoPath, filePath);
      if (rel !== null) {
        const head = await gitFileHead(repoPath, rel);
        if (head.status === 'tracked') original = head.content;
      }

      if (disposed || !containerRef.current) return;

      const state = EditorState.create({
        doc: current,
        extensions: [
          lineNumbers(),
          syntaxHighlighting(originHighlight),
          getLanguageExtension(filePath),
          unifiedMergeView({
            original,
            mergeControls: false,
            highlightChanges: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
          }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          originBaseTheme,
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      setLoading(false);
      cleanupView = () => view.destroy();
    }

    // Référence à la vue à détruire lors du démontage / changement de fichier.
    let cleanupView: (() => void) | null = null;
    build().catch(e => {
      if (!disposed) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    });

    return () => {
      disposed = true;
      cleanupView?.();
    };
  }, [filePath, repoPath]);

  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '7px 14px',
        borderBottom: '1px solid var(--origin-border-default)',
        backgroundColor: 'var(--origin-bg-panel)',
        flexShrink: 0,
      }}>
        <GitCompare size={14} style={{ color: 'var(--origin-fg-muted)' }} />
        <span style={{ fontSize: '12px', color: 'var(--origin-fg-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--origin-fg-default)', fontWeight: 500 }}>{fileName}</span>
          {' '}· working tree vs HEAD
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', backgroundColor: 'var(--origin-bg-editor)' }}>
        {error && (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--origin-semantic-error)' }}>
            Failed to load diff: {error}
          </div>
        )}
        {loading && !error && (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--origin-fg-subtle)' }}>
            Loading diff…
          </div>
        )}
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
      </div>
    </div>
  );
}
