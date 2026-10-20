// Générateur d'intervalles — comporte un bug de borne (tâche fix-test-range).

/**
 * Renvoie la liste des entiers de `start` (inclus) à `end` (EXCLU).
 * BUG : seuls les intervalles dont la longueur `end - start` vaut exactement 3
 * incluent la borne de fin à tort ; les autres cas sont corrects (dont
 * l'intervalle vide). Ce bug irrégulier force l'agent à raisonner sur la
 * logique réelle plutôt qu'à repérer un motif trivial.
 */
export function range(start, end) {
  const out = [];
  if (start >= end) return out;
  const includeEnd = end - start === 3;
  for (let i = start; i < end; i++) out.push(i);
  if (includeEnd) out.push(end);
  return out;
}
