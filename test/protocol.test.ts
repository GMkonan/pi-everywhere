import assert from "node:assert/strict";
import { test } from "node:test";
import { isAgentHello, isAgentMessage } from "../src/shared/protocol.js";

const validHello = {
  v: 1,
  type: "hello",
  instanceId: "agent-1",
  snapshot: {
    meta: {
      instanceId: "agent-1",
      pid: 42,
      cwd: "/tmp/project",
      sessionId: "session-1",
      thinkingLevel: "medium",
      idle: true,
    },
    entries: [],
    capturedAt: Date.now(),
  },
};

test("agent hello requires a matching and structurally valid snapshot", () => {
  assert.equal(isAgentHello(validHello), true);
  assert.equal(isAgentHello({ ...validHello, snapshot: {} }), false);
  assert.equal(
    isAgentHello({
      ...validHello,
      snapshot: { ...validHello.snapshot, meta: { ...validHello.snapshot.meta, instanceId: "other" } },
    }),
    false,
  );
});

test("agent message guards validate discriminated fields", () => {
  assert.equal(isAgentMessage({ v: 1, type: "heartbeat", instanceId: "agent-1", idle: true, timestamp: 1 }), true);
  assert.equal(isAgentMessage({ v: 1, type: "heartbeat", instanceId: "agent-1", idle: "yes", timestamp: 1 }), false);
  assert.equal(isAgentMessage({ v: 1, type: "snapshot", instanceId: "agent-1", snapshot: {} }), false);
});
