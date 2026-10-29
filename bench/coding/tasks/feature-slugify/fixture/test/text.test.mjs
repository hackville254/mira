import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/text.mjs";
import { makePost } from "../src/post.mjs";

// FAIL_TO_PASS : échoue tant que slugify() n'existe pas / n'est pas correct.

test("slugify lowercases and hyphenates", () => {
  assert.equal(slugify("Hello  World"), "hello-world");
  assert.equal(slugify("  Trim Me  "), "trim-me");
});

test("slugify strips accents", () => {
  assert.equal(slugify("Café Crème à l'Île"), "cafe-creme-a-l-ile");
});

test("makePost exposes the slug", () => {
  const p = makePost("Mon Article Été", "x");
  assert.equal(p.slug, "mon-article-ete");
});
