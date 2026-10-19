import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser, updateUser, validateUserInput } from "../src/user.mjs";

test("validateUserInput returns trimmed fields", () => {
  assert.deepEqual(validateUserInput({ name: " Ada ", email: " a@b.c " }), {
    name: "Ada",
    email: "a@b.c",
  });
});

test("validateUserInput rejects non-object input", () => {
  assert.throws(() => validateUserInput(null), /invalid input/);
});

test("validateUserInput rejects empty fields", () => {
  assert.throws(() => validateUserInput({ name: "  ", email: "a@b.c" }), /fields must be strings/);
});

test("createUser builds a user from valid input", () => {
  assert.deepEqual(createUser({ name: "Ada", email: "a@b.c" }), { name: "Ada", email: "a@b.c" });
});

test("updateUser merges and validates", () => {
  const updated = updateUser({ name: "Ada", email: "a@b.c" }, { name: " Grace ", email: "g@h.i" });
  assert.deepEqual(updated, { name: "Grace", email: "g@h.i" });
});
