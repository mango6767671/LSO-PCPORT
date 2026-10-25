import test from "node:test";
import assert from "node:assert/strict";
import {
  hashOpaqueToken,
  normalizeDisplayName,
  normalizeEmail,
  passwordIsValid,
  safeStringEqual,
} from "../../src/pcPort/security.js";

test("normalizes email consistently", () => {
  assert.equal(normalizeEmail("  Player@Example.COM "), "player@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("x".repeat(260) + "@example.com"), null);
});

test("validates display names without accepting markup", () => {
  assert.equal(normalizeDisplayName("  Player   One "), "Player One");
  assert.equal(normalizeDisplayName("ab"), null);
  assert.equal(normalizeDisplayName("<script>"), null);
  assert.equal(normalizeDisplayName("a".repeat(25)), null);
});

test("enforces bounded password lengths", () => {
  assert.equal(passwordIsValid("a-secure-password"), true);
  assert.equal(passwordIsValid("short"), false);
  assert.equal(passwordIsValid("x".repeat(73)), false);
  assert.equal(passwordIsValid("🔐".repeat(19)), false);
  assert.equal(passwordIsValid(null), false);
});

test("token hashes are deterministic and do not reveal input", () => {
  const first = hashOpaqueToken("opaque-test-token");
  assert.equal(first, hashOpaqueToken("opaque-test-token"));
  assert.notEqual(first, "opaque-test-token");
  assert.notEqual(first, hashOpaqueToken("another-token"));
});

test("constant-time equality helper rejects mismatches", () => {
  assert.equal(safeStringEqual("same", "same"), true);
  assert.equal(safeStringEqual("same", "else"), false);
  assert.equal(safeStringEqual("same", "short"), false);
  assert.equal(safeStringEqual(null, "same"), false);
});
