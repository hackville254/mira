import { describe, it, expect } from 'vitest';
import {
  detectMobileFrameworksFromNames,
  isMobileProject,
  MOBILE_ICON_KEYS,
} from '../mobileFrameworks';

describe('detectMobileFrameworksFromNames', () => {
  it('détecte Flutter via pubspec.yaml', () => {
    const result = detectMobileFrameworksFromNames(['pubspec.yaml', 'lib', 'test'], null);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('flutter');
    expect(result[0].icon).toBe('flutter');
    expect(result[0].language).toBe('dart');
    expect(result[0].markers).toContain('pubspec.yaml');
  });

  it('détecte React Native via dépendance package.json', () => {
    const pkg = JSON.stringify({ dependencies: { 'react-native': '0.74.0' } });
    const result = detectMobileFrameworksFromNames(['package.json', 'index.js'], pkg);
    expect(result.map(f => f.id)).toContain('react-native');
  });

  it('détecte Expo via dépendance et marqueur explicite', () => {
    const pkg = JSON.stringify({ dependencies: { expo: '~51.0.0' } });
    const result = detectMobileFrameworksFromNames(['package.json'], pkg);
    expect(result.map(f => f.id)).toContain('expo');
  });

  it('détecte Android natif via settings.gradle', () => {
    const result = detectMobileFrameworksFromNames(['settings.gradle', 'app'], null);
    expect(result.map(f => f.id)).toContain('android');
    expect(result[0].icon).toBe('android');
  });

  it('détecte iOS natif via Podfile', () => {
    const result = detectMobileFrameworksFromNames(['Podfile', 'Runner'], null);
    expect(result.map(f => f.id)).toContain('ios');
  });

  it('déduplique un même framework détecté par plusieurs marqueurs', () => {
    const result = detectMobileFrameworksFromNames(
      ['settings.gradle', 'settings.gradle.kts', 'AndroidManifest.xml'],
      null,
    );
    const android = result.filter(f => f.id === 'android');
    expect(android).toHaveLength(1);
    expect(android[0].markers.length).toBe(3);
  });

  it('ignore un package.json invalide sans planter', () => {
    const result = detectMobileFrameworksFromNames(['package.json'], '{ not json');
    expect(result).toHaveLength(0);
  });

  it('renvoie un tableau vide pour un projet non mobile', () => {
    const result = detectMobileFrameworksFromNames(['src', 'index.ts', 'README.md'], null);
    expect(result).toHaveLength(0);
    expect(isMobileProject(result)).toBe(false);
  });

  it('est insensible à la casse des noms de fichiers', () => {
    const result = detectMobileFrameworksFromNames(['PUBSPEC.YAML'], null);
    expect(result.map(f => f.id)).toContain('flutter');
  });
});

describe('MOBILE_ICON_KEYS', () => {
  it('expose uniquement des clés non vides et dédupliquées', () => {
    expect(MOBILE_ICON_KEYS.length).toBeGreaterThan(0);
    expect(new Set(MOBILE_ICON_KEYS).size).toBe(MOBILE_ICON_KEYS.length);
    for (const key of MOBILE_ICON_KEYS) expect(key.length).toBeGreaterThan(0);
  });
});
