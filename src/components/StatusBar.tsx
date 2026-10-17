import { Icon } from '@iconify/react';
import { useTheme } from '../themes/ThemeContext';
import { materialIconByKey } from '../themes/materialIcons';
import type { MobileFramework } from '../lib/mobileFrameworks';

interface Props {
  language: string;
  line: number;
  col: number;
  branch: string | null;
  debugStatus?: 'paused' | 'running' | null;
  errors?: number;
  warnings?: number;
  spaces?: number;
  lineEnding?: 'LF' | 'CRLF';
  /** Frameworks mobiles détectés dans le projet courant (badge informatif). */
  mobileFrameworks?: MobileFramework[];
  /** Ouvre le panneau Problems au clic sur le compteur. */
  onShowProblems?: () => void;
  /** Ouvre le Launchpad (palette de commandes) — équivalent VS Code. */
  onOpenLaunchpad?: () => void;
}

function StatusItem({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: '0 8px', height: '100%',
        cursor: onClick ? 'pointer' : 'default',
        borderRadius: '2px',
        transition: 'background 0.1s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => {
        if (onClick) (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {children}
    </div>
  );
}

export default function StatusBar({
  language, line, col, branch, debugStatus,
  errors = 0, warnings = 0, spaces = 2, lineEnding = 'LF',
  mobileFrameworks = [],
  onShowProblems,
  onOpenLaunchpad,
}: Props) {
  const { theme, themes, setTheme } = useTheme();
  const isDark = theme.type === 'dark';

  function toggleTheme() {
    const target = isDark
      ? themes.find(t => t.type === 'light')
      : themes.find(t => t.type === 'dark');
    if (target) setTheme(target);
  }

  return (
    <div
      data-origin-statusbar=""
      style={{
        height: '22px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'var(--origin-bg-base)',
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        color: 'var(--origin-fg-subtle)',
        userSelect: 'none',
        paddingLeft: '4px',
        paddingRight: '4px',
      }}
    >
      {/* Left */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        {branch && (
          <StatusItem>
            <Icon icon="lucide:git-branch" width={11} />
            <span>{branch}</span>
          </StatusItem>
        )}
        {debugStatus && (
          <StatusItem>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              backgroundColor: debugStatus === 'paused'
                ? 'var(--origin-accent-yellow)'
                : 'var(--origin-semantic-success)',
            }} />
            <span>{debugStatus === 'paused' ? 'Paused' : 'Running'}</span>
          </StatusItem>
        )}

        {/* Launchpad — clic = palette de commandes (comme VS Code) */}
        <StatusItem title="Launchpad" onClick={onOpenLaunchpad}>
          <Icon icon="lucide:rocket" width={11} />
          <span>Launchpad</span>
        </StatusItem>

        {/* Errors & Warnings */}
        <StatusItem title="Problems" onClick={onShowProblems}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: errors > 0 ? 'var(--origin-semantic-error)' : undefined }}>
            <Icon icon="lucide:x-circle" width={11} />
            {errors}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: warnings > 0 ? 'var(--origin-accent-yellow)' : undefined }}>
            <Icon icon="lucide:triangle-alert" width={11} />
            {warnings}
          </span>
        </StatusItem>
      </div>

      {/* Right */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        {mobileFrameworks.map(fw => (
          <StatusItem key={fw.id} title={`${fw.label} · ${fw.markers.join(', ')}`}>
            <img
              src={materialIconByKey(fw.icon)}
              width={12}
              height={12}
              alt=""
              style={{ flexShrink: 0, display: 'block' }}
            />
            <span>{fw.label}</span>
          </StatusItem>
        ))}
        <StatusItem>
          <span>{language}</span>
        </StatusItem>
        <StatusItem>
          <span>Ln {line}, Col {col}</span>
        </StatusItem>
        <StatusItem>
          <span>Spaces: {spaces}</span>
        </StatusItem>
        <StatusItem>
          <span>{lineEnding}</span>
        </StatusItem>
        <StatusItem>
          <span>UTF-8</span>
        </StatusItem>
        <StatusItem
          onClick={toggleTheme}
          title={isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
        >
          {isDark
            ? <Icon icon="lucide:sun" width={11} />
            : <Icon icon="lucide:moon" width={11} />
          }
        </StatusItem>
      </div>
    </div>
  );
}
