import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.mjs";

// PASS_TO_PASS : passent déjà, ne doivent pas régresser.

test("range builds an inclusive-start sequence", () => {
  assert.deepEqual(range(0, 2), [0, 1]);
  assert.deepEqual(range(2, 4), [2, 3]);
});

test("range on an empty interval yields no element", () => {
  assert.deepEqual(range(4, 4), []);
});

// FAIL_TO_PASS : échoue tant que la borne de fin est incluse à tort sur les
// intervalles de longueur 3.
test("range is exclusive of the end bound", () => {
  assert.deepEqual(range(1, 4), [1, 2, 3]);
  assert.equal(range(1, 4).includes(4), false);
});
