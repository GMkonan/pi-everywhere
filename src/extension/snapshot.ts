import type { AgentMeta, AgentSnapshot } from "../shared/protocol.ts";
import { toWireValue } from "./safe-serialize.ts";

export const MAX_HISTORY_ENTRIES = 200;
export const MAX_HISTORY_BYTES = 1_500_000;

interface SnapshotOptions {
  capturedAt?: number;
  maxEntries?: number;
  maxBytes?: number;
}

/** Build an authoritative active-branch snapshot while retaining newest entries. */
export function buildBoundedSnapshot(
  meta: AgentMeta,
  branch: unknown[],
  options: SnapshotOptions = {},
): AgentSnapshot {
  const maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_HISTORY_BYTES;
  const serialized = toWireValue(branch.slice(-maxEntries));
  const candidates = Array.isArray(serialized) ? serialized : [];
  const entries: unknown[] = [];
  let bytes = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    const encoded = JSON.stringify(entry) ?? "null";
    const entryBytes = Buffer.byteLength(encoded, "utf8");
    if (bytes + entryBytes > maxBytes) break;
    entries.unshift(entry);
    bytes += entryBytes;
  }

  const omittedEntries = branch.length - entries.length;
  return {
    meta,
    entries,
    capturedAt: options.capturedAt ?? Date.now(),
    ...(omittedEntries > 0 ? { historyTruncated: true, omittedEntries } : {}),
  };
}
