import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeClient, reconnectDelay } from "../src/extension/bridge-client.js";
import { JsonLineDecoder } from "../src/shared/framing.js";
import type { AgentSnapshot } from "../src/shared/protocol.js";

test("BridgeClient retries quickly without busy-looping when the daemon returns", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => reconnectDelay(attempt)),
    [250, 500, 1000, 2000, 2000, 2000, 2000, 2000],
  );
});

test("BridgeClient transports a bounded custom tool event without throwing", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-bridge-"));
  const socketPath = join(directory, "bridge.sock");
  const messages: unknown[] = [];
  let resolveMessage: ((message: unknown) => void) | undefined;
  let client: BridgeClient | undefined;
  const server = createServer((socket) => {
    const decoder = new JsonLineDecoder(2 * 1024 * 1024);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (resolveMessage) {
          const resolve = resolveMessage;
          resolveMessage = undefined;
          resolve(message);
        } else {
          messages.push(message);
        }
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const nextMessage = async (): Promise<Record<string, unknown>> => {
      if (messages.length > 0) return messages.shift() as Record<string, unknown>;
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolveMessage = undefined;
          reject(new Error("Timed out waiting for bridge message"));
        }, 3000);
        resolveMessage = (message) => {
          clearTimeout(timer);
          resolve(message as Record<string, unknown>);
        };
      });
    };

    const snapshot: AgentSnapshot = {
      meta: {
        instanceId: "agent",
        pid: 1,
        cwd: "/tmp/project",
        sessionId: "session",
        thinkingLevel: "off",
        idle: true,
      },
      entries: [],
      capturedAt: 1,
    };
    client = new BridgeClient({
      socketPath,
      instanceId: "agent",
      getSnapshot: () => snapshot,
      onCommand: async () => {},
    });

    client.start();
    const hello = await nextMessage();
    assert.equal(hello.type, "hello");

    const details: Record<string, unknown> = {
      output: "x".repeat(110_000),
      invalidDate: new Date(Number.NaN),
    };
    details.self = details;
    Object.defineProperty(details, "broken", {
      enumerable: true,
      get() {
        throw new Error("custom getter exploded");
      },
    });

    assert.doesNotThrow(() => client?.sendEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "custom-tool",
      details,
    }));
    const message = await nextMessage();
    const event = message.event as Record<string, unknown>;
    const serializedDetails = event.details as Record<string, unknown>;

    assert.equal(message.type, "event");
    assert.equal(event.type, "tool_execution_end");
    assert.match(serializedDetails.output as string, /truncated by pi-everywhere/);
    assert.equal(serializedDetails.invalidDate, "[Invalid Date]");
    assert.equal(serializedDetails.self, "[circular]");
    assert.equal(serializedDetails.broken, "[property could not be serialized]");
    assert.ok(Buffer.byteLength(JSON.stringify(message), "utf8") < 2 * 1024 * 1024);
  } finally {
    client?.stop();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
