import { test } from "node:test";
import assert from "node:assert/strict";
import { makePost } from "../src/post.mjs";

// PASS_TO_PASS : doit passer AVANT et APRÈS la modification.
test("makePost returns the title and body", () => {
  const p = makePost("Hello World", "content");
  assert.equal(p.title, "Hello World");
  assert.equal(p.body, "content");
});
