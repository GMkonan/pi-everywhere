import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appState,
  promptResult,
  selectSession,
  sendPrompt,
  sessionListState,
  startController,
  stopController,
  transcriptState,
} from "./controller";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

function agent(entries: unknown[] = []): Record<string, unknown> {
  return {
    instanceId: "agent-a",
    connectedAt: Date.now(),
    generation: 1,
    snapshotSequence: 0,
    meta: {
      instanceId: "agent-a",
      pid: 42,
      cwd: "/work/project",
      sessionId: "session-a",
      sessionName: "Project",
      model: "provider/model",
      supportsImages: true,
      thinkingLevel: "off",
      idle: true,
    },
    snapshot: { entries, capturedAt: Date.now() },
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  localStorage.setItem("pi-everywhere-device", "device-credential");
});

afterEach(() => {
  stopController();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
});

describe("Svelte browser controller", () => {
  it("owns authentication, lazy history, transcript state, and commands without the legacy bridge", async () => {
    startController();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent[0]).toMatchObject({
      type: "authenticate",
      capabilities: ["lazy-history-v1", "paged-history-v1"],
    }));

    socket.receive({ v: 1, type: "authenticated" });
    socket.receive({ v: 1, type: "state", reset: true, complete: true, agents: [agent()] });
    await vi.waitFor(() => expect(get(sessionListState).agents).toHaveLength(1));
    expect(get(appState).connection).toBe("online");

    selectSession("agent-a");
    const historyRequest = socket.sent.find((message) => message.type === "history_request");
    expect(historyRequest).toMatchObject({ instanceId: "agent-a", limit: 16 });
    socket.receive({
      v: 1,
      type: "agent_history",
      instanceId: "agent-a",
      requestId: historyRequest?.requestId,
      agent: agent([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Ready" }], stopReason: "stop" } }]),
      page: { offset: 0, count: 1, hasOlder: false },
    });
    await vi.waitFor(() => expect(get(transcriptState).items.some((item) => item.type === "answer" && item.text === "Ready")).toBe(true));
    expect(get(appState)).toMatchObject({ hasConversation: true, conversationName: "Project" });

    const commandId = sendPrompt({ text: "Continue", behavior: "followUp" });
    expect(commandId).toBeTruthy();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "command",
      instanceId: "agent-a",
      commandId,
      command: "prompt",
      payload: { text: "Continue", behavior: "followUp" },
    });
    socket.receive({ v: 1, type: "command_result", instanceId: "agent-a", commandId, ok: true });
    expect(get(promptResult)).toEqual({ commandId, ok: true });
    expect(window).not.toHaveProperty("__PI_EVERYWHERE_SVELTE__");
  });
});
