import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for daemon health endpoint");
}

interface AgentOptions {
  sessionId?: string;
  cwd?: string;
  pid?: number;
  entries?: unknown[];
}

function connectAgent(socketPath: string, instanceId: string, options: AgentOptions = {}): Promise<Socket> {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.write(`${JSON.stringify({
        v: 1,
        type: "hello",
        instanceId,
        snapshot: {
          meta: {
            instanceId,
            pid: options.pid ?? (instanceId === "agent-a" ? 1 : 2),
            cwd: options.cwd ?? `/tmp/${instanceId}`,
            sessionId: options.sessionId ?? "shared-session",
            thinkingLevel: "off",
            idle: true,
          },
          entries: options.entries ?? [],
          capturedAt: Date.now(),
        },
      })}\n`);
      resolveConnect(socket);
    });
  });
}

function nextLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolveLine, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for agent command")), 3000);
    socket.on("data", function onData(chunk) {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolveLine(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
  });
}

function nextBrowserMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for browser message"));
    }, 3000);
    function onMessage(data: WebSocket.RawData) {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveMessage(message);
    }
    socket.on("message", onMessage);
  });
}

function nextBrowserState(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolveState, reject) => {
    const agents = new Map<string, Record<string, unknown>>();
    let chunks = 0;
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for complete browser state"));
    }, 5000);
    function onMessage(data: WebSocket.RawData) {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type !== "state") return;
      chunks += 1;
      if (message.reset !== false) agents.clear();
      for (const agent of (message.agents as Array<Record<string, unknown>> | undefined) ?? []) {
        agents.set(String(agent.instanceId), agent);
      }
      if (message.complete === false) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveState({ ...message, agents: [...agents.values()], reset: true, complete: true, chunks });
    }
    socket.on("message", onMessage);
  });
}

test("daemon authenticates browsers and isolates live processes sharing one session", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-everywhere-server-"));
  const socketPath = join(directory, "bridge.sock");
  const tokenPath = join(directory, "token");
  const pushStatePath = join(directory, "push.json");
  const deviceStatePath = join(directory, "devices.json");
  const port = await freePort();
  const root = resolve(import.meta.dirname, "..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PI_EVERYWHERE_PORT: String(port),
      PI_EVERYWHERE_SOCKET: socketPath,
      PI_EVERYWHERE_TOKEN_FILE: tokenPath,
      PI_EVERYWHERE_PUSH_STATE_FILE: pushStatePath,
      PI_EVERYWHERE_DEVICE_STATE_FILE: deviceStatePath,
      PI_EVERYWHERE_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const sockets: Array<Socket | WebSocket> = [];
  try {
    await waitForHealth(port);
    for (const [path, expectedExport] of [
      ["/markdown.js", "export function renderMarkdown"],
      ["/session-list.js", "export function sortAgentsByActivity"],
    ] as const) {
      const frontendModule = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(frontendModule.status, 200);
      assert.match(frontendModule.headers.get("content-type") ?? "", /^text\/javascript/);
      assert.match(await frontendModule.text(), new RegExp(expectedExport));
    }

    const token = (await readFile(tokenPath, "utf8")).trim();

    const pairingResponse = await fetch(`http://127.0.0.1:${port}/api/admin/pairings`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${port}` }),
    });
    assert.equal(pairingResponse.status, 201);
    const pairing = await pairingResponse.json() as { code: string };
    const exchangeResponse = await fetch(`http://127.0.0.1:${port}/api/pair/exchange`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "Test phone" }),
    });
    assert.equal(exchangeResponse.status, 201);
    const issued = await exchangeResponse.json() as { device: { id: string; credential: string } };
    const repeatedExchange = await fetch(`http://127.0.0.1:${port}/api/pair/exchange`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "Replay" }),
    });
    assert.equal(repeatedExchange.status, 401);

    const deviceBrowser = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: `http://127.0.0.1:${port}`,
    });
    sockets.push(deviceBrowser);
    await once(deviceBrowser, "open");
    const deviceAuthenticated = nextBrowserMessage(deviceBrowser, (message) => message.type === "authenticated");
    const deviceState = nextBrowserState(deviceBrowser);
    deviceBrowser.send(JSON.stringify({
      v: 1,
      type: "authenticate",
      credential: issued.device.credential,
    }));
    assert.equal((await deviceAuthenticated).kind, "device");
    await deviceState;

    const devicePushSubscription = {
      endpoint: "https://push.example/paired-device",
      keys: { p256dh: "abcdefgh12345678", auth: "abcdefgh12345678" },
    };
    const devicePush = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${issued.device.credential}`,
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify(devicePushSubscription),
    });
    assert.equal(devicePush.status, 204);
    const deviceClosed = once(deviceBrowser, "close");
    const revoked = await fetch(`http://127.0.0.1:${port}/api/admin/devices/${issued.device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 204);
    await deviceClosed;
    const revokedAuth = await fetch(`http://127.0.0.1:${port}/api/auth`, {
      headers: { authorization: `Bearer ${issued.device.credential}` },
    });
    assert.equal(revokedAuth.status, 401);

    const unauthorizedPushKey = await fetch(`http://127.0.0.1:${port}/api/push/public-key`);
    assert.equal(unauthorizedPushKey.status, 401);
    const pushKey = await fetch(`http://127.0.0.1:${port}/api/push/public-key`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(pushKey.status, 200);
    assert.match((await pushKey.json() as { publicKey: string }).publicKey, /^[A-Za-z0-9_-]+$/);

    const pushSubscription = {
      endpoint: "https://push.example/device-a",
      keys: { p256dh: "abcdefgh12345678", auth: "abcdefgh12345678" },
    };
    const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://wrong.example",
      },
      body: JSON.stringify(pushSubscription),
    });
    assert.equal(rejectedOrigin.status, 403);
    const registeredPush = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify(pushSubscription),
    });
    assert.equal(registeredPush.status, 204);
    const removedPush = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ endpoint: pushSubscription.endpoint }),
    });
    assert.equal(removedPush.status, 204);

    await assert.rejects(
      () => new Promise<void>((resolveOpen, reject) => {
        const invalid = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`, {
          origin: `http://127.0.0.1:${port}`,
        });
        invalid.once("open", resolveOpen);
        invalid.once("error", reject);
      }),
    );

    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    sockets.push(browser);
    await new Promise<void>((resolveOpen, reject) => {
      browser.once("open", resolveOpen);
      browser.once("error", reject);
    });

    const upsertA = nextBrowserMessage(browser, (message) =>
      message.type === "agent_upsert" &&
      (message.agent as Record<string, unknown> | undefined)?.instanceId === "agent-a"
    );
    const agentA = await connectAgent(socketPath, "agent-a", {
      entries: [{ type: "custom", data: "a".repeat(1_050_000) }],
    });
    sockets.push(agentA);
    await upsertA;

    const upsertB = nextBrowserMessage(browser, (message) =>
      message.type === "agent_upsert" &&
      (message.agent as Record<string, unknown> | undefined)?.instanceId === "agent-b"
    );
    const agentB = await connectAgent(socketPath, "agent-b", {
      entries: [{ type: "custom", data: "b".repeat(1_050_000) }],
    });
    sockets.push(agentB);
    await upsertB;

    const reconnectingBrowser = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
      { origin: `http://127.0.0.1:${port}` },
    );
    const recoveredState = nextBrowserState(reconnectingBrowser);
    sockets.push(reconnectingBrowser);
    await once(reconnectingBrowser, "open");
    const state = await recoveredState;
    assert.equal(state.reset, true);
    assert.equal(state.complete, true);
    assert.ok(Number(state.chunks) >= 3);
    const stateAgents = state.agents as Array<{
      instanceId: string;
      lastSeenAt: number;
      meta: { sessionId: string };
    }>;
    assert.deepEqual(stateAgents.map((agent) => agent.instanceId).sort(), ["agent-a", "agent-b"]);
    assert.deepEqual([...new Set(stateAgents.map((agent) => agent.meta.sessionId))], ["shared-session"]);
    const beforeResultLastSeen = stateAgents.find((agent) => agent.instanceId === "agent-b")?.lastSeenAt ?? 0;

    let agentAReceivedData = false;
    agentA.once("data", () => { agentAReceivedData = true; });
    const commandForB = nextLine(agentB);
    browser.send(JSON.stringify({
      v: 1,
      type: "command",
      instanceId: "agent-b",
      commandId: "command-1",
      command: "prompt",
      payload: { text: "hello B", behavior: "followUp" },
    }));

    const command = await commandForB;
    assert.equal(command.instanceId, "agent-b");
    assert.equal((command.payload as Record<string, unknown>).text, "hello B");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.equal(agentAReceivedData, false);

    let otherBrowserReceivedResult = false;
    const collectOtherResult = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "command_result" && message.commandId === "command-1") {
        otherBrowserReceivedResult = true;
      }
    };
    reconnectingBrowser.on("message", collectOtherResult);
    const originResult = nextBrowserMessage(browser, (message) =>
      message.type === "command_result" && message.commandId === "command-1"
    );
    agentB.write(`${JSON.stringify({
      v: 1,
      type: "command_result",
      instanceId: "agent-b",
      commandId: "command-1",
      ok: true,
    })}\n`);
    assert.equal((await originResult).ok, true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    reconnectingBrowser.off("message", collectOtherResult);
    assert.equal(otherBrowserReceivedResult, false);
    reconnectingBrowser.close();

    const livenessBrowser = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
      { origin: `http://127.0.0.1:${port}` },
    );
    const refreshedState = nextBrowserState(livenessBrowser);
    sockets.push(livenessBrowser);
    await once(livenessBrowser, "open");
    const refreshedAgents = (await refreshedState).agents as Array<{ instanceId: string; lastSeenAt: number }>;
    const afterResultLastSeen = refreshedAgents.find((agent) => agent.instanceId === "agent-b")?.lastSeenAt ?? 0;
    assert.ok(afterResultLastSeen > beforeResultLastSeen);
    livenessBrowser.close();

    const commandBeforeReconnect = nextLine(agentB);
    browser.send(JSON.stringify({
      v: 1,
      type: "command",
      instanceId: "agent-b",
      commandId: "command-before-reconnect",
      command: "snapshot",
    }));
    await commandBeforeReconnect;
    const reconnectFailure = nextBrowserMessage(browser, (message) =>
      message.type === "command_result" && message.commandId === "command-before-reconnect"
    );

    const lifecycleMessages: Array<Record<string, unknown>> = [];
    const collectLifecycle = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (["agent_upsert", "agent_removed"].includes(String(message.type))) lifecycleMessages.push(message);
    };
    browser.on("message", collectLifecycle);
    const replacementUpsert = nextBrowserMessage(browser, (message) => {
      if (message.type !== "agent_upsert") return false;
      const agent = message.agent as { instanceId?: string; meta?: { cwd?: string } } | undefined;
      return agent?.instanceId === "agent-b" && agent.meta?.cwd === "/tmp/agent-b-reconnected";
    });
    const oldSocketClosed = once(agentB, "close");
    const replacementB = await connectAgent(socketPath, "agent-b", {
      cwd: "/tmp/agent-b-reconnected",
      sessionId: "shared-session",
    });
    sockets.push(replacementB);
    await oldSocketClosed;
    await replacementUpsert;
    const failedDuringReconnect = await reconnectFailure;
    assert.equal(failedDuringReconnect.ok, false);
    assert.match(String(failedDuringReconnect.error), /reconnected before acknowledging/);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    browser.off("message", collectLifecycle);
    assert.equal(
      lifecycleMessages.some((message) => message.type === "agent_removed" && message.instanceId === "agent-b"),
      false,
    );

    const commandForReplacement = nextLine(replacementB);
    browser.send(JSON.stringify({
      v: 1,
      type: "command",
      instanceId: "agent-b",
      commandId: "command-2",
      command: "prompt",
      payload: { text: "hello replacement", behavior: "followUp" },
    }));
    const replacementCommand = await commandForReplacement;
    assert.equal(replacementCommand.commandId, "command-2");
    assert.equal((replacementCommand.payload as Record<string, unknown>).text, "hello replacement");
  } finally {
    for (const socket of sockets) {
      if (socket instanceof WebSocket) socket.close();
      else socket.destroy();
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
    await rm(directory, { recursive: true, force: true });
    assert.equal(stderr, "");
  }
});
