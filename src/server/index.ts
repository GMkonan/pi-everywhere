#!/usr/bin/env node

import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { JsonLineDecoder, encodeJsonLine } from "../shared/framing.js";
import { defaultDeviceStatePath, defaultPushStatePath, defaultSocketPath, defaultTokenPath } from "../shared/paths.js";
import { validatePromptPayload } from "../shared/prompt.js";
import {
  PROTOCOL_VERSION,
  isAgentHello,
  isAgentMessage,
  isBrowserCommand,
  isBrowserHistoryRequest,
  isRecord,
  type AgentCommand,
  type AgentToServerMessage,
} from "../shared/protocol.js";
import { loadOrCreateToken, tokensEqual } from "./auth.js";
import {
  buildBrowserHistoryMessage,
  buildBrowserHistoryPage,
  buildBrowserStateMessages,
  buildLegacyBrowserStateMessages,
} from "./browser-state.js";
import { CompletionTracker } from "./completion-tracker.js";
import { DeviceLimitError, DeviceStore, type PublicDevice } from "./device-store.js";
import { evictStaleAgents } from "./liveness.js";
import { PairingLimitError, PairingManager } from "./pairing.js";
import { PendingCommands } from "./pending-commands.js";
import { PushService, PushSubscriptionLimitError } from "./push-service.js";
import { AgentRegistry, type AgentRecord } from "./registry.js";
import { findProjectRoot, serveStatic } from "./static-files.js";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 2 * MAX_PAYLOAD_BYTES;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const HEARTBEAT_SWEEP_MS = 15_000;
const host = process.env.PI_EVERYWHERE_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PI_EVERYWHERE_PORT ?? "8484", 10);
const socketPath = process.env.PI_EVERYWHERE_SOCKET ?? defaultSocketPath();
const tokenPath = process.env.PI_EVERYWHERE_TOKEN_FILE ?? defaultTokenPath();
const pushStatePath = process.env.PI_EVERYWHERE_PUSH_STATE_FILE ?? defaultPushStatePath();
const deviceStatePath = process.env.PI_EVERYWHERE_DEVICE_STATE_FILE ?? defaultDeviceStatePath();
const projectRoot = process.env.PI_EVERYWHERE_ROOT ?? (await findProjectRoot());

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid PI_EVERYWHERE_PORT");
if (!["127.0.0.1", "::1", "localhost"].includes(host) && process.env.PI_EVERYWHERE_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing non-loopback bind. Use Tailscale Serve or set PI_EVERYWHERE_ALLOW_REMOTE=1 explicitly.");
}

const token = await loadOrCreateToken(tokenPath);
const pushService = await PushService.load(pushStatePath, token);
const deviceStore = await DeviceStore.load(deviceStatePath);
const pairingManager = new PairingManager();
const registry = new AgentRegistry();
const completionTracker = new CompletionTracker();
interface AuthIdentity {
  kind: "master" | "device";
  device?: PublicDevice;
}
interface BrowserConnection extends AuthIdentity {
  lazyHistory: boolean;
  pagedHistory: boolean;
}

interface QueuedBrowserMessage {
  encoded: string;
  bytes: number;
  onSent?: () => void;
}
interface BrowserSendQueue {
  sending: boolean;
  queuedBytes: number;
  messages: QueuedBrowserMessage[];
}

const browsers = new Map<WebSocket, BrowserConnection>();
const browserSendQueues = new Map<WebSocket, BrowserSendQueue>();
const historyWatches = new Map<WebSocket, {
  instanceId: string;
  requestId: string;
  pageSize?: number;
}>();
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 4,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    zlibDeflateOptions: { level: 3 },
  },
});

function sendBrowser(socket: WebSocket, message: unknown, onSent?: () => void): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(message);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    socket.close(1009, "message exceeds the browser payload limit");
    return false;
  }
  const queue = browserSendQueues.get(socket) ?? { sending: false, queuedBytes: 0, messages: [] };
  browserSendQueues.set(socket, queue);
  if (queue.queuedBytes + bytes > MAX_PENDING_BYTES) {
    socket.close(1013, "client is too slow");
    return false;
  }
  queue.messages.push({ encoded, bytes, ...(onSent ? { onSent } : {}) });
  queue.queuedBytes += bytes;
  drainBrowserQueue(socket, queue);
  return true;
}

function drainBrowserQueue(socket: WebSocket, queue: BrowserSendQueue): void {
  if (queue.sending || socket.readyState !== WebSocket.OPEN) return;
  const message = queue.messages.shift();
  if (!message) return;
  queue.queuedBytes -= message.bytes;
  queue.sending = true;
  socket.send(message.encoded, (error) => {
    queue.sending = false;
    if (error) {
      socket.close(1011, "browser message could not be sent");
      return;
    }
    try { message.onSent?.(); }
    catch { socket.close(1011, "browser send continuation failed"); return; }
    drainBrowserQueue(socket, queue);
  });
}

function broadcast(message: unknown): void {
  for (const browser of browsers.keys()) sendBrowser(browser, message);
}

function sendState(socket: WebSocket, lazyHistory: boolean): void {
  try {
    const messages = lazyHistory
      ? buildBrowserStateMessages(registry.listSummaries(), MAX_PAYLOAD_BYTES)
      : buildLegacyBrowserStateMessages(registry.listPublic(), MAX_PAYLOAD_BYTES);
    const sendNext = (index: number): void => {
      const message = messages[index];
      if (!message) return;
      sendBrowser(socket, message, () => sendNext(index + 1));
    };
    sendNext(0);
  } catch {
    socket.close(1009, "agent metadata exceeds the browser payload limit");
  }
}

function sendHistory(
  socket: WebSocket,
  record: AgentRecord,
  requestId: string,
  page?: { offset: number; limit: number },
): void {
  try {
    const agent = registry.toPublic(record);
    sendBrowser(socket, page
      ? buildBrowserHistoryPage(agent, requestId, MAX_PAYLOAD_BYTES, page.offset, page.limit)
      : buildBrowserHistoryMessage(agent, requestId, MAX_PAYLOAD_BYTES));
  } catch {
    sendBrowser(socket, {
      v: PROTOCOL_VERSION,
      type: "agent_history_error",
      instanceId: record.instanceId,
      requestId,
      error: "Session history exceeds the browser payload limit",
    });
  }
}

function sendHistoryError(socket: WebSocket, instanceId: string, requestId: string, error: string): void {
  sendBrowser(socket, {
    v: PROTOCOL_VERSION,
    type: "agent_history_error",
    instanceId,
    requestId,
    error,
  });
}

function broadcastAgent(record: AgentRecord): void {
  for (const [browser, connection] of browsers) {
    if (connection.lazyHistory) {
      sendBrowser(browser, { v: PROTOCOL_VERSION, type: "agent_upsert", agent: registry.toSummary(record) });
    } else {
      try {
        const history = buildBrowserHistoryMessage(registry.toPublic(record), "legacy", MAX_PAYLOAD_BYTES);
        sendBrowser(browser, { v: PROTOCOL_VERSION, type: "agent_upsert", agent: history.agent });
      } catch {
        browser.close(1009, "agent history exceeds the browser payload limit");
      }
    }
  }
  for (const [browser, watch] of historyWatches) {
    if (watch.instanceId === record.instanceId) {
      sendHistory(browser, record, watch.requestId, watch.pageSize ? { offset: 0, limit: watch.pageSize } : undefined);
    }
  }
}

const pendingCommands = new PendingCommands<WebSocket>((browser, result) => sendBrowser(browser, result));
const heartbeatSweep = setInterval(() => {
  evictStaleAgents(registry, Date.now() - HEARTBEAT_TIMEOUT_MS, {
    disconnected: (instanceId) => completionTracker.disconnected(instanceId),
    failPending: (instanceId, error) => pendingCommands.failInstance(instanceId, error),
    removed: (instanceId) => broadcast({ v: PROTOCOL_VERSION, type: "agent_removed", instanceId }),
  });
}, HEARTBEAT_SWEEP_MS);
heartbeatSweep.unref();

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
      const identity = await authenticateRequest(request);
      if (!identity) {
        response.writeHead(401, { "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ kind: identity.kind, device: identity.device }));
      return;
    }
    if (await handlePairingApi(request, response, url.pathname)) return;
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
    const legacyToken = url.searchParams.get("token");
    if (url.pathname !== "/ws" || !originAllowed(request) || (legacyToken !== null && !tokensEqual(token, legacyToken))) {
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

webSocketServer.on("connection", (socket, request) => {
  let authenticated = false;
  let authenticating = false;
  const timeout = setTimeout(() => socket.close(1008, "authentication required"), 5_000);
  timeout.unref();

  const activate = (connection: BrowserConnection): void => {
    if (authenticated) return;
    authenticated = true;
    clearTimeout(timeout);
    browsers.set(socket, connection);
    sendBrowser(socket, {
      v: PROTOCOL_VERSION,
      type: "authenticated",
      kind: connection.kind,
      device: connection.device,
      lazyHistory: connection.lazyHistory,
      pagedHistory: connection.pagedHistory,
    });
    sendState(socket, connection.lazyHistory);
  };

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (tokensEqual(token, url.searchParams.get("token"))) {
      activate({ kind: "master", lazyHistory: false, pagedHistory: false });
    }
  } catch {
    socket.close(1008, "authentication required");
  }

  socket.on("message", (data) => {
    if (!authenticated) {
      if (authenticating) return;
      authenticating = true;
      void authenticateWebSocket(data.toString()).then((connection) => {
        authenticating = false;
        if (connection) activate(connection);
        else socket.close(1008, "invalid credential");
      }).catch(() => socket.close(1011, "authentication failed"));
      return;
    }
    try {
      const value: unknown = JSON.parse(data.toString());
      if (isBrowserHistoryRequest(value)) {
        const connection = browsers.get(socket);
        if (!connection?.lazyHistory) throw new Error("History requests require lazy-history support");
        const record = registry.get(value.instanceId);
        if (!record) {
          sendHistoryError(socket, value.instanceId, value.requestId, "Pi process is no longer connected");
          return;
        }
        const offset = value.offset ?? 0;
        if (offset > 0) {
          if (!connection.pagedHistory) throw new Error("Paged history was not negotiated");
          if (value.generation !== record.generation || value.snapshotSequence !== record.snapshotSequence) {
            sendHistoryError(socket, value.instanceId, value.requestId, "Session history changed; reload the recent messages");
            return;
          }
          sendHistory(socket, record, value.requestId, { offset, limit: value.limit ?? 40 });
          return;
        }
        const pageSize = connection.pagedHistory ? value.limit ?? 40 : undefined;
        historyWatches.set(socket, { instanceId: value.instanceId, requestId: value.requestId, ...(pageSize ? { pageSize } : {}) });
        sendHistory(socket, record, value.requestId, pageSize ? { offset: 0, limit: pageSize } : undefined);
        return;
      }
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
  socket.once("close", () => {
    clearTimeout(timeout);
    browsers.delete(socket);
    browserSendQueues.delete(socket);
    historyWatches.delete(socket);
    pendingCommands.removeBrowser(socket);
  });
});

async function handlePairingApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === "/api/pair/exchange") {
    if (request.method !== "POST" || !originAllowed(request)) {
      response.writeHead(request.method === "POST" ? 403 : 405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request, 16 * 1024);
      if (!isRecord(body) || !pairingManager.exchange(body.code)) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Pairing code is invalid, expired, or already used" }));
        return true;
      }
      const device = await deviceStore.issue(body.name);
      response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ device }));
    } catch (error) {
      const status = error instanceof DeviceLimitError ? 409 : error instanceof RequestBodyTooLargeError ? 413 : 400;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Pairing failed" }));
    }
    return true;
  }

  if (!pathname.startsWith("/api/admin/")) return false;
  if (!requestMasterAuthenticated(request)) {
    response.writeHead(401, { "cache-control": "no-store" });
    response.end();
    return true;
  }
  try {
    if (pathname === "/api/admin/pairings" && request.method === "POST") {
      const body = await readJsonBody(request, 16 * 1024);
      const offer = pairingManager.create(isRecord(body) ? body.baseUrl : undefined);
      response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(offer));
      return true;
    }
    if (pathname === "/api/admin/devices" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ devices: deviceStore.list() }));
      return true;
    }
    const revokeMatch = pathname.match(/^\/api\/admin\/devices\/([A-Za-z0-9-]{1,128})$/u);
    if (revokeMatch && request.method === "DELETE") {
      const deviceId = revokeMatch[1];
      if (!deviceId || !deviceStore.list().some((device) => device.id === deviceId)) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return true;
      }
      for (const [browser, identity] of browsers) {
        if (identity.device?.id === deviceId) browser.close(1008, "device revoked");
      }
      await deviceStore.revoke(deviceId);
      await pushService.revokeOwner(deviceId);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    response.writeHead(405, { "cache-control": "no-store" });
    response.end();
  } catch (error) {
    const status = error instanceof PairingLimitError || error instanceof DeviceLimitError
      ? 409
      : error instanceof RequestBodyTooLargeError
        ? 413
        : 400;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }));
  }
  return true;
}

async function handlePushApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/push/")) return false;
  const identity = await authenticateRequest(request);
  if (!identity) {
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
    if (request.method === "PUT") await pushService.subscribe(body, identity.device?.id ?? "legacy-token");
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

function requestMasterAuthenticated(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  return tokensEqual(token, supplied);
}

async function authenticateRequest(request: IncomingMessage): Promise<AuthIdentity | undefined> {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  return await authenticateCredential(supplied);
}

async function authenticateWebSocket(encoded: string): Promise<BrowserConnection | undefined> {
  let value: unknown;
  try { value = JSON.parse(encoded); }
  catch { return undefined; }
  if (!isRecord(value)
    || value.v !== PROTOCOL_VERSION
    || value.type !== "authenticate"
    || typeof value.credential !== "string") return undefined;
  const identity = await authenticateCredential(value.credential);
  if (!identity) return undefined;
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  const lazyHistory = capabilities.includes("lazy-history-v1");
  const pagedHistory = lazyHistory && capabilities.includes("paged-history-v1");
  return { ...identity, lazyHistory, pagedHistory };
}

async function authenticateCredential(credential: string | null): Promise<AuthIdentity | undefined> {
  if (tokensEqual(token, credential)) return { kind: "master" };
  const device = await deviceStore.authenticate(credential);
  return device ? { kind: "device", device } : undefined;
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

  if (command.command === "prompt") command.payload = validatePromptPayload(command.payload);
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
  if (!pendingCommands.add(browser, command)) throw new Error("Command ID is already pending");
  try {
    record.socket.write(encodeJsonLine(command));
  } catch {
    pendingCommands.fail(command.commandId, "Pi command could not be sent");
  }
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
          const existing = registry.get(instanceId);
          if (existing && existing.socket !== socket) {
            pendingCommands.failInstance(instanceId, "Pi process reconnected before acknowledging the command");
          }
          const record = registry.upsert(instanceId, socket, value.snapshot);
          const settledDuringReconnect = completionTracker.connected(instanceId, value.snapshot.meta.idle);
          broadcastAgent(record);
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
      pendingCommands.failInstance(instanceId, "Pi process disconnected");
      broadcast({ v: PROTOCOL_VERSION, type: "agent_removed", instanceId });
    }
  });
}

function handleAgentMessage(socket: Socket, message: AgentToServerMessage): void {
  if (message.type === "hello") return;
  const record = registry.get(message.instanceId);
  if (!record || record.socket !== socket) return;
  record.lastSeenAt = Date.now();

  if (message.type === "snapshot") {
    const updated = registry.updateSnapshot(message.instanceId, socket, message.snapshot);
    if (updated) broadcastAgent(updated);
    return;
  }
  if (message.type === "heartbeat") {
    const idleChanged = record.snapshot.meta.idle !== message.idle;
    const updated = registry.heartbeat(message.instanceId, socket, message.idle);
    if (idleChanged && updated) broadcastAgent(updated);
    return;
  }
  if (message.type === "event") {
    record.latestSequence = Math.max(record.latestSequence, message.sequence);
    registry.touchActivity(message.instanceId, socket, message.event);
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
      generation: record.generation,
      event: message.event,
    });
    return;
  }
  if (message.type === "command_result") pendingCommands.resolve(message);
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
  for (const browser of browsers.keys()) browser.close(1001, "server shutting down");
  clearInterval(heartbeatSweep);
  pendingCommands.dispose();
  completionTracker.dispose();
  agentServer.close();
  httpServer.close();
  await rm(socketPath, { force: true });
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
