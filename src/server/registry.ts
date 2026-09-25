import type { Socket } from "node:net";
import type { AgentMeta, AgentSnapshot } from "../shared/protocol.js";

export interface AgentRecord {
  instanceId: string;
  socket: Socket;
  snapshot: AgentSnapshot;
  connectedAt: number;
  lastSeenAt: number;
}

export interface PublicAgent {
  instanceId: string;
  meta: AgentMeta;
  snapshot: AgentSnapshot;
  connectedAt: number;
  lastSeenAt: number;
}

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();

  upsert(instanceId: string, socket: Socket, snapshot: AgentSnapshot): AgentRecord {
    const existing = this.records.get(instanceId);
    if (existing && existing.socket !== socket) existing.socket.destroy();

    const now = Date.now();
    const record: AgentRecord = {
      instanceId,
      socket,
      snapshot: {
        ...snapshot,
        meta: { ...snapshot.meta, connectedAt: existing?.connectedAt ?? now },
      },
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
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
    record.snapshot = {
      ...snapshot,
      meta: { ...snapshot.meta, connectedAt: record.connectedAt },
    };
    record.lastSeenAt = Date.now();
    return record;
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
    };
  }
}
