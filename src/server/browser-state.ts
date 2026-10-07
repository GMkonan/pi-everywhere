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
  page?: {
    offset: number;
    count: number;
    hasOlder: boolean;
  };
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

/** Build a newest-first offset page while preserving chronological order within the page. */
export function buildBrowserHistoryPage(
  agent: PublicAgent,
  requestId: string,
  maximumBytes: number,
  offset: number,
  limit: number,
): BrowserHistoryMessage {
  if (maximumBytes <= 0) throw new Error("Browser history byte budget must be positive");
  const entries = agent.snapshot.entries;
  const end = Math.max(0, entries.length - offset);
  const available = Math.min(limit, end);
  for (let count = available; count >= 0; count -= 1) {
    const start = end - count;
    const paged = withEntrySlice(agent, entries.slice(start, end));
    const message = historyMessage(paged, requestId, { offset, count, hasOlder: start > 0 });
    if (encodedBytes(message) <= maximumBytes) return message;
  }
  throw new Error(`Agent ${agent.instanceId} metadata exceeds the browser history budget`);
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
  const newest = withEntrySlice(agent, keep > 0 ? sourceEntries.slice(-keep) : []);
  return {
    ...newest,
    snapshot: {
      ...newest.snapshot,
      ...(omittedEntries > 0 ? { historyTruncated: true, omittedEntries } : {}),
    },
  };
}

function withEntrySlice(agent: PublicAgent, entries: unknown[]): PublicAgent {
  return {
    ...agent,
    meta: { ...agent.meta },
    snapshot: {
      ...agent.snapshot,
      meta: { ...agent.snapshot.meta },
      entries: entries.map(toBrowserEntry).filter((entry) => entry !== undefined),
    },
  };
}

/** Project history into only the fields consumed by the browser transcript. */
function toBrowserEntry(value: unknown): unknown {
  const entry = recordValue(value);
  if (!entry) return value;
  if (entry.type === "compaction") {
    return {
      type: "compaction",
      ...(typeof entry.tokensBefore === "number" ? { tokensBefore: entry.tokensBefore } : {}),
    };
  }
  if (entry.type === "branch_summary") {
    return { type: "branch_summary", summary: truncateText(entry.summary, 20_000) };
  }
  if (entry.type !== "message") return typeof entry.type === "string" ? undefined : value;
  const message = recordValue(entry.message);
  if (!message || typeof message.role !== "string") return value;

  if (message.role === "user") {
    return { type: "message", message: { role: "user", content: projectContent(message.content, false) } };
  }
  if (message.role === "assistant") {
    return {
      type: "message",
      message: {
        role: "assistant",
        content: projectAssistantContent(message.content),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
      },
    };
  }
  if (message.role === "toolResult") {
    const isError = message.isError === true;
    return {
      type: "message",
      message: {
        role: "toolResult",
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        ...(isError ? { isError: true, content: projectContent(message.content, true) } : { content: [] }),
      },
    };
  }
  if (message.role === "bashExecution") {
    return {
      type: "message",
      message: {
        role: "bashExecution",
        command: truncateText(message.command, 512),
      },
    };
  }
  if (message.role === "custom" && message.display !== false) {
    return {
      type: "message",
      message: { role: "custom", content: projectContent(message.content, false), display: true },
    };
  }
  return undefined;
}

function projectAssistantContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return [];
  const projected: unknown[] = [];
  for (const block of value) {
    const item = recordValue(block);
    if (!item || typeof item.type !== "string") continue;
    if (item.type === "text" && typeof item.text === "string") projected.push({ type: "text", text: item.text });
    else if (item.type === "thinking" && typeof item.thinking === "string") projected.push({ type: "thinking", thinking: item.thinking });
    else if (item.type === "toolCall") {
      projected.push({
        type: "toolCall",
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        arguments: projectToolArguments(item.name, item.arguments),
      });
    }
  }
  return projected;
}

function projectContent(value: unknown, truncate: boolean): unknown {
  if (typeof value === "string") return truncate ? truncateText(value, 2_000) : value;
  if (!Array.isArray(value)) return [];
  const projected: unknown[] = [];
  for (const block of value) {
    const item = recordValue(block);
    if (!item || typeof item.type !== "string") continue;
    if (item.type === "text" && typeof item.text === "string") {
      projected.push({ type: "text", text: truncate ? truncateText(item.text, 2_000) : item.text });
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      projected.push({ type: "thinking", thinking: truncate ? truncateText(item.thinking, 2_000) : item.thinking });
    } else if (item.type === "image") {
      projected.push({ type: "image", ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}) });
    }
  }
  return projected;
}

function projectToolArguments(name: unknown, value: unknown): unknown {
  const args = recordValue(value);
  if (!args) return {};
  const lowered = typeof name === "string" ? name.toLowerCase() : "";
  const keys = lowered === "bash" || lowered.includes("shell")
    ? ["command"]
    : ["read", "write", "edit"].includes(lowered)
      ? ["path", "filePath", "file_path"]
      : lowered.includes("search")
        ? ["query", "queries", "pattern"]
        : ["path", "command", "query", "url"];
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const field = args[key];
    if (typeof field === "string") projected[key] = truncateText(field, 512);
    else if (Array.isArray(field)) projected[key] = field.slice(0, 8).map((item) => truncateText(item, 160));
  }
  return projected;
}

function truncateText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stateMessage(agents: BrowserStateAgent[], reset: boolean, complete: boolean): BrowserStateMessage {
  return { v: PROTOCOL_VERSION, type: "state", agents, reset, complete };
}

function historyMessage(
  agent: PublicAgent,
  requestId: string,
  page?: BrowserHistoryMessage["page"],
): BrowserHistoryMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "agent_history",
    instanceId: agent.instanceId,
    requestId,
    agent: { ...agent, historyLoaded: true },
    ...(page ? { page } : {}),
  };
}

function encodedBytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
