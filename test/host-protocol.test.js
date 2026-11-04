import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_ID_PATTERN,
  COMMAND_ID_PATTERN,
  MAX_PENDING_COMMANDS,
  MAX_POLL_WAITERS,
  MAX_REQUEST_BYTES,
  validEvent,
  validResult,
} from "../host-protocol.js";

test("protocol limits and identifier patterns expose bounded values", () => {
  assert.equal(CLIENT_ID_PATTERN.test("client-1234567890abcd"), true);
  assert.equal(CLIENT_ID_PATTERN.test("short"), false);
  assert.equal(CLIENT_ID_PATTERN.test("client_with_underscores-123"), false);
  assert.equal(COMMAND_ID_PATTERN.test("0"), true);
  assert.equal(COMMAND_ID_PATTERN.test("123456789012"), true);
  assert.equal(COMMAND_ID_PATTERN.test("1234567890123"), false);
  assert.equal(MAX_REQUEST_BYTES, 64 * 1024);
  assert.equal(MAX_PENDING_COMMANDS, 64);
  assert.equal(MAX_POLL_WAITERS, 16);
});

test("validResult accepts well-formed success and failure results", () => {
  assert.equal(validResult({ id: "123", ok: true }), true);
  assert.equal(validResult({ id: "123", ok: true, value: null }), true);
  assert.equal(validResult({ id: "123", ok: true, value: { title: "Example" } }), true);
  assert.equal(validResult({ id: "123", ok: false }), true);
  assert.equal(validResult({ id: "123", ok: false, error: { message: "failed" } }), true);
});

test("validResult rejects malformed envelopes and scalar result bodies", () => {
  for (const body of [
    null,
    undefined,
    [],
    "result",
    {},
    { id: 1, ok: true },
    { id: "x".repeat(13), ok: true },
    { id: "123", ok: "true" },
    { id: "123", ok: true, value: "not-an-object" },
    { id: "123", ok: false, error: "failed" },
  ]) {
    assert.equal(validResult(body), false, `expected rejection for ${JSON.stringify(body)}`);
  }
});

test("validEvent accepts supported state and tab events", () => {
  assert.equal(validEvent({ kind: "new" }), true);
  assert.equal(validEvent({ kind: "switch", tabId: "tab-1" }), true);
  assert.equal(validEvent({ kind: "close", tabId: "tab-1" }), true);
  assert.equal(validEvent({ kind: "tab-update", tabId: "tab-1" }), true);
  assert.equal(validEvent({
    kind: "tab-update",
    tabId: "tab-1",
    url: "https://example.test/path",
    title: "Example",
    loading: false,
    canGoBack: true,
    canGoForward: false,
    crashed: false,
    navigated: true,
    reloaded: false,
    snapshot: { text: "Example page" },
  }), true);
});

test("validEvent rejects unsupported events and invalid field types or bounds", () => {
  for (const event of [
    null,
    undefined,
    [],
    "switch",
    { kind: "unknown" },
    { kind: "switch" },
    { kind: "switch", tabId: "x".repeat(65) },
    { kind: "tab-update", tabId: "tab-1", url: "x".repeat(8193) },
    { kind: "tab-update", tabId: "tab-1", title: "x".repeat(513) },
    { kind: "tab-update", tabId: "tab-1", loading: "false" },
    { kind: "tab-update", tabId: "tab-1", canGoBack: 1 },
    { kind: "tab-update", tabId: "tab-1", canGoForward: null },
    { kind: "tab-update", tabId: "tab-1", crashed: "no" },
    { kind: "tab-update", tabId: "tab-1", navigated: 1 },
    { kind: "tab-update", tabId: "tab-1", reloaded: "yes" },
    { kind: "tab-update", tabId: "tab-1", snapshot: null },
  ]) {
    assert.equal(validEvent(event), false, `expected rejection for ${JSON.stringify(event)}`);
  }
});
