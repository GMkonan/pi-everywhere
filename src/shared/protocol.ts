export const PROTOCOL_VERSION = 1 as const;
export const MAX_COMMAND_ID_LENGTH = 128;

export interface AgentMeta {
  instanceId: string;
  pid: number;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: string;
  thinkingLevel: string;
  idle: boolean;
  connectedAt?: number;
}

export interface AgentSnapshot {
  meta: AgentMeta;
  entries: unknown[];
  capturedAt: number;
  historyTruncated?: boolean;
  omittedEntries?: number;
}

export interface AgentHello {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  instanceId: string;
  snapshot: AgentSnapshot;
}

export interface AgentEvent {
  v: typeof PROTOCOL_VERSION;
  type: "event";
  instanceId: string;
  sequence: number;
  event: Record<string, unknown>;
}

export interface AgentSnapshotMessage {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  instanceId: string;
  snapshot: AgentSnapshot;
}

export interface AgentHeartbeat {
  v: typeof PROTOCOL_VERSION;
  type: "heartbeat";
  instanceId: string;
  idle: boolean;
  timestamp: number;
}

export interface CommandResult {
  v: typeof PROTOCOL_VERSION;
  type: "command_result";
  instanceId: string;
  commandId: string;
  ok: boolean;
  error?: string;
}

export type AgentToServerMessage =
  | AgentHello
  | AgentEvent
  | AgentSnapshotMessage
  | AgentHeartbeat
  | CommandResult;

export type DeliveryBehavior = "steer" | "followUp";

export interface AgentCommand {
  v: typeof PROTOCOL_VERSION;
  type: "command";
  instanceId: string;
  commandId: string;
  command: "prompt" | "abort" | "snapshot";
  payload?: {
    text?: string;
    behavior?: DeliveryBehavior;
  };
}

export interface BrowserCommand {
  v: typeof PROTOCOL_VERSION;
  type: "command";
  instanceId: string;
  commandId: string;
  command: "prompt" | "abort" | "snapshot";
  payload?: {
    text?: string;
    behavior?: DeliveryBehavior;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentMeta(value: unknown): value is AgentMeta {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.pid === "number" &&
    typeof value.cwd === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.thinkingLevel === "string" &&
    typeof value.idle === "boolean"
  );
}

function isAgentSnapshot(value: unknown, instanceId: string): value is AgentSnapshot {
  return (
    isRecord(value) &&
    isAgentMeta(value.meta) &&
    value.meta.instanceId === instanceId &&
    Array.isArray(value.entries) &&
    typeof value.capturedAt === "number"
  );
}

export function isAgentHello(value: unknown): value is AgentHello {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || value.type !== "hello") return false;
  return typeof value.instanceId === "string" && isAgentSnapshot(value.snapshot, value.instanceId);
}

export function isAgentMessage(value: unknown): value is AgentToServerMessage {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== "string") return false;
  if (typeof value.instanceId !== "string") return false;
  if (value.type === "hello") return isAgentHello(value);
  if (value.type === "event") {
    return typeof value.sequence === "number" && isRecord(value.event) && typeof value.event.type === "string";
  }
  if (value.type === "snapshot") return isAgentSnapshot(value.snapshot, value.instanceId);
  if (value.type === "heartbeat") return typeof value.idle === "boolean" && typeof value.timestamp === "number";
  if (value.type === "command_result") {
    return isCommandId(value.commandId) && typeof value.ok === "boolean";
  }
  return false;
}

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || value.type !== "command") return false;
  return (
    typeof value.instanceId === "string" &&
    isCommandId(value.commandId) &&
    typeof value.command === "string" &&
    ["prompt", "abort", "snapshot"].includes(value.command)
  );
}

export function isCommandId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_COMMAND_ID_LENGTH;
}
