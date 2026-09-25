const ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_settled",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
]);

export function agentActivityAt(agent) {
  let latestEntry = 0;
  for (const entry of agent?.snapshot?.entries ?? []) {
    latestEntry = Math.max(
      latestEntry,
      finiteTimestamp(entry?.message?.timestamp) ?? 0,
      finiteTimestamp(entry?.timestamp) ?? 0,
    );
  }
  return Math.max(finiteTimestamp(agent?.lastActivityAt) ?? 0, latestEntry)
    || finiteTimestamp(agent?.connectedAt)
    || 0;
}

export function touchAgentActivity(agent, event, now = Date.now()) {
  if (!agent || !ACTIVITY_EVENTS.has(event?.type)) return false;
  const timestamp = finiteTimestamp(event?.message?.timestamp)
    ?? finiteTimestamp(event?.timestamp)
    ?? now;
  agent.lastActivityAt = Math.max(agentActivityAt(agent), timestamp);
  return true;
}

export function sortAgentsByActivity(values) {
  return [...values].sort((left, right) => (
    agentActivityAt(right) - agentActivityAt(left)
    || String(left?.meta?.sessionName ?? left?.meta?.cwd ?? "").localeCompare(String(right?.meta?.sessionName ?? right?.meta?.cwd ?? ""))
    || String(left?.instanceId ?? "").localeCompare(String(right?.instanceId ?? ""))
  ));
}

export function groupAgentsByDate(values, now = Date.now()) {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const daysAgo = (days) => {
    const boundary = new Date(today);
    boundary.setDate(boundary.getDate() - days);
    return boundary.getTime();
  };
  const groups = [
    { key: "today", label: "Today", minimum: today, agents: [] },
    { key: "yesterday", label: "Yesterday", minimum: daysAgo(1), agents: [] },
    { key: "week", label: "Previous 7 days", minimum: daysAgo(7), agents: [] },
    { key: "month", label: "Previous 30 days", minimum: daysAgo(30), agents: [] },
    { key: "older", label: "Older", minimum: Number.NEGATIVE_INFINITY, agents: [] },
  ];

  for (const agent of sortAgentsByActivity(values)) {
    const timestamp = agentActivityAt(agent);
    const group = groups.find((candidate) => timestamp >= candidate.minimum) ?? groups.at(-1);
    group.agents.push(agent);
  }
  return groups.filter((group) => group.agents.length > 0).map(({ minimum: _minimum, ...group }) => group);
}

export function formatActivityTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp);
  if (!timestamp || elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function finiteTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
