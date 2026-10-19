import { describe, expect, it } from 'vitest';
import { checkPrerequisites, describeMissing } from './guard';

describe('checkPrerequisites', () => {
  it('satisfait une extension sans dépendance', () => {
    expect(checkPrerequisites({}, ['acme.core'])).toEqual({ satisfied: true, missing: [] });
    expect(checkPrerequisites({ extension_dependencies: [] }, [])).toEqual({ satisfied: true, missing: [] });
  });

  it('détecte une dépendance manquante', () => {
    const status = checkPrerequisites({ extension_dependencies: ['acme.core'] }, ['other.ext']);
    expect(status.satisfied).toBe(false);
    expect(status.missing).toEqual(['acme.core']);
  });

  it('ne signale rien quand toutes les dépendances sont installées', () => {
    const status = checkPrerequisites(
      { extension_dependencies: ['acme.core', 'acme.langpack'] },
      ['acme.core', 'acme.langpack', 'unrelated'],
    );
    expect(status.satisfied).toBe(true);
    expect(status.missing).toEqual([]);
  });

  it('ne signale que les dépendances réellement absentes', () => {
    const status = checkPrerequisites(
      { extension_dependencies: ['acme.core', 'acme.langpack'] },
      ['acme.core'],
    );
    expect(status.satisfied).toBe(false);
    expect(status.missing).toEqual(['acme.langpack']);
  });

  it('compare les ids sans tenir compte de la casse (normalisation VS Code)', () => {
    const status = checkPrerequisites({ extension_dependencies: ['Acme.Core'] }, ['acme.core']);
    expect(status.satisfied).toBe(true);
  });
});

describe('describeMissing', () => {
  it('renvoie une phrase vide quand il n’y a rien à signaler', () => {
    expect(describeMissing([])).toBe('');
  });

  it('liste les ids manquants', () => {
    expect(describeMissing(['acme.core', 'acme.langpack'])).toBe('Requires: acme.core, acme.langpack');
  });
});
