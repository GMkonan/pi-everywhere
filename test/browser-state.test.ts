import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrowserStateMessages } from "../src/server/browser-state.js";
import type { PublicAgent } from "../src/server/registry.js";

function agent(instanceId: string, entries: unknown[] = []): PublicAgent {
  const meta = {
    instanceId,
    pid: 1,
    cwd: `/tmp/${instanceId}`,
    sessionId: `session-${instanceId}`,
    thinkingLevel: "off",
    idle: true,
  };
  return {
    instanceId,
    meta,
    snapshot: { meta, entries, capturedAt: 1 },
    connectedAt: 1,
    lastSeenAt: 1,
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("browser state emits one complete reset for an empty registry", () => {
  assert.deepEqual(buildBrowserStateMessages([], 1024), [{
    v: 1,
    type: "state",
    agents: [],
    reset: true,
    complete: true,
  }]);
});

test("browser state splits agents into ordered bounded chunks", () => {
  const first = agent("agent-a", [{ text: "a".repeat(300) }]);
  const second = agent("agent-b", [{ text: "b".repeat(300) }]);
  const singleMessage = buildBrowserStateMessages([first], 10_000)[0];
  assert.ok(singleMessage);
  const maximumBytes = bytes(singleMessage) + 10;

  const messages = buildBrowserStateMessages([first, second], maximumBytes);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.reset, true);
  assert.equal(messages[0]?.complete, false);
  assert.equal(messages[1]?.reset, false);
  assert.equal(messages[1]?.complete, true);
  assert.deepEqual(messages.flatMap((message) => message.agents.map((item) => item.instanceId)), [
    "agent-a",
    "agent-b",
  ]);
  assert.ok(messages.every((message) => bytes(message) <= maximumBytes));
});

test("browser state trims oldest snapshot entries when one agent exceeds the frame budget", () => {
  const entries = Array.from({ length: 4 }, (_, id) => ({ id, text: "x".repeat(300) }));
  const source = agent("agent", entries);
  const oneEntry = agent("agent", [entries[3]]);
  oneEntry.snapshot.historyTruncated = true;
  oneEntry.snapshot.omittedEntries = 3;
  const maximumBytes = bytes(buildBrowserStateMessages([oneEntry], 10_000)[0]) + 5;

  const [message] = buildBrowserStateMessages([source], maximumBytes);
  const fitted = message?.agents[0];

  assert.ok(message);
  assert.ok(bytes(message) <= maximumBytes);
  assert.deepEqual(fitted?.snapshot.entries, [entries[3]]);
  assert.equal(fitted?.snapshot.historyTruncated, true);
  assert.equal(fitted?.snapshot.omittedEntries, 3);
});
