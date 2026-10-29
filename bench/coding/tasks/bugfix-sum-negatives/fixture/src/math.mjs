// Mini-projet isolé — tâche bugfix-sum-negatives.
// Bug volontaire : les opérandes négatifs sont ramenés à 0.

export function sum(a, b) {
  const x = a < 0 ? 0 : a;
  const y = b < 0 ? 0 : b;
  return x + y;
}
