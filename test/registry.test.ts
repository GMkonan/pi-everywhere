import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import { AgentRegistry } from "../src/server/registry.js";
import type { AgentSnapshot } from "../src/shared/protocol.js";

function snapshot(instanceId: string, idle = true, entries: unknown[] = [], sessionId = "session"): AgentSnapshot {
  return {
    meta: {
      instanceId,
      pid: 123,
      cwd: "/tmp/project",
      sessionId,
      thinkingLevel: "medium",
      idle,
    },
    entries,
    capturedAt: Date.now(),
  };
}

test("registry removes only the currently registered socket", () => {
  const registry = new AgentRegistry();
  const oldSocket = new Socket();
  const newSocket = new Socket();

  registry.upsert("agent", oldSocket, snapshot("agent"));
  registry.upsert("agent", newSocket, snapshot("agent", false));

  assert.equal(registry.remove("agent", oldSocket), false);
  assert.equal(registry.get("agent")?.socket, newSocket);
  assert.equal(registry.get("agent")?.snapshot.meta.idle, false);
  assert.equal(registry.remove("agent", newSocket), true);
  assert.equal(registry.get("agent"), undefined);
});

test("heartbeat updates liveness without replacing the snapshot", () => {
  const registry = new AgentRegistry();
  const socket = new Socket();
  const record = registry.upsert("agent", socket, snapshot("agent"));
  const before = record.lastSeenAt;

  const updated = registry.heartbeat("agent", socket, false);
  assert.equal(updated?.snapshot.meta.idle, false);
  assert.ok((updated?.lastSeenAt ?? 0) >= before);
  socket.destroy();
});

test("registry summaries preserve activity metadata without exposing history", () => {
  const registry = new AgentRegistry();
  const socket = new Socket();
  const record = registry.upsert("agent", socket, snapshot("agent", true, [
    { type: "message", message: { timestamp: 100 } },
  ]));

  assert.equal(record.lastActivityAt, 100);
  assert.equal(registry.touchActivity("agent", socket, { type: "message_end", timestamp: 200 }, 300), true);
  const summary = registry.listSummaries()[0];
  assert.equal(summary?.lastActivityAt, 200);
  assert.deepEqual(summary?.snapshot.entries, []);
  assert.equal(summary?.historyLoaded, false);
  assert.equal(registry.toPublic(record).snapshot.entries.length, 1);
  record.latestSequence = 7;
  registry.updateSnapshot("agent", socket, snapshot("agent", true, [{ timestamp: 250 }]));
  assert.equal(registry.toPublic(record).snapshotSequence, 7);
  socket.destroy();
});

test("session replacement does not inherit the prior conversation activity", () => {
  const registry = new AgentRegistry();
  const oldSocket = new Socket();
  const newSocket = new Socket();
  const original = registry.upsert("agent", oldSocket, snapshot("agent", true, [{ timestamp: 1_000 }], "session-a"));

  const replacement = registry.upsert(
    "agent",
    newSocket,
    snapshot("agent", true, [{ timestamp: 100 }], "session-b"),
  );

  assert.equal(replacement.lastActivityAt, 100);
  assert.ok(replacement.generation > original.generation);
  oldSocket.destroy();
  newSocket.destroy();
});

test("registry evicts only records older than the heartbeat deadline", () => {
  const registry = new AgentRegistry();
  const staleSocket = new Socket();
  const currentSocket = new Socket();
  const stale = registry.upsert("stale", staleSocket, snapshot("stale"));
  const current = registry.upsert("current", currentSocket, snapshot("current"));
  stale.lastSeenAt = 100;
  current.lastSeenAt = 200;

  const evicted = registry.evictStale(150);

  assert.deepEqual(evicted.map((record) => record.instanceId), ["stale"]);
  assert.equal(registry.get("stale"), undefined);
  assert.equal(registry.get("current")?.socket, currentSocket);
  staleSocket.destroy();
  currentSocket.destroy();
});
