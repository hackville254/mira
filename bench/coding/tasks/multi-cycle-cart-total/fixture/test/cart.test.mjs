import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCents } from "../src/cart.mjs";

test("totalCents sums line totals", () => {
  assert.equal(totalCents([{ price: 100, qty: 2 }, { price: 50, qty: 1 }]), 250);
});

test("totalCents applies discount BEFORE tax", () => {
  // 1000 - 10% = 900 ; + 20% tax = 1080
  assert.equal(totalCents([{ price: 1000, qty: 1 }], { discountPct: 10, taxPct: 20 }), 1080);
});

test("totalCents rounds to nearest cent (half up)", () => {
  // 3 * 333 = 999 ; +10% tax = 1098.9 -> rounded 1099
  assert.equal(totalCents([{ price: 333, qty: 3 }], { taxPct: 10 }), 1099);
});
