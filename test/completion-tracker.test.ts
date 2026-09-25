import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionTracker } from "../src/server/completion-tracker.ts";

test("completion tracker emits once for each working to settled transition", () => {
  const tracker = new CompletionTracker();
  try {
    assert.equal(tracker.connected("agent", true), false);
    assert.equal(tracker.settled("agent"), false);

    tracker.started("agent");
    assert.equal(tracker.settled("agent"), true);
    assert.equal(tracker.settled("agent"), false);

    tracker.started("agent");
    tracker.started("agent");
    assert.equal(tracker.settled("agent"), true);
  } finally {
    tracker.dispose();
  }
});

test("completion tracker preserves working state across a short bridge reconnect", () => {
  const tracker = new CompletionTracker(1_000);
  try {
    tracker.connected("agent", false);
    tracker.disconnected("agent");
    assert.equal(tracker.connected("agent", false), false);
    assert.equal(tracker.settled("agent"), true);

    tracker.started("agent");
    tracker.disconnected("agent");
    assert.equal(tracker.connected("agent", true), true);
    assert.equal(tracker.settled("agent"), false);
  } finally {
    tracker.dispose();
  }
});
