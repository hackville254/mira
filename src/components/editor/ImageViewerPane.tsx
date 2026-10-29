import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, ImageOff } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

interface Props {
  /** Contenu du fichier encodé en base64 (sans le préfixe data:). */
  base64: string;
  /** Type MIME (ex. « image/png »). */
  mime: string;
  /** Nom affiché dans la barre d'outils. */
  fileName: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;

/**
 * Visionneuse d'image pleine page : fond damier (transparence), zoom
 * molette + boutons, ajustement automatique si l'image dépasse la vue, et état
 * d'erreur si le décodage échoue.
 *
 * L'image est servie via une data URL construite depuis les bytes déjà lus et
 * confinés côté backend : aucun chemin de fichier n'est exposé à la webview.
 */
export default function ImageViewerPane({ base64, mime, fileName }: Props) {
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState(false);
  const [fit, setFit] = useState(true);
  const [loaded, setLoaded] = useState<{ src: string; w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const src = `data:${mime};base64,${base64}`;
  // Taille valide uniquement pour l'image courante : évite d'appliquer les
  // dimensions de l'image précédente pendant le chargement de la suivante.
  const natural = loaded?.src === src ? loaded : null;
  const naturalW = natural?.w ?? 0;
  const naturalH = natural?.h ?? 0;

  /** Ajuste le zoom pour que l'image entière tienne dans la vue. */
  function computeFit(): number | null {
    const box = containerRef.current;
    if (!box || !naturalW || !naturalH) return null;
    const availableW = box.clientWidth - 32;
    const availableH = box.clientHeight - 32;
    return Math.max(MIN_ZOOM, Math.min(availableW / naturalW, availableH / naturalH, 1));
  }

  // « Fit » quand l'image change de taille ; réajuste au redimensionnement du
  // panneau tant que le mode ajusté est actif.
  useEffect(() => {
    if (!fit) return;
    const box = containerRef.current;
    if (!box) return;
    const apply = () => {
      const z = computeFit();
      if (z !== null) setZoom(z);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computeFit lit la taille courante via des primitives stables
  }, [fit, naturalW, naturalH]);

  function zoomBy(factor: number) {
    setFit(false);
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  }

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // la molette seule fait défiler
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    // Poser la taille suffit : l'effet de « fit » réagit à naturalW/naturalH.
    setLoaded({ src, w: img.naturalWidth, h: img.naturalHeight });
    setError(false);
  }

  /** Active le mode ajusté ; l'effet applique le zoom immédiatement. */
  function requestFit() {
    const z = computeFit();
    if (z !== null) setZoom(z);
    setFit(true);
  }

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
        <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)' }}>· Image</span>

        <div style={{ flex: 1 }} />

        <Tooltip content="Zoom out" side="bottom">
          <ToolbarButton onClick={() => zoomBy(1 / ZOOM_STEP)}><ZoomOut size={13} /></ToolbarButton>
        </Tooltip>
        <span style={{ fontSize: '11px', color: 'var(--origin-fg-subtle)', minWidth: '42px', textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip content="Zoom in" side="bottom">
          <ToolbarButton onClick={() => zoomBy(ZOOM_STEP)}><ZoomIn size={13} /></ToolbarButton>
        </Tooltip>
        <Tooltip content="Fit" side="bottom">
          <ToolbarButton onClick={requestFit}><Maximize2 size={13} /></ToolbarButton>
        </Tooltip>
      </div>

      {/* Zone d'affichage */}
      <div
        ref={containerRef}
        onWheel={onWheel}
        style={{
          flex: 1, overflow: 'auto', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          padding: '16px',
          // Damier discret pour révéler la transparence (PNG, SVG…).
          backgroundImage:
            'linear-gradient(45deg, var(--origin-bg-hover) 25%, transparent 25%),' +
            'linear-gradient(-45deg, var(--origin-bg-hover) 25%, transparent 25%),' +
            'linear-gradient(45deg, transparent 75%, var(--origin-bg-hover) 75%),' +
            'linear-gradient(-45deg, transparent 75%, var(--origin-bg-hover) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        }}
      >
        {error ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
            color: 'var(--origin-fg-subtle)' }}>
            <ImageOff size={28} />
            <span style={{ fontSize: '12px' }}>Cannot display this image</span>
          </div>
        ) : (
          <img
            src={src}
            alt={fileName}
            onLoad={onImgLoad}
            onError={() => setError(true)}
            style={{
              maxWidth: natural ? 'none' : '100%',
              maxHeight: natural ? 'none' : '100%',
              width: natural ? natural.w * zoom : undefined,
              height: natural ? natural.h * zoom : undefined,
              imageRendering: zoom > 1 ? 'pixelated' : 'auto',
              boxShadow: '0 1px 8px rgba(0,0,0,0.35)',
              display: 'block',
            }}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '26px', height: '24px', border: 'none', borderRadius: '4px',
        background: 'transparent', cursor: 'pointer',
        color: 'var(--origin-fg-muted)',
        transition: 'background 0.1s, color 0.1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--origin-bg-hover)'; e.currentTarget.style.color = 'var(--origin-fg-default)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--origin-fg-muted)'; }}
    >
      {children}
    </button>
  );
}
