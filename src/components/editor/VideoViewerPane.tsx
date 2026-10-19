import { useEffect, useMemo, useState } from 'react';
import { FileWarning } from 'lucide-react';

interface Props {
  /** Contenu du média encodé en base64 (sans préfixe data:). */
  base64: string;
  /** Type MIME (ex. « video/mp4 »). */
  mime: string;
  /** Nom affiché dans la barre d'outils. */
  fileName: string;
}

/**
 * Visionneuse vidéo pleine page.
 *
 * Le base64 est converti en **Blob** puis exposé via `URL.createObjectURL` : le
 * lecteur natif de la webview lit une URL d'objet (support du seek, du
 * streaming partiel), ce qui évite la limite de longueur des data URLs sur les
 * gros fichiers. L'URL d'objet est révoquée au démontage (pas de fuite mémoire).
 *
 * Les bytes sont déjà confinés et lus côté backend (garde workspace) ; la
 * webview ne reçoit aucune URL de fichier exploitable.
 */
export default function VideoViewerPane({ base64, mime, fileName }: Props) {
  const [failed, setFailed] = useState(false);

  const blobUrl = useMemo(() => {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      return URL.createObjectURL(blob);
    } catch {
      return '';
    }
  }, [base64, mime]);

  // Révocation de l'URL d'objet au démontage (pas de fuite mémoire).
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
        <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>· Video</span>
      </div>

      {/* Contenu */}
      <div style={{ flex: 1, position: 'relative', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '16px',
        backgroundColor: 'var(--origin-bg-hover)' }}>
        {failed || !blobUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--origin-fg-subtle)' }}>
            <FileWarning size={28} />
            <span style={{ fontSize: '12px' }}>Cannot play this video</span>
          </div>
        ) : (
          <video
            src={blobUrl}
            controls
            onError={() => setFailed(true)}
            style={{ maxWidth: '100%', maxHeight: '100%', boxShadow: '0 1px 8px rgba(0,0,0,0.35)' }}
          />
        )}
      </div>
    </div>
  );
}
