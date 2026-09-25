import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_COMMAND_ID_LENGTH,
  isAgentHello,
  isAgentMessage,
  isBrowserCommand,
  isCommandId,
} from "../src/shared/protocol.js";

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
  assert.equal(isAgentMessage({ v: 1, type: "command_result", instanceId: "agent-1", commandId: "", ok: true }), false);
});

test("command IDs are non-empty and bounded", () => {
  const validCommand = {
    v: 1,
    type: "command",
    instanceId: "agent-1",
    commandId: "command-1",
    command: "snapshot",
  };

  assert.equal(isCommandId("command-1"), true);
  assert.equal(isCommandId(""), false);
  assert.equal(isCommandId("x".repeat(MAX_COMMAND_ID_LENGTH + 1)), false);
  assert.equal(isBrowserCommand(validCommand), true);
  assert.equal(isBrowserCommand({ ...validCommand, commandId: "" }), false);
});
