import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/math.mjs";

test("sum adds two positive numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("sum returns the arithmetic sum with a negative operand", () => {
  assert.equal(sum(-4, 3), -1);
  assert.equal(sum(5, -8), -3);
  assert.equal(sum(-2, -6), -8);
});
