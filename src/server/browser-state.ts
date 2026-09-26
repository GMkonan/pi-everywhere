import { PROTOCOL_VERSION } from "../shared/protocol.js";
import type { PublicAgent } from "./registry.js";

export interface BrowserStateMessage {
  v: typeof PROTOCOL_VERSION;
  type: "state";
  agents: PublicAgent[];
  reset: boolean;
  complete: boolean;
}

/** Build ordered state chunks that each fit within the browser frame budget. */
export function buildBrowserStateMessages(
  agents: PublicAgent[],
  maximumBytes: number,
): BrowserStateMessage[] {
  if (maximumBytes <= 0) throw new Error("Browser state byte budget must be positive");
  if (agents.length === 0) return [stateMessage([], true, true)];

  const fullChunks = packAgents(
    agents.map((agent) => fitAgent(agent, maximumBytes)),
    maximumBytes,
  );
  const summaries = agents.map((agent) => fitAgent(withNewestEntries(agent, 0), maximumBytes));
  const summaryChunks = packAgents(summaries, maximumBytes);
  const fullBytes = transferBytes(fullChunks);
  const summaryBytes = transferBytes(summaryChunks);
  const shouldSendIndexFirst = fullBytes > maximumBytes / 4 && summaryBytes < fullBytes / 2;
  const chunks = shouldSendIndexFirst ? [...summaryChunks, ...fullChunks] : fullChunks;

  return chunks.map((chunk, index) => stateMessage(
    chunk,
    index === 0,
    index === chunks.length - 1,
  ));
}

function packAgents(agents: PublicAgent[], maximumBytes: number): PublicAgent[][] {
  const chunks: PublicAgent[][] = [];
  let current: PublicAgent[] = [];

  for (const agent of agents) {
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

function transferBytes(chunks: PublicAgent[][]): number {
  return chunks.reduce(
    (total, chunk) => total + encodedBytes(stateMessage(chunk, false, false)),
    0,
  );
}

function fitAgent(agent: PublicAgent, maximumBytes: number): PublicAgent {
  if (encodedBytes(stateMessage([agent], false, false)) <= maximumBytes) return agent;

  const sourceEntries = agent.snapshot.entries;
  let minimum = 0;
  let maximum = sourceEntries.length;
  let best: PublicAgent | undefined;
  while (minimum <= maximum) {
    const keep = Math.floor((minimum + maximum) / 2);
    const candidate = withNewestEntries(agent, keep);
    if (encodedBytes(stateMessage([candidate], false, false)) <= maximumBytes) {
      best = candidate;
      minimum = keep + 1;
    } else {
      maximum = keep - 1;
    }
  }

  if (!best) throw new Error(`Agent ${agent.instanceId} metadata exceeds the browser state budget`);
  return best;
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

function stateMessage(agents: PublicAgent[], reset: boolean, complete: boolean): BrowserStateMessage {
  return { v: PROTOCOL_VERSION, type: "state", agents, reset, complete };
}

function encodedBytes(message: BrowserStateMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
