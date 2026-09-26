import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { eventsAfterSnapshot } from "../web/history-sync.js";

test("history synchronization replays only events newer than the snapshot watermark", () => {
  const queued = [
    { sequence: 4, generation: 2, event: { type: "message_end", value: "represented" } },
    { sequence: 5, generation: 2, event: { type: "message_update", value: "newer" } },
    { sequence: 6, generation: 2, event: { type: "tool_execution_start", value: "newest" } },
  ];

  assert.deepEqual(eventsAfterSnapshot(queued, 4, 2), queued.slice(1));
  assert.deepEqual(eventsAfterSnapshot(queued, 6, 2), []);
  assert.deepEqual(eventsAfterSnapshot(queued, undefined, 2), queued);
  assert.deepEqual(eventsAfterSnapshot(queued, 0, 3), []);
});
