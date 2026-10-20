/* eslint-disable react-refresh/only-export-components -- exports the useToast hook alongside the provider component */
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XCircle } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToastType = 'info' | 'success' | 'warning' | 'error';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastState {
  id: number;
  text: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastCtx {
  showToast: (text: string, type?: ToastType, action?: ToastAction) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastCtx>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// ── Provider + UI ─────────────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 3000;
// Un toast d'erreur reste un peu plus longtemps : l'utilisateur doit avoir le
// temps de le lire, même s'il ne regardait pas l'écran à cet instant.
const ERROR_DISMISS_MS = 5000;
// Un toast avec action attend un clic ; les autres s'empilent puis expirent.
const MAX_TOASTS = 4;

function textColor(type: ToastType): string {
  if (type === 'error')   return 'var(--origin-semantic-error)';
  if (type === 'warning') return 'var(--origin-semantic-warning)';
  if (type === 'success') return 'var(--origin-semantic-success)';
  return 'var(--origin-fg-default)';
}

/**
 * File de toasts (parité Trae : plusieurs notifications peuvent coexister).
 *
 * Avant, le provider ne détenait QU'UN toast : une nouvelle notification
 * écrasait la précédente. Avec le multitâche, plusieurs tâches peuvent finir ou
 * échouer quasi simultanément — il faut donc savoir les afficher ensemble.
 *
 * Les toasts s'empilent verticalement (le plus récent en bas), chacun ayant son
 * propre minuteur d'expiration. L'API publique `showToast(text, type?, action?)`
 * reste inchangée : aucun appelant existant n'a besoin d'être adapté.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback((text: string, type: ToastType = 'info', action?: ToastAction) => {
    const id = ++seq.current;
    setToasts(prev => {
      const next = [...prev, { id, text, type, action }];
      // Au-delà du plafond, on retire les plus anciens (ceux du haut).
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    // Un toast porteur d'action reste jusqu'au clic (ou fermeture manuelle).
    if (!action) {
      const ttl = type === 'error' ? ERROR_DISMISS_MS : AUTO_DISMISS_MS;
      setTimeout(() => dismiss(id), ttl);
    }
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 && createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: 32,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column-reverse',
            alignItems: 'center',
            gap: 8,
            pointerEvents: 'none',
          }}
        >
          {toasts.map(toast => (
            <div
              key={toast.id}
              style={{
                pointerEvents: 'auto',
                minWidth: 280,
                maxWidth: 480,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px 8px 14px',
                borderRadius: 7,
                backgroundColor: 'var(--origin-bg-base)',
                border: '1px solid var(--origin-border-default)',
                color: textColor(toast.type),
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
                whiteSpace: 'normal',
              }}
            >
              <span style={{ flex: 1 }}>{toast.text}</span>
              {toast.action && (
                <button
                  onClick={() => { toast.action!.onClick(); dismiss(toast.id); }}
                  style={{
                    flexShrink: 0, background: 'var(--origin-bg-hover)',
                    border: '1px solid var(--origin-border-default)',
                    borderRadius: 5, cursor: 'pointer', padding: '3px 10px',
                    color: 'var(--origin-fg-default)', fontSize: 11,
                    fontFamily: 'var(--font-sans)', fontWeight: 500,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-active)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--origin-bg-hover)'; }}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(toast.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, background: 'transparent', border: 'none',
                  cursor: 'pointer', padding: 2, borderRadius: '50%',
                  color: 'var(--origin-fg-muted)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-default)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--origin-fg-muted)'; }}
              >
                <XCircle size={15} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}
