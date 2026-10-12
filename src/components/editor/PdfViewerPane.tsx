import { useEffect, useMemo, useState } from 'react';
import { FileWarning, ExternalLink } from 'lucide-react';

interface Props {
  /** Contenu du PDF encodé en base64 (sans préfixe data:). */
  base64: string;
  /** Nom affiché dans la barre d'outils. */
  fileName: string;
}

/**
 * Visionneuse PDF pleine page.
 *
 * Le base64 est converti en **Blob** puis exposé via `URL.createObjectURL` : le
 * rendu PDF natif de la webview (WebView2 / WKWebView) lit une URL d'objet, ce
 * qui évite la limite de longueur des data URLs sur les gros documents. L'URL
 * d'objet est révoquée au démontage (pas de fuite mémoire).
 *
 * Le PDF est déjà confiné et lu côté backend (garde workspace), la webview ne
 * reçoit que des bytes ; aucun accès fichier n'est ouvert.
 */
export default function PdfViewerPane({ base64, fileName }: Props) {
  const [failed, setFailed] = useState(false);

  // Blob URL recréé uniquement quand le contenu change.
  const blobUrl = useMemo(() => {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      return URL.createObjectURL(blob);
    } catch {
      return '';
    }
  }, [base64]);

  // Révocation de l'URL d'objet au démontage (pas de fuite mémoire). Le flag
  // `failed` n'est posé que par `onError` sur l'<embed>, jamais dans un effet.
  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden',
      backgroundColor: 'var(--origin-bg-editor)' }}>
      {/* Barre d'outils */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '5px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--origin-border-default)',
        backgroundColor: 'var(--origin-bg-base)',
      }}>
        <span style={{
          fontSize: '12px', fontWeight: 500, color: 'var(--origin-fg-default)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {fileName}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>· PDF</span>

        <div style={{ flex: 1 }} />

        {blobUrl && (
          <a
            href={blobUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', color: 'var(--origin-fg-muted)', textDecoration: 'none',
              padding: '3px 8px', borderRadius: '4px',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <ExternalLink size={12} /> Ouvrir
          </a>
        )}
      </div>

      {/* Contenu */}
      <div style={{ flex: 1, position: 'relative', backgroundColor: 'var(--origin-bg-hover)' }}>
        {failed || !blobUrl ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--origin-fg-subtle)' }}>
            <FileWarning size={28} />
            <span style={{ fontSize: '12px' }}>Impossible d'afficher ce PDF</span>
          </div>
        ) : (
          <embed
            src={blobUrl}
            type="application/pdf"
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}
      </div>
    </div>
  );
}
