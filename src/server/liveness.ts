import { AgentRegistry } from "./registry.js";

interface LivenessEffects {
  disconnected: (instanceId: string) => void;
  failPending: (instanceId: string, error: string) => void;
  removed: (instanceId: string) => void;
}

export function evictStaleAgents(
  registry: AgentRegistry,
  staleBefore: number,
  effects: LivenessEffects,
): string[] {
  const removed: string[] = [];
  for (const record of registry.evictStale(staleBefore)) {
    effects.disconnected(record.instanceId);
    effects.failPending(record.instanceId, "Pi process heartbeat timed out");
    record.socket.destroy();
    effects.removed(record.instanceId);
    removed.push(record.instanceId);
  }
  return removed;
}
