#!/usr/bin/env node

import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { JsonLineDecoder, encodeJsonLine } from "../shared/framing.js";
import { defaultPushStatePath, defaultSocketPath, defaultTokenPath } from "../shared/paths.js";
import {
  PROTOCOL_VERSION,
  isAgentHello,
  isAgentMessage,
  isBrowserCommand,
  isRecord,
  type AgentCommand,
  type AgentToServerMessage,
} from "../shared/protocol.js";
import { loadOrCreateToken, tokensEqual } from "./auth.js";
import { CompletionTracker } from "./completion-tracker.js";
import { PushService, PushSubscriptionLimitError } from "./push-service.js";
import { AgentRegistry } from "./registry.js";
import { findProjectRoot, serveStatic } from "./static-files.js";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const host = process.env.PI_EVERYWHERE_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PI_EVERYWHERE_PORT ?? "8484", 10);
const socketPath = process.env.PI_EVERYWHERE_SOCKET ?? defaultSocketPath();
const tokenPath = process.env.PI_EVERYWHERE_TOKEN_FILE ?? defaultTokenPath();
const pushStatePath = process.env.PI_EVERYWHERE_PUSH_STATE_FILE ?? defaultPushStatePath();
const projectRoot = process.env.PI_EVERYWHERE_ROOT ?? (await findProjectRoot());

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid PI_EVERYWHERE_PORT");
if (!["127.0.0.1", "::1", "localhost"].includes(host) && process.env.PI_EVERYWHERE_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing non-loopback bind. Use Tailscale Serve or set PI_EVERYWHERE_ALLOW_REMOTE=1 explicitly.");
}

const token = await loadOrCreateToken(tokenPath);
const pushService = await PushService.load(pushStatePath, token);
const registry = new AgentRegistry();
const completionTracker = new CompletionTracker();
const browsers = new Set<WebSocket>();
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

function sendBrowser(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_PENDING_BYTES) {
    socket.close(1013, "client is too slow");
    return;
  }
  socket.send(JSON.stringify(message));
}

function broadcast(message: unknown): void {
  for (const browser of browsers) sendBrowser(browser, message);
}

function sendState(socket: WebSocket): void {
  sendBrowser(socket, { v: PROTOCOL_VERSION, type: "state", agents: registry.listPublic() });
}

const httpServer = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, agents: registry.listPublic().length }));
      return;
    }
    if (url.pathname === "/api/info") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ name: "pi-everywhere", protocolVersion: PROTOCOL_VERSION, requiresToken: true }));
      return;
    }
    if (url.pathname === "/api/auth") {
      if (!requestAuthenticated(request)) {
        response.writeHead(401, { "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (await handlePushApi(request, response, url.pathname)) return;
    if (await serveStatic(url.pathname, projectRoot, response)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  } catch {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error\n");
  }
});

httpServer.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws" || !tokensEqual(token, url.searchParams.get("token")) || !originAllowed(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  } catch {
    socket.destroy();
  }
});

webSocketServer.on("connection", (socket) => {
  browsers.add(socket);
  sendState(socket);

  socket.on("message", (data) => {
    try {
      const value: unknown = JSON.parse(data.toString());
      if (!isBrowserCommand(value)) throw new Error("Invalid browser command");
      routeBrowserCommand(socket, value);
    } catch (error) {
      sendBrowser(socket, {
        v: PROTOCOL_VERSION,
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  socket.once("close", () => browsers.delete(socket));
});

async function handlePushApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/push/")) return false;
  if (!requestAuthenticated(request)) {
    response.writeHead(401, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (pathname === "/api/push/public-key") {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "cache-control": "no-store" });
      response.end();
      return true;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ publicKey: pushService.publicKey }));
    return true;
  }

  if (pathname !== "/api/push/subscription") return false;
  if (!request.method || !["PUT", "DELETE"].includes(request.method)) {
    response.writeHead(405, { allow: "PUT, DELETE", "cache-control": "no-store" });
    response.end();
    return true;
  }
  if (!originAllowed(request)) {
    response.writeHead(403, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  try {
    const body = await readJsonBody(request, 64 * 1024);
    if (request.method === "PUT") await pushService.subscribe(body);
    else await pushService.unsubscribe(isRecord(body) ? body.endpoint : undefined);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError
      ? 413
      : error instanceof PushSubscriptionLimitError
        ? 409
        : 400;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid request" }));
  }
  return true;
}

function requestAuthenticated(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  return tokensEqual(token, supplied);
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("Request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

class RequestBodyTooLargeError extends Error {}

function routeBrowserCommand(browser: WebSocket, command: AgentCommand): void {
  const record = registry.get(command.instanceId);
  if (!record?.socket.writable) {
    sendBrowser(browser, {
      v: PROTOCOL_VERSION,
      type: "command_result",
      instanceId: command.instanceId,
      commandId: command.commandId,
      ok: false,
      error: "Pi process is offline",
    });
    return;
  }

  if (command.command === "prompt") {
    const text = command.payload?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 100_000) {
      throw new Error("Prompt must contain between 1 and 100000 characters");
    }
  }
  if (record.socket.writableLength > MAX_PENDING_BYTES) {
    sendBrowser(browser, {
      v: PROTOCOL_VERSION,
      type: "command_result",
      instanceId: command.instanceId,
      commandId: command.commandId,
      ok: false,
      error: "Pi process connection is congested",
    });
    return;
  }
  record.socket.write(encodeJsonLine(command));
}

await prepareAgentSocket(socketPath);
const agentServer = createNetServer((socket) => handleAgentSocket(socket));
await new Promise<void>((resolve, reject) => {
  const onError = (error: Error) => reject(error);
  agentServer.once("error", onError);
  agentServer.listen(socketPath, () => {
    agentServer.off("error", onError);
    resolve();
  });
});
await chmod(socketPath, 0o600);

function handleAgentSocket(socket: Socket): void {
  const decoder = new JsonLineDecoder(MAX_PAYLOAD_BYTES);
  let instanceId: string | undefined;

  socket.on("data", (chunk) => {
    try {
      for (const value of decoder.push(chunk)) {
        if (!instanceId) {
          if (!isAgentHello(value)) throw new Error("The first agent message must be hello");
          instanceId = value.instanceId;
          const record = registry.upsert(instanceId, socket, value.snapshot);
          const settledDuringReconnect = completionTracker.connected(instanceId, value.snapshot.meta.idle);
          broadcast({ v: PROTOCOL_VERSION, type: "agent_upsert", agent: registry.toPublic(record) });
          if (settledDuringReconnect) notifySettled(instanceId);
          continue;
        }
        if (!isAgentMessage(value) || value.instanceId !== instanceId) throw new Error("Invalid agent message");
        handleAgentMessage(socket, value);
      }
    } catch {
      socket.destroy();
    }
  });
  socket.once("error", () => {});
  socket.once("close", () => {
    if (instanceId && registry.remove(instanceId, socket)) {
      completionTracker.disconnected(instanceId);
      broadcast({ v: PROTOCOL_VERSION, type: "agent_removed", instanceId });
    }
  });
}

function handleAgentMessage(socket: Socket, message: AgentToServerMessage): void {
  if (message.type === "hello") return;
  const record = registry.get(message.instanceId);
  if (!record || record.socket !== socket) return;

  if (message.type === "snapshot") {
    const updated = registry.updateSnapshot(message.instanceId, socket, message.snapshot);
    if (updated) broadcast({ v: PROTOCOL_VERSION, type: "agent_upsert", agent: registry.toPublic(updated) });
    return;
  }
  if (message.type === "heartbeat") {
    const idleChanged = record.snapshot.meta.idle !== message.idle;
    const updated = registry.heartbeat(message.instanceId, socket, message.idle);
    if (idleChanged && updated) broadcast({ v: PROTOCOL_VERSION, type: "agent_upsert", agent: registry.toPublic(updated) });
    return;
  }
  if (message.type === "event") {
    record.lastSeenAt = Date.now();
    if (message.event.type === "agent_start") {
      record.snapshot.meta.idle = false;
      completionTracker.started(message.instanceId);
    }
    if (message.event.type === "agent_settled") {
      record.snapshot.meta.idle = true;
      if (completionTracker.settled(message.instanceId)) notifySettled(message.instanceId);
    }
    broadcast({
      v: PROTOCOL_VERSION,
      type: "agent_event",
      instanceId: message.instanceId,
      sequence: message.sequence,
      event: message.event,
    });
    return;
  }
  broadcast(message);
}

function notifySettled(instanceId: string): void {
  void pushService.notify({
    type: "agent_settled",
    instanceId,
    title: "Pi finished working",
    body: "A Pi session is ready.",
    url: `/?session=${encodeURIComponent(instanceId)}`,
    timestamp: Date.now(),
  }).catch(() => {});
}

async function prepareAgentSocket(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const socketIsLive = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
  if (socketIsLive) throw new Error(`Another pi-everywhere daemon is already listening at ${path}`);
  await rm(path, { force: true });
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const requestHost = request.headers.host;
    if (requestHost && parsed.host === requestHost) return true;
    const allowed = (process.env.PI_EVERYWHERE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

httpServer.listen(port, host, () => {
  console.log(`pi-everywhere listening on http://${host}:${port}`);
  console.log(`agent socket: ${socketPath}`);
  console.log(`browser token: ${tokenPath}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const browser of browsers) browser.close(1001, "server shutting down");
  completionTracker.dispose();
  agentServer.close();
  httpServer.close();
  await rm(socketPath, { force: true });
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
