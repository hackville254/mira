import { ArrowRight, ArrowLeft } from 'lucide-react';
import { PROVIDERS, CDN, type Provider } from './data';

interface Props { onBack: () => void; onNext: () => void; onSkip: () => void; }

const navBtn = (secondary?: boolean): React.CSSProperties => ({
  background: secondary ? 'transparent' : 'var(--origin-tooltip-bg)',
  border: secondary ? '1px solid var(--origin-border-default)' : 'none',
  borderRadius: '7px',
  color: secondary ? 'var(--origin-fg-muted)' : 'var(--origin-tooltip-fg)',
  fontSize: '13px', fontWeight: 600, padding: '8px 22px', cursor: 'pointer', fontFamily: 'inherit',
  display: 'flex', alignItems: 'center', gap: '8px',
  boxShadow: secondary ? 'none' : '0 1px 4px rgba(0,0,0,0.25)', transition: 'opacity 0.15s',
});

/** Carte logo d'un provider : icône (ou initiales) + libellé. Purement présentative. */
function LogoCard({ p }: { p: Provider }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '16px 8px 14px', width: '96px', flexShrink: 0, background: 'var(--origin-bg-base)', border: '1px solid var(--origin-border-default)', borderRadius: '10px', textAlign: 'center' }}>
      <div style={{ width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {p.icon
          ? <img src={CDN + p.icon} alt={p.label} draggable={false} style={{ width: '34px', height: '34px', objectFit: 'contain', filter: p.invert ? 'brightness(0) invert(1)' : 'none' }} />
          : <div style={{ width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--origin-bg-active)', borderRadius: '8px', fontSize: '14px', fontWeight: 700, color: 'var(--origin-fg-muted)' }}>{p.label.slice(0, 2)}</div>
        }
      </div>
      <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--origin-fg-muted)', lineHeight: 1.2 }}>{p.label}</span>
    </div>
  );
}

/**
 * Rangée défilante en boucle infinie. On duplique la liste pour que la piste
 * couvre toujours 2x la largeur de l'écran, puis on translate de -50% : la
 * seconde copie prend exactement la place de la première, sans couture.
 */
function MarqueeRow({ providers, reverse, duration }: { providers: Provider[]; reverse?: boolean; duration: number }) {
  const track = [...providers, ...providers];
  return (
    <div style={{ position: 'relative', width: '100%', overflow: 'hidden', maskImage: 'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)' }}>
      <div style={{ display: 'flex', gap: '14px', width: 'max-content', animation: `${reverse ? 'mira-marquee-rev' : 'mira-marquee'} ${duration}s linear infinite` }}>
        {track.map((p, i) => <LogoCard key={`${p.id}-${i}`} p={p} />)}
      </div>
    </div>
  );
}

export default function ConnectAIPage({ onBack, onNext, onSkip }: Props) {
  // Deux rangées défilant en sens opposés : répartit les providers et donne un
  // rendu vivant sans interaction. Aucune sélection, aucune clé demandée ici.
  const half = Math.ceil(PROVIDERS.length / 2);
  const rowOne = PROVIDERS.slice(0, half);
  const rowTwo = PROVIDERS.slice(half);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px 24px', gap: '34px' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'center', maxWidth: '560px' }}>
          <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--origin-fg-default)' }}>Any model, on your terms</div>
          <div style={{ fontSize: '13px', color: 'var(--origin-fg-subtle)', lineHeight: 1.5 }}>
            Mira works with the models you already trust — hosted or local.
          </div>
        </div>

        <div style={{ width: '100%', maxWidth: '860px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <MarqueeRow providers={rowOne} duration={34} />
          <MarqueeRow providers={rowTwo} reverse duration={42} />
        </div>

      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 24px 40px', maxWidth: '580px', width: '100%', alignSelf: 'center' }}>
        <button onClick={onSkip} style={{ background: 'none', border: 'none', color: 'var(--origin-fg-muted)', fontSize: '12px', cursor: 'pointer', padding: '4px 10px', fontFamily: 'inherit' }} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-default)'; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-muted)'; }}>Skip for now</button>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onBack} style={navBtn(true)} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-default)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--origin-fg-subtle)'; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--origin-border-default)'; }}><ArrowLeft size={16} />Back</button>
          <button onClick={onNext} style={navBtn()} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.88'; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}>Next<ArrowRight size={16} /></button>
        </div>
      </div>
    </div>
  );
}
