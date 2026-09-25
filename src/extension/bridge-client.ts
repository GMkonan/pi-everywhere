import { createConnection, type Socket } from "node:net";
import { JsonLineDecoder } from "../shared/framing.ts";
import {
  PROTOCOL_VERSION,
  isRecord,
  type AgentCommand,
  type AgentSnapshot,
} from "../shared/protocol.ts";
import { toWireValue } from "./safe-serialize.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;

interface BridgeClientOptions {
  socketPath: string;
  instanceId: string;
  getSnapshot: () => AgentSnapshot;
  onCommand: (command: AgentCommand) => Promise<void>;
  onStatus?: (connected: boolean) => void;
}

export class BridgeClient {
  private socket: Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private reconnectAttempt = 0;
  private sequence = 0;

  constructor(private readonly options: BridgeClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.options.onStatus?.(false);
  }

  sendEvent(event: unknown): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: "event",
      instanceId: this.options.instanceId,
      sequence: ++this.sequence,
      event: toWireValue(event),
    }, isTransientEvent(event));
  }

  sendSnapshot(): boolean {
    return this.send({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      instanceId: this.options.instanceId,
      snapshot: this.options.getSnapshot(),
    });
  }

  sendCommandResult(commandId: string, ok: boolean, error?: string): boolean {
    return this.send({
      v: PROTOCOL_VERSION,
      type: "command_result",
      instanceId: this.options.instanceId,
      commandId,
      ok,
      ...(error ? { error } : {}),
    });
  }

  private connect(): void {
    if (this.stopped || this.socket) return;

    const decoder = new JsonLineDecoder(MAX_MESSAGE_BYTES);
    const socket = createConnection(this.options.socketPath);
    this.socket = socket;

    socket.once("connect", () => {
      this.reconnectAttempt = 0;
      this.options.onStatus?.(true);
      this.send({
        v: PROTOCOL_VERSION,
        type: "hello",
        instanceId: this.options.instanceId,
        snapshot: this.options.getSnapshot(),
      });
      this.heartbeatTimer = setInterval(() => {
        const snapshot = this.options.getSnapshot();
        this.send({
          v: PROTOCOL_VERSION,
          type: "heartbeat",
          instanceId: this.options.instanceId,
          idle: snapshot.meta.idle,
          timestamp: Date.now(),
        });
      }, 15_000);
      this.heartbeatTimer.unref();
    });

    socket.on("data", (chunk) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!isAgentCommand(message)) continue;
          void this.options.onCommand(message).catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            this.sendCommandResult(message.commandId, false, text);
          });
        }
      } catch {
        socket.destroy();
      }
    });

    socket.once("error", () => {
      // The close handler schedules a reconnect. Connection failures are expected
      // while the daemon is not running, so do not pollute the TUI or logs.
    });

    socket.once("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (this.socket === socket) this.socket = undefined;
      this.options.onStatus?.(false);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(10_000, 250 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private send(message: unknown, transient = false): boolean {
    const socket = this.socket;
    if (!socket?.writable) return false;
    if (socket.writableLength > MAX_PENDING_BYTES) {
      if (transient) return false;
      socket.destroy();
      return false;
    }
    const line = `${JSON.stringify(toWireValue(message))}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) return false;
    socket.write(line);
    return true;
  }
}

function isTransientEvent(value: unknown): boolean {
  return isRecord(value) && ["message_update", "tool_execution_update"].includes(String(value.type));
}

function isAgentCommand(value: unknown): value is AgentCommand {
  return (
    isRecord(value) &&
    value.v === PROTOCOL_VERSION &&
    value.type === "command" &&
    typeof value.instanceId === "string" &&
    typeof value.commandId === "string" &&
    typeof value.command === "string" &&
    ["prompt", "abort", "snapshot"].includes(value.command)
  );
}
