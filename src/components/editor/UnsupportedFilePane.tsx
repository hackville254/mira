import { FileWarning } from 'lucide-react';
import { extensionOf } from '../../lib/fileKind';

interface Props {
  fileName: string;
  /** Raison optionnelle (ex. fichier trop volumineux). */
  reason?: string;
}

/**
 * Message affiché pour un fichier binaire sans lecteur intégré (archives,
 * médias, exécutables…). On évite ainsi de tenter un décodage texte qui
 * produirait un écran d'erreur obscur (« stream did not contain valid UTF-8 »).
 */
export default function UnsupportedFilePane({ fileName, reason }: Props) {
  const ext = extensionOf(fileName).toUpperCase();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden',
      backgroundColor: 'var(--origin-bg-editor)' }}>
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
        {ext && <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>· {ext}</span>}
      </div>

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '10px',
        color: 'var(--origin-fg-subtle)',
      }}>
        <FileWarning size={32} />
        <p style={{ fontSize: '13px', margin: 0, color: 'var(--origin-fg-default)' }}>
          Ce fichier ne peut pas être affiché
        </p>
        <p style={{ fontSize: '12px', margin: 0, maxWidth: '360px', textAlign: 'center' }}>
          {reason ?? "Origin ne dispose pas de lecteur pour ce format binaire. Ouvre-le avec une application externe."}
        </p>
      </div>
    </div>
  );
}
