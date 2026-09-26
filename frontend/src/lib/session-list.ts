import type { LiveAgent } from "./types";

export interface SessionGroup {
  key: string;
  label: string;
  agents: LiveAgent[];
}

export function agentActivityAt(agent: LiveAgent): number {
  let latestEntry = 0;
  for (const value of agent.snapshot?.entries ?? []) {
    const entry = asRecord(value);
    const message = asRecord(entry?.message);
    latestEntry = Math.max(
      latestEntry,
      finiteTimestamp(message?.timestamp) ?? 0,
      finiteTimestamp(entry?.timestamp) ?? 0,
    );
  }
  return Math.max(finiteTimestamp(agent.lastActivityAt) ?? 0, latestEntry)
    || finiteTimestamp(agent.connectedAt)
    || 0;
}

export function groupAgentsByDate(values: Iterable<LiveAgent>, now = Date.now()): SessionGroup[] {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const daysAgo = (days: number): number => {
    const boundary = new Date(today);
    boundary.setDate(boundary.getDate() - days);
    return boundary.getTime();
  };
  const groups: Array<SessionGroup & { minimum: number }> = [
    { key: "today", label: "Today", minimum: today, agents: [] },
    { key: "yesterday", label: "Yesterday", minimum: daysAgo(1), agents: [] },
    { key: "week", label: "Previous 7 days", minimum: daysAgo(7), agents: [] },
    { key: "month", label: "Previous 30 days", minimum: daysAgo(30), agents: [] },
    { key: "older", label: "Older", minimum: Number.NEGATIVE_INFINITY, agents: [] },
  ];

  for (const agent of sortAgentsByActivity(values)) {
    const timestamp = agentActivityAt(agent);
    const group = groups.find((candidate) => timestamp >= candidate.minimum) ?? groups.at(-1);
    group?.agents.push(agent);
  }
  return groups
    .filter((group) => group.agents.length > 0)
    .map(({ minimum: _minimum, ...group }) => group);
}

export function formatActivityTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (!timestamp || elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function sessionName(agent: LiveAgent): string {
  return agent.meta.sessionName || basename(agent.meta.cwd) || `Pi ${agent.meta.pid}`;
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function sortAgentsByActivity(values: Iterable<LiveAgent>): LiveAgent[] {
  return [...values].sort((left, right) => (
    agentActivityAt(right) - agentActivityAt(left)
    || String(left.meta.sessionName ?? left.meta.cwd).localeCompare(String(right.meta.sessionName ?? right.meta.cwd))
    || left.instanceId.localeCompare(right.instanceId)
  ));
}

function finiteTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
