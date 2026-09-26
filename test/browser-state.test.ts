import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBrowserHistoryMessage,
  buildBrowserStateMessages,
  buildLegacyBrowserStateMessages,
} from "../src/server/browser-state.js";
import type { PublicAgent, PublicAgentSummary } from "../src/server/registry.js";

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
    lastActivityAt: 1,
    snapshotSequence: 0,
    generation: 1,
  };
}

function summary(source: PublicAgent): PublicAgentSummary {
  return {
    ...source,
    historyLoaded: false,
    snapshot: { ...source.snapshot, entries: [] },
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

test("browser state contains only lightweight summaries and remains frame bounded", () => {
  const first = summary(agent("agent-a", [{ text: "a".repeat(1000) }]));
  const second = summary(agent("agent-b", [{ text: "b".repeat(1000) }]));
  const maximumBytes = bytes(buildBrowserStateMessages([first], 10_000)[0]) + 10;

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
  assert.ok(messages.every((message) => message.agents.every((item) => item.snapshot.entries.length === 0)));
  assert.ok(messages.every((message) => bytes(message) <= maximumBytes));
});

test("legacy browser state retains eager history during the capability migration", () => {
  const source = agent("agent", [{ text: "history" }]);
  const messages = buildLegacyBrowserStateMessages([source], 10_000);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.complete, true);
  assert.deepEqual(messages[0]?.agents[0]?.snapshot.entries, [{ text: "history" }]);
});

test("on-demand history trims oldest snapshot entries when its frame exceeds the budget", () => {
  const entries = Array.from({ length: 4 }, (_, id) => ({ id, text: "x".repeat(300) }));
  const source = agent("agent", entries);
  const oneEntry = agent("agent", [entries[3]]);
  oneEntry.snapshot.historyTruncated = true;
  oneEntry.snapshot.omittedEntries = 3;
  const maximumBytes = bytes(buildBrowserHistoryMessage(oneEntry, "request", 10_000)) + 5;

  const message = buildBrowserHistoryMessage(source, "request", maximumBytes);

  assert.ok(bytes(message) <= maximumBytes);
  assert.deepEqual(message.agent.snapshot.entries, [entries[3]]);
  assert.equal(message.agent.snapshot.historyTruncated, true);
  assert.equal(message.agent.snapshot.omittedEntries, 3);
  assert.equal(message.agent.historyLoaded, true);
});
