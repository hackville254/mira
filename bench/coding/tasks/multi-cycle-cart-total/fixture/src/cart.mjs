// Module panier — totalisation d'une commande.
// Deux bugs se masquent mutuellement : corriger la taxe révèle un arrondi faux,
// corriger l'arrondi révèle la remise mal appliquée. Les tests décrivent la cible.

/**
 * Calcule le total d'un panier en centimes.
 * @param {Array<{price:number, qty:number}>} items
 * @param {{discountPct?:number, taxPct?:number}} opts
 */
export function totalCents(items, opts = {}) {
  const discountPct = opts.discountPct ?? 0;
  const taxPct = opts.taxPct ?? 0;
  let subtotal = 0;
  for (const it of items) subtotal += it.price * it.qty;
  // BUG 1 : la remise est appliquée APRÈS la taxe (elle doit s'appliquer avant).
  const taxed = subtotal * (1 + taxPct / 100);
  const discounted = taxed * (1 - discountPct / 100);
  return Math.floor(discounted);
}
