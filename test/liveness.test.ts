import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import { evictStaleAgents } from "../src/server/liveness.js";
import { AgentRegistry } from "../src/server/registry.js";
import type { AgentSnapshot } from "../src/shared/protocol.js";

function snapshot(instanceId: string): AgentSnapshot {
  return {
    meta: {
      instanceId,
      pid: 1,
      cwd: "/tmp/project",
      sessionId: "session",
      thinkingLevel: "off",
      idle: true,
    },
    entries: [],
    capturedAt: 1,
  };
}

test("stale-agent sweep applies disconnect effects exactly once", () => {
  const registry = new AgentRegistry();
  const staleSocket = new Socket();
  const currentSocket = new Socket();
  registry.upsert("stale", staleSocket, snapshot("stale")).lastSeenAt = 100;
  registry.upsert("current", currentSocket, snapshot("current")).lastSeenAt = 200;
  const disconnected: string[] = [];
  const failed: Array<{ instanceId: string; error: string }> = [];
  const removed: string[] = [];

  const firstSweep = evictStaleAgents(registry, 150, {
    disconnected: (instanceId) => disconnected.push(instanceId),
    failPending: (instanceId, error) => failed.push({ instanceId, error }),
    removed: (instanceId) => removed.push(instanceId),
  });
  const secondSweep = evictStaleAgents(registry, 150, {
    disconnected: (instanceId) => disconnected.push(instanceId),
    failPending: (instanceId, error) => failed.push({ instanceId, error }),
    removed: (instanceId) => removed.push(instanceId),
  });

  assert.deepEqual(firstSweep, ["stale"]);
  assert.deepEqual(secondSweep, []);
  assert.deepEqual(disconnected, ["stale"]);
  assert.deepEqual(failed, [{ instanceId: "stale", error: "Pi process heartbeat timed out" }]);
  assert.deepEqual(removed, ["stale"]);
  assert.equal(staleSocket.destroyed, true);
  assert.equal(registry.get("current")?.socket, currentSocket);
  currentSocket.destroy();
});
