import type { Socket } from "node:net";
import type { AgentMeta, AgentSnapshot } from "../shared/protocol.js";

export interface AgentRecord {
  instanceId: string;
  socket: Socket;
  snapshot: AgentSnapshot;
  connectedAt: number;
  lastSeenAt: number;
  lastActivityAt: number;
  latestSequence: number;
  snapshotSequence: number;
  generation: number;
}

export interface PublicAgent {
  instanceId: string;
  meta: AgentMeta;
  snapshot: AgentSnapshot;
  connectedAt: number;
  lastSeenAt: number;
  lastActivityAt: number;
  snapshotSequence: number;
  generation: number;
}

export interface PublicAgentSummary extends PublicAgent {
  historyLoaded: false;
}

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();
  private nextGeneration = 0;

  upsert(instanceId: string, socket: Socket, snapshot: AgentSnapshot): AgentRecord {
    const existing = this.records.get(instanceId);
    if (existing && existing.socket !== socket) existing.socket.destroy();

    const now = Date.now();
    const sameSession = existing?.snapshot.meta.sessionId === snapshot.meta.sessionId;
    const record: AgentRecord = {
      instanceId,
      socket,
      snapshot: {
        ...snapshot,
        meta: { ...snapshot.meta, connectedAt: existing?.connectedAt ?? now },
      },
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      lastActivityAt: Math.max(sameSession ? existing?.lastActivityAt ?? 0 : 0, snapshotActivityAt(snapshot)) || now,
      latestSequence: 0,
      snapshotSequence: 0,
      generation: ++this.nextGeneration,
    };
    this.records.set(instanceId, record);
    return record;
  }

  get(instanceId: string): AgentRecord | undefined {
    return this.records.get(instanceId);
  }

  updateSnapshot(instanceId: string, socket: Socket, snapshot: AgentSnapshot): AgentRecord | undefined {
    const record = this.records.get(instanceId);
    if (!record || record.socket !== socket) return undefined;
    const now = Date.now();
    const sameSession = record.snapshot.meta.sessionId === snapshot.meta.sessionId;
    record.snapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, connectedAt: record.connectedAt },
    };
    record.lastSeenAt = now;
    record.lastActivityAt = Math.max(sameSession ? record.lastActivityAt : 0, snapshotActivityAt(snapshot)) || now;
    record.snapshotSequence = record.latestSequence;
    return record;
  }

  touchActivity(instanceId: string, socket: Socket, event: Record<string, unknown>, now = Date.now()): boolean {
    const record = this.records.get(instanceId);
    if (!record || record.socket !== socket || !ACTIVITY_EVENTS.has(String(event.type))) return false;
    record.lastActivityAt = Math.max(record.lastActivityAt, eventActivityAt(event) || now);
    return true;
  }

  heartbeat(instanceId: string, socket: Socket, idle: boolean): AgentRecord | undefined {
    const record = this.records.get(instanceId);
    if (!record || record.socket !== socket) return undefined;
    record.lastSeenAt = Date.now();
    record.snapshot.meta.idle = idle;
    return record;
  }

  remove(instanceId: string, socket: Socket): boolean {
    const record = this.records.get(instanceId);
    if (!record || record.socket !== socket) return false;
    this.records.delete(instanceId);
    return true;
  }

  evictStale(staleBefore: number): AgentRecord[] {
    const evicted: AgentRecord[] = [];
    for (const [instanceId, record] of this.records) {
      if (record.lastSeenAt >= staleBefore) continue;
      this.records.delete(instanceId);
      evicted.push(record);
    }
    return evicted;
  }

  listPublic(): PublicAgent[] {
    return [...this.records.values()]
      .map((record) => this.toPublic(record))
      .sort((a, b) => a.meta.cwd.localeCompare(b.meta.cwd) || a.instanceId.localeCompare(b.instanceId));
  }

  toPublic(record: AgentRecord): PublicAgent {
    return {
      instanceId: record.instanceId,
      meta: record.snapshot.meta,
      snapshot: record.snapshot,
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
      lastActivityAt: record.lastActivityAt,
      snapshotSequence: record.snapshotSequence,
      generation: record.generation,
    };
  }

  toSummary(record: AgentRecord): PublicAgentSummary {
    const agent = this.toPublic(record);
    return {
      ...agent,
      historyLoaded: false,
      snapshot: {
        meta: { ...agent.snapshot.meta },
        entries: [],
        capturedAt: agent.snapshot.capturedAt,
      },
    };
  }

  listSummaries(): PublicAgentSummary[] {
    return [...this.records.values()]
      .map((record) => this.toSummary(record))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.instanceId.localeCompare(b.instanceId));
  }
}

const ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_settled",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
]);

function snapshotActivityAt(snapshot: AgentSnapshot): number {
  let latest = 0;
  for (const value of snapshot.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const message = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
      ? entry.message as Record<string, unknown>
      : undefined;
    latest = Math.max(latest, timestampValue(message?.timestamp), timestampValue(entry.timestamp));
  }
  return latest;
}

function eventActivityAt(event: Record<string, unknown>): number {
  const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : undefined;
  return Math.max(timestampValue(message?.timestamp), timestampValue(event.timestamp));
}

function timestampValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
