import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.mjs";

test("parseConfig ignores blank lines and comments", () => {
  const cfg = parseConfig("# comment\n\nport=8080\nhost=localhost\n");
  assert.deepEqual(cfg, { port: 8080, host: "localhost" });
});

test("parseConfig trims keys and values", () => {
  const cfg = parseConfig("  port = 8080  \n");
  assert.deepEqual(cfg, { port: 8080 });
});

test("parseConfig returns numeric values as numbers", () => {
  const cfg = parseConfig("retries=3\nratio=1.5\n");
  assert.equal(cfg.retries, 3);
  assert.equal(cfg.ratio, 1.5);
});