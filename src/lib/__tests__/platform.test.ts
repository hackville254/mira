import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatShortcut, modLabel } from '../platform';

// Simule une plateforme en substituant navigator.platform / userAgent.
function setPlatform(value: 'mac' | 'win' | 'linux') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: value === 'mac' ? 'MacIntel' : value === 'win' ? 'Win32' : 'Linux x86_64',
             userAgent: value === 'mac' ? 'Macintosh' : value === 'win' ? 'Windows' : 'Linux' },
    configurable: true,
    writable: true,
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('formatShortcut — macOS', () => {
  it('rend les symboles Apple dans l’ordre canonique (⌘⇧P, comme VS Code)', () => {
    setPlatform('mac');
    expect(formatShortcut('ctrl+shift+p')).toBe('⌘⇧P');
  });
  it('rend Alt/option et les flèches en symboles', () => {
    setPlatform('mac');
    expect(formatShortcut('alt+down')).toBe('⌥↓');
    expect(formatShortcut('ctrl+d')).toBe('⌘D');
  });
  it('rend les touches spéciales (entrée, backspace…)', () => {
    setPlatform('mac');
    expect(formatShortcut('ctrl+enter')).toBe('⌘↵');
    expect(formatShortcut('ctrl+`')).toBe('⌘`');
  });
  it('sépare les séquences chord par un espace (⌘K ⌘O)', () => {
    setPlatform('mac');
    expect(formatShortcut('ctrl+k ctrl+o')).toBe('⌘K ⌘O');
  });
});

describe('formatShortcut — Windows / Linux', () => {
  it('rend les libellés texte avec séparateur +', () => {
    setPlatform('win');
    expect(formatShortcut('ctrl+shift+p')).toBe('Ctrl+Shift+P');
    expect(formatShortcut('alt+down')).toBe('Alt+Down');
  });
  it('rend les séquences chord avec +', () => {
    setPlatform('win');
    expect(formatShortcut('ctrl+k ctrl+o')).toBe('Ctrl+K Ctrl+O');
  });
  it('Linux suit le même rendu que Windows', () => {
    setPlatform('linux');
    expect(formatShortcut('ctrl+shift+p')).toBe('Ctrl+Shift+P');
    expect(modLabel()).toBe('Ctrl');
  });
});

describe('formatShortcut — robustesse', () => {
  it('renvoie une chaîne vide pour undefined / null / vide', () => {
    setPlatform('mac');
    expect(formatShortcut(undefined)).toBe('');
    expect(formatShortcut(null)).toBe('');
    expect(formatShortcut('')).toBe('');
  });
});
