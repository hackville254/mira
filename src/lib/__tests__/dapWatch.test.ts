import { describe, it, expect } from 'vitest';
import {
  toSourceBreakpoints,
  isLogPoint,
  isConditional,
  fromEvaluate,
  addWatch,
  removeWatch,
  type WatchEntry,
} from '../dapWatch';

describe('toSourceBreakpoints', () => {
  it('ne conserve que la ligne quand aucun qualificatif n\'est fourni', () => {
    const out = toSourceBreakpoints([{ line: 3, verified: false }]);
    expect(out).toEqual([{ line: 3 }]);
  });

  it('inclut condition / hitCondition / logMessage quand renseignés', () => {
    const out = toSourceBreakpoints([
      { line: 10, verified: true, condition: ' i === 5 ', hitCondition: '3', logMessage: 'valeur={i}' },
    ]);
    expect(out[0]).toEqual({ line: 10, condition: 'i === 5', hitCondition: '3', logMessage: 'valeur={i}' });
  });

  it('ignore les chaînes vides ou espaces (évite une condition toujours vraie)', () => {
    const out = toSourceBreakpoints([{ line: 1, verified: false, condition: '   ', logMessage: '' }]);
    expect(out[0]).toEqual({ line: 1 });
  });

  it('préserve l\'ordre et toutes les entrées', () => {
    const out = toSourceBreakpoints([
      { line: 1, verified: false },
      { line: 2, verified: false, condition: 'x>0' },
      { line: 3, verified: false },
    ]);
    expect(out.map(b => b.line)).toEqual([1, 2, 3]);
  });
});

describe('isLogPoint / isConditional', () => {
  it('détecte un log point', () => {
    expect(isLogPoint({ line: 1, verified: false, logMessage: 'hello' })).toBe(true);
    expect(isLogPoint({ line: 1, verified: false, logMessage: '  ' })).toBe(false);
    expect(isLogPoint({ line: 1, verified: false })).toBe(false);
  });

  it('détecte un breakpoint conditionnel (condition ou hit count)', () => {
    expect(isConditional({ line: 1, verified: false, condition: 'a' })).toBe(true);
    expect(isConditional({ line: 1, verified: false, hitCondition: '>2' })).toBe(true);
    expect(isConditional({ line: 1, verified: false })).toBe(false);
  });
});

describe('fromEvaluate', () => {
  it('extrait résultat, type et variablesReference', () => {
    const w = fromEvaluate('x', { result: '42', type: 'int', variablesReference: 0 });
    expect(w.expression).toBe('x');
    expect(w.value).toBe('42');
    expect(w.type).toBe('int');
    expect(w.variablesReference).toBe(0);
    expect(w.error).toBeUndefined();
  });

  it('capture une erreur d\'évaluation', () => {
    const w = fromEvaluate('bogus()', { success: false, message: 'not defined' });
    expect(w.error).toBe('not defined');
    expect(w.value).toBeUndefined();
  });

  it('gère une réponse absente', () => {
    expect(fromEvaluate('x', null).error).toBe('no result');
    expect(fromEvaluate('x', undefined).error).toBe('no result');
  });

  it('convertit un résultat non-chaîne en chaîne', () => {
    expect(fromEvaluate('x', { result: 123, variablesReference: 7 }).value).toBe('123');
  });
});

describe('addWatch / removeWatch', () => {
  it('ajoute une expression trimée', () => {
    expect(addWatch([], '  a.b  ')).toEqual([{ expression: 'a.b' }]);
  });

  it('ignore une expression vide', () => {
    const list: WatchEntry[] = [{ expression: 'x' }];
    expect(addWatch(list, '   ')).toBe(list);
  });

  it('remonte une expression existante sans doublon (résultat précédent purgé)', () => {
    const list: WatchEntry[] = [{ expression: 'a', value: '1' }, { expression: 'b', value: '2' }];
    const out = addWatch(list, 'a');
    expect(out).toEqual([{ expression: 'b', value: '2' }, { expression: 'a' }]);
  });

  it('retire une expression', () => {
    const list: WatchEntry[] = [{ expression: 'a' }, { expression: 'b' }];
    expect(removeWatch(list, 'a')).toEqual([{ expression: 'b' }]);
  });
});
