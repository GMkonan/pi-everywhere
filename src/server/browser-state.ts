import { PROTOCOL_VERSION } from "../shared/protocol.js";
import type { PublicAgent, PublicAgentSummary } from "./registry.js";

type BrowserStateAgent = PublicAgentSummary | (PublicAgent & { historyLoaded: true });

export interface BrowserStateMessage {
  v: typeof PROTOCOL_VERSION;
  type: "state";
  agents: BrowserStateAgent[];
  reset: boolean;
  complete: boolean;
}

export interface BrowserHistoryMessage {
  v: typeof PROTOCOL_VERSION;
  type: "agent_history";
  instanceId: string;
  requestId: string;
  agent: PublicAgent & { historyLoaded: true };
}

/** Build an ordered, metadata-only registry transfer bounded per WebSocket frame. */
export function buildBrowserStateMessages(
  agents: PublicAgentSummary[],
  maximumBytes: number,
): BrowserStateMessage[] {
  if (maximumBytes <= 0) throw new Error("Browser state byte budget must be positive");
  if (agents.length === 0) return [stateMessage([], true, true)];

  const chunks = packSummaries(agents, maximumBytes);
  return chunks.map((chunk, index) => stateMessage(
    chunk,
    index === 0,
    index === chunks.length - 1,
  ));
}

/** Build the eager full state used temporarily by controllers without lazy-history support. */
export function buildLegacyBrowserStateMessages(
  agents: PublicAgent[],
  maximumBytes: number,
): BrowserStateMessage[] {
  if (maximumBytes <= 0) throw new Error("Browser state byte budget must be positive");
  if (agents.length === 0) return [stateMessage([], true, true)];
  const fitted = agents.map((agent) => buildBrowserHistoryMessage(agent, "legacy", maximumBytes).agent);
  const chunks = packAgents(fitted, maximumBytes);
  return chunks.map((chunk, index) => stateMessage(chunk, index === 0, index === chunks.length - 1));
}

/** Build one on-demand history response, trimming only if its transport envelope requires it. */
export function buildBrowserHistoryMessage(
  agent: PublicAgent,
  requestId: string,
  maximumBytes: number,
): BrowserHistoryMessage {
  if (maximumBytes <= 0) throw new Error("Browser history byte budget must be positive");
  const message = historyMessage(agent, requestId);
  if (encodedBytes(message) <= maximumBytes) return message;

  const sourceEntries = agent.snapshot.entries;
  let minimum = 0;
  let maximum = sourceEntries.length;
  let best: BrowserHistoryMessage | undefined;
  while (minimum <= maximum) {
    const keep = Math.floor((minimum + maximum) / 2);
    const candidate = historyMessage(withNewestEntries(agent, keep), requestId);
    if (encodedBytes(candidate) <= maximumBytes) {
      best = candidate;
      minimum = keep + 1;
    } else {
      maximum = keep - 1;
    }
  }
  if (!best) throw new Error(`Agent ${agent.instanceId} metadata exceeds the browser history budget`);
  return best;
}

function packSummaries(agents: PublicAgentSummary[], maximumBytes: number): PublicAgentSummary[][] {
  return packAgents(agents, maximumBytes);
}

function packAgents<T extends BrowserStateAgent>(agents: T[], maximumBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];

  for (const agent of agents) {
    if (encodedBytes(stateMessage([agent], false, false)) > maximumBytes) {
      throw new Error(`Agent ${agent.instanceId} metadata exceeds the browser state budget`);
    }
    const candidate = [...current, agent];
    if (current.length > 0 && encodedBytes(stateMessage(candidate, false, false)) > maximumBytes) {
      chunks.push(current);
      current = [agent];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function withNewestEntries(agent: PublicAgent, keep: number): PublicAgent {
  const sourceEntries = agent.snapshot.entries;
  const removed = sourceEntries.length - keep;
  const omittedEntries = (agent.snapshot.omittedEntries ?? 0) + removed;
  return {
    ...agent,
    meta: { ...agent.meta },
    snapshot: {
      ...agent.snapshot,
      meta: { ...agent.snapshot.meta },
      entries: keep > 0 ? sourceEntries.slice(-keep) : [],
      ...(omittedEntries > 0 ? { historyTruncated: true, omittedEntries } : {}),
    },
  };
}

function stateMessage(agents: BrowserStateAgent[], reset: boolean, complete: boolean): BrowserStateMessage {
  return { v: PROTOCOL_VERSION, type: "state", agents, reset, complete };
}

function historyMessage(agent: PublicAgent, requestId: string): BrowserHistoryMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "agent_history",
    instanceId: agent.instanceId,
    requestId,
    agent: { ...agent, historyLoaded: true },
  };
}

function encodedBytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
