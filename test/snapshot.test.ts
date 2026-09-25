import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_HISTORY_ENTRIES,
  buildBoundedSnapshot,
} from "../src/extension/snapshot.js";
import type { AgentMeta } from "../src/shared/protocol.js";

const meta: AgentMeta = {
  instanceId: "agent",
  pid: 1,
  cwd: "/tmp/project",
  sessionId: "session",
  thinkingLevel: "off",
  idle: true,
};

test("buildBoundedSnapshot retains only the newest entry-count budget", () => {
  const branch = Array.from({ length: 250 }, (_, id) => ({ id }));
  const snapshot = buildBoundedSnapshot(meta, branch, { capturedAt: 123 });

  assert.equal(snapshot.entries.length, MAX_HISTORY_ENTRIES);
  assert.equal((snapshot.entries[0] as { id: number }).id, 50);
  assert.equal((snapshot.entries.at(-1) as { id: number }).id, 249);
  assert.equal(snapshot.capturedAt, 123);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.omittedEntries, 50);
});

test("buildBoundedSnapshot retains newest entries within the encoded-byte budget", () => {
  const branch = Array.from({ length: 3 }, (_, id) => ({ id, text: "x".repeat(100) }));
  const snapshot = buildBoundedSnapshot(meta, branch, { maxBytes: 250 });

  assert.deepEqual(snapshot.entries.map((entry) => (entry as { id: number }).id), [1, 2]);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.omittedEntries, 1);
});

test("buildBoundedSnapshot omits history when the newest entry exceeds the budget", () => {
  const branch = [{ id: 1, text: "x".repeat(100) }];
  const snapshot = buildBoundedSnapshot(meta, branch, { maxBytes: 50 });

  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.historyTruncated, true);
  assert.equal(snapshot.omittedEntries, 1);
});

test("buildBoundedSnapshot sanitizes unusual entries and stays below the transport cap", () => {
  const cyclic: Record<string, unknown> = { date: new Date(Number.NaN) };
  cyclic.self = cyclic;
  const branch: unknown[] = [];
  for (let id = 0; id < 200; id += 1) {
    branch.push({ id, text: "x".repeat(20_000) });
  }
  branch.push(cyclic);

  const snapshot = buildBoundedSnapshot(meta, branch);
  const encoded = JSON.stringify({ v: 1, type: "snapshot", instanceId: "agent", snapshot });
  const serializedCyclic = snapshot.entries.at(-1) as Record<string, unknown>;

  assert.doesNotThrow(() => JSON.parse(encoded));
  assert.equal(serializedCyclic.date, "[Invalid Date]");
  assert.equal(serializedCyclic.self, "[circular]");
  assert.equal(snapshot.historyTruncated, true);
  assert.ok(Buffer.byteLength(encoded, "utf8") < 2 * 1024 * 1024);
});
