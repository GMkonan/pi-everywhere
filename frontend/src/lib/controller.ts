import { get, writable } from "svelte/store";
import { touchAgentActivity } from "./session-list";
import { appendSystemMessage, applyTranscriptEvent, buildTranscript, emptyTranscriptState } from "./transcript";
import type {
  AppUiState,
  BrowserPromptImage,
  ComposerState,
  ConnectionStatus,
  LiveAgent,
  SessionListState,
} from "./types";

const PROTOCOL_VERSION = 1;
const DEVICE_CREDENTIAL_KEY = "pi-everywhere-device";
const LEGACY_TOKEN_KEY = "pi-everywhere-token";
const MAX_STATE_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_CACHE = 3;
const HISTORY_PAGE_SIZE = 16;
const HISTORY_RETRY_PAGE_SIZE = 8;
const HISTORY_REQUEST_TIMEOUT_MS = 20_000;
const BACKGROUND_RECONNECT_MS = 5_000;

const initialAppState: AppUiState = {
  connection: "offline",
  navigationOpen: true,
  settingsOpen: false,
  hasConversation: false,
  conversationName: "Session",
  conversationMeta: "",
  conversationTitle: "",
  tokenDialogOpen: false,
  notifications: {
    supported: false,
    active: false,
    warning: false,
    busy: false,
    label: "Enable notifications",
  },
};

export const sessionListState = writable<SessionListState>({ agents: [], syncing: false });
export const transcriptState = writable(emptyTranscriptState());
export const composerState = writable<ComposerState>({ connected: false, supportsImages: false, working: false });
export const promptResult = writable<{ commandId: string; ok: boolean; error?: string } | undefined>();
export const appState = writable<AppUiState>(initialAppState);

interface HistoryEvent {
  sequence: number;
  generation?: number;
  event: unknown;
}

interface ActiveHistoryRequest {
  instanceId: string;
  requestId: string;
  generation?: number;
  awaiting: boolean;
  events: HistoryEvent[];
  eventBytes: number;
  retryCount: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface OlderHistoryRequest {
  instanceId: string;
  requestId: string;
  offset: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface ControllerActionOverrides {
  selectSession?: (instanceId: string) => void;
  loadOlderHistory?: (instanceId: string) => void;
  sendPrompt?: (payload: PromptInput) => string | undefined;
}

interface PromptInput {
  text?: string;
  images?: BrowserPromptImage[];
  behavior: "followUp" | "steer";
}

const agents = new Map<string, LiveAgent>();
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectionEpoch = 0;
let selectedId: string | undefined;
let selectedRemovalTimer: ReturnType<typeof setTimeout> | undefined;
let activeHistoryRequest: ActiveHistoryRequest | undefined;
let olderHistoryRequest: OlderHistoryRequest | undefined;
let historyCacheOrder: string[] = [];
let stateResetCache: Map<string, LiveAgent> | undefined;
let backgroundedAt: number | undefined;
let settingsNavigationWasOpen = true;
let restoreSelectedOnReconnect = false;
let reconnectEnabled = true;
let stateSyncing = false;
let queuedServerMessages: unknown[] = [];
let queuedServerMessageBytes = 0;
let pendingSessionLink: string | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let actionOverrides: ControllerActionOverrides | undefined;

export function startController(): void {
  if (started) return;
  started = true;
  reconnectEnabled = true;
  pendingSessionLink = new URLSearchParams(location.search).get("session") ?? undefined;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  void exchangePairingCode().then(connect);
}

export function stopController(): void {
  if (!started) return;
  started = false;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("pageshow", handlePageShow);
  clearTimeout(reconnectTimer);
  clearTimeout(selectedRemovalTimer);
  clearTimeout(toastTimer);
  clearHistoryRequests();
  connectionEpoch += 1;
  reconnectEnabled = false;
  socket?.close();
  socket = undefined;
}

export function selectSession(instanceId: string): void {
  if (actionOverrides?.selectSession) {
    actionOverrides.selectSession(instanceId);
    return;
  }
  if (!agents.has(instanceId)) return;
  clearSelectedRemoval();
  clearHistoryRequests();
  selectedId = instanceId;
  publishAgents();
  publishSelected();
  setNavigation(false);
  requestHistory(instanceId);
}

export function loadOlderHistory(instanceId: string): void {
  if (actionOverrides?.loadOlderHistory) {
    actionOverrides.loadOlderHistory(instanceId);
    return;
  }
  const agent = agents.get(instanceId);
  if (!agent
    || selectedId !== instanceId
    || !agent.historyLoaded
    || !agent.historyHasOlder
    || !agent.meta.idle
    || olderHistoryRequest
    || socket?.readyState !== WebSocket.OPEN) return;

  const requestId = crypto.randomUUID();
  const offset = agent.historyLoadedCount ?? agent.snapshot?.entries?.length ?? 0;
  const timeout = setTimeout(() => {
    if (olderHistoryRequest?.requestId !== requestId) return;
    olderHistoryRequest = undefined;
    const current = agents.get(instanceId);
    if (current) {
      current.historyLoadingOlder = false;
      current.historyPreserve = true;
    }
    if (selectedId === instanceId) {
      publishSelected();
      if (current) current.historyPreserve = false;
      showToast("Older history timed out. Tap to try again.");
    }
  }, HISTORY_REQUEST_TIMEOUT_MS);
  olderHistoryRequest = { instanceId, requestId, offset, timeout };
  agent.historyLoadingOlder = true;
  agent.historyPreserve = true;
  publishSelected();
  agent.historyPreserve = false;
  sendSocket({
    v: PROTOCOL_VERSION,
    type: "history_request",
    instanceId,
    requestId,
    offset,
    limit: HISTORY_PAGE_SIZE,
    generation: agent.generation,
    snapshotSequence: agent.snapshotSequence,
  });
}

export function sendPrompt(payload: PromptInput): string | undefined {
  if (actionOverrides?.sendPrompt) return actionOverrides.sendPrompt(payload);
  const agent = selectedId ? agents.get(selectedId) : undefined;
  if (payload.images?.length && agent?.meta.supportsImages !== true) {
    showToast("The selected model does not support images.");
    return undefined;
  }
  return sendCommand("prompt", payload);
}

export function abortSelected(): void {
  sendCommand("abort");
}

export function openNavigation(): void {
  setNavigation(true);
}

export function closeNavigation(): void {
  setNavigation(false);
}

export function openSettings(): void {
  const current = get(appState);
  settingsNavigationWasOpen = current.navigationOpen;
  updateApp({ settingsOpen: true });
}

export function closeSettings(): void {
  updateApp({ settingsOpen: false, navigationOpen: settingsNavigationWasOpen });
}

export function reconnect(): void {
  restartConnection();
  showToast("Reconnecting…");
}

export function clearHistoryCache(): void {
  clearHistoryRequests();
  historyCacheOrder = [];
  for (const agent of agents.values()) {
    agent.snapshot = { ...agent.snapshot, entries: [] };
    agent.historyLoaded = false;
    agent.historyLoading = false;
    agent.historyLoadError = undefined;
    agent.historyHasOlder = false;
    agent.historyLoadedCount = 0;
    agent.historyLoadingOlder = false;
  }
  publishSelected();
  if (selectedId) requestHistory(selectedId, true);
  showToast("Cached history cleared.");
}

export function changeDeviceAccess(): void {
  closeSettings();
  reconnectEnabled = false;
  connectionEpoch += 1;
  clearTimeout(reconnectTimer);
  clearHistoryRequests();
  socket?.close();
  socket = undefined;
  clearStoredCredentials();
  setConnection("offline");
  updateApp({ tokenDialogOpen: true });
}

export function submitMasterToken(token: string): void {
  const credential = token.trim();
  if (!credential) return;
  sessionStorage.setItem(LEGACY_TOKEN_KEY, credential);
  reconnectEnabled = true;
  updateApp({ tokenDialogOpen: false });
  void connect();
}

export function dismissTokenDialog(): void {
  updateApp({ tokenDialogOpen: false });
}

export async function toggleNotifications(): Promise<void> {
  if (!notificationsSupported()) return;
  setNotificationState({ busy: true });
  let createdSubscription: PushSubscription | undefined;
  let registrationConfirmed = false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      const response = await authenticatedFetch("/api/push/subscription", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      if (!response.ok) throw new Error("Could not disable notifications");
      await existing.unsubscribe();
      showToast("Notifications disabled.");
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        showToast("Notification permission was not granted.");
        return;
      }
      const keyResponse = await authenticatedFetch("/api/push/public-key");
      if (!keyResponse.ok) throw new Error("Could not load the notification key");
      const result = await keyResponse.json() as { publicKey?: unknown };
      if (typeof result.publicKey !== "string") throw new Error("The notification key is invalid");
      createdSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(result.publicKey),
      });
      const response = await authenticatedFetch("/api/push/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createdSubscription.toJSON()),
      });
      if (!response.ok) throw new Error("Could not register notifications");
      registrationConfirmed = true;
      showToast("Notifications enabled.");
    }
  } catch (error) {
    if (createdSubscription && !registrationConfirmed) {
      try { await createdSubscription.unsubscribe(); }
      catch { /* The server registration already failed; local cleanup is best effort. */ }
    }
    showToast(error instanceof Error ? error.message : "Could not update notifications.");
  } finally {
    setNotificationState({ busy: false });
    await refreshNotificationState(false);
  }
}

/** Component-test seam; production never installs overrides or globals. */
export function setControllerActionOverridesForTest(overrides?: ControllerActionOverrides): void {
  actionOverrides = overrides;
}

async function connect(): Promise<void> {
  const epoch = ++connectionEpoch;
  const credential = currentCredential();
  if (!credential) {
    setConnection("offline");
    updateApp({ tokenDialogOpen: true });
    return;
  }

  clearTimeout(reconnectTimer);
  setConnection("connecting");
  try {
    const response = await fetch("/api/auth", {
      headers: { authorization: `Bearer ${credential}` },
      cache: "no-store",
    });
    if (epoch !== connectionEpoch) return;
    if (response.status === 401) {
      reconnectEnabled = false;
      clearStoredCredentials();
      setConnection("offline");
      updateApp({ tokenDialogOpen: true });
      return;
    }
    if (!response.ok) throw new Error(`Authentication check failed: ${response.status}`);
    void refreshNotificationState(true);
  } catch {
    if (epoch !== connectionEpoch) return;
    setConnection("offline");
    if (reconnectEnabled) reconnectTimer = setTimeout(() => void connect(), 2_000);
    return;
  }

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(`${scheme}//${location.host}/ws`);
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (epoch !== connectionEpoch) return;
    sendSocket({
      v: PROTOCOL_VERSION,
      type: "authenticate",
      credential,
      capabilities: ["lazy-history-v1", "paged-history-v1"],
    });
  });
  nextSocket.addEventListener("message", ({ data }) => {
    if (epoch !== connectionEpoch) return;
    try { handleServerMessage(JSON.parse(String(data)) as unknown); }
    catch { showSystem("Received an invalid message from the server."); }
  });
  nextSocket.addEventListener("close", () => {
    if (epoch !== connectionEpoch) return;
    clearHistoryRequests();
    socket = undefined;
    setConnection("offline");
    if (reconnectEnabled) reconnectTimer = setTimeout(() => void connect(), 2_000);
  });
}

function restartConnection(): void {
  clearTimeout(reconnectTimer);
  connectionEpoch += 1;
  clearHistoryRequests();
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  reconnectEnabled = true;
  void connect();
}

function handleServerMessage(value: unknown): void {
  const message = asRecord(value);
  if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") return;
  if (message.type === "authenticated") {
    setConnection("online");
    return;
  }
  if (message.type !== "state" && stateSyncing) {
    const messageBytes = encodedBytes(message);
    if (queuedServerMessages.length >= 1_000 || queuedServerMessageBytes + messageBytes > MAX_STATE_QUEUE_BYTES) {
      socket?.close(1013, "too many updates during state synchronization");
      return;
    }
    queuedServerMessages.push(message);
    queuedServerMessageBytes += messageBytes;
    return;
  }
  if (message.type === "state") {
    handleState(message);
    return;
  }
  if (message.type === "agent_upsert") {
    handleAgentUpsert(message);
    return;
  }
  if (message.type === "agent_history") {
    handleAgentHistory(message);
    return;
  }
  if (message.type === "agent_history_error") {
    handleHistoryError(message);
    return;
  }
  if (message.type === "agent_removed" && typeof message.instanceId === "string") {
    handleAgentRemoved(message.instanceId);
    return;
  }
  if (message.type === "agent_event") {
    handleAgentEvent(message);
    return;
  }
  if (message.type === "command_result") {
    if (typeof message.commandId === "string") {
      promptResult.set({
        commandId: message.commandId,
        ok: message.ok === true,
        ...(typeof message.error === "string" ? { error: message.error } : {}),
      });
    }
    if (selectedId === message.instanceId && message.ok !== true) {
      showSystem(`Command failed: ${typeof message.error === "string" ? message.error : "unknown error"}`);
    }
    return;
  }
  if (message.type === "error") showSystem(`Bridge error: ${String(message.error ?? "unknown error")}`);
}

function handleState(message: Record<string, unknown>): void {
  if (message.reset !== false) {
    stateResetCache = new Map(agents);
    agents.clear();
    clearHistoryRequests();
    queuedServerMessages = [];
    queuedServerMessageBytes = 0;
    stateSyncing = message.complete === false;
  }
  for (const value of arrayValue(message.agents)) {
    const agent = asLiveAgent(value);
    if (agent) agents.set(agent.instanceId, mergeCachedHistory(agent, stateResetCache?.get(agent.instanceId)));
  }
  if (message.complete === false) {
    publishAgents(true);
    return;
  }

  stateSyncing = false;
  stateResetCache = undefined;
  historyCacheOrder = historyCacheOrder.filter((instanceId) => agents.has(instanceId));
  const selectedMissing = Boolean(selectedId && !agents.has(selectedId));
  if (selectedMissing && selectedId) scheduleSelectedRemoval(selectedId, true);
  else clearSelectedRemoval();
  publishAgents();
  if (!selectedMissing) {
    publishSelected();
    if (selectedId) requestHistory(selectedId);
  }
  if (pendingSessionLink) {
    const target = pendingSessionLink;
    pendingSessionLink = undefined;
    history.replaceState({}, "", location.pathname);
    if (agents.has(target)) selectSession(target);
    else showToast("That Pi session is no longer live.");
  } else if (!selectedId || selectedMissing) {
    setNavigation(true);
  }
  const queued = queuedServerMessages;
  queuedServerMessages = [];
  queuedServerMessageBytes = 0;
  for (const queuedMessage of queued) handleServerMessage(queuedMessage);
}

function handleAgentUpsert(message: Record<string, unknown>): void {
  const incoming = asLiveAgent(message.agent);
  if (!incoming) return;
  const previous = agents.get(incoming.instanceId);
  const sameSession = previous?.meta.sessionId === incoming.meta.sessionId;
  if (sameSession && previous?.lastActivityAt) {
    incoming.lastActivityAt = Math.max(previous.lastActivityAt, incoming.lastActivityAt ?? incoming.connectedAt);
  }
  if (sameSession && previous?.historyLoaded) {
    incoming.snapshot = previous.snapshot;
    incoming.historyLoaded = true;
    incoming.historyHasOlder = previous.historyHasOlder;
    incoming.historyLoadedCount = previous.historyLoadedCount;
    incoming.historyLoadingOlder = previous.historyLoadingOlder;
  } else if (sameSession) {
    incoming.historyLoading = previous?.historyLoading;
    incoming.historyLoadError = previous?.historyLoadError;
  }
  if (activeHistoryRequest?.instanceId === incoming.instanceId
    && activeHistoryRequest.generation !== incoming.generation) {
    activeHistoryRequest.generation = incoming.generation;
    activeHistoryRequest.awaiting = true;
    activeHistoryRequest.events = [];
    activeHistoryRequest.eventBytes = 0;
    if (olderHistoryRequest) clearTimeout(olderHistoryRequest.timeout);
    olderHistoryRequest = undefined;
  }
  agents.set(incoming.instanceId, incoming);
  publishAgents();
  if (selectedId === incoming.instanceId) {
    const shouldRestoreSelection = restoreSelectedOnReconnect;
    clearSelectedRemoval();
    publishSelected();
    if (shouldRestoreSelection) setNavigation(false);
  }
}

function handleAgentHistory(message: Record<string, unknown>): void {
  const instanceId = stringValue(message.instanceId);
  const requestId = stringValue(message.requestId);
  const incoming = asLiveAgent(message.agent);
  const page = asRecord(message.page);
  if (!instanceId || !requestId || !incoming) return;

  if (olderHistoryRequest?.instanceId === instanceId && olderHistoryRequest.requestId === requestId) {
    const previous = agents.get(instanceId);
    const request = olderHistoryRequest;
    clearTimeout(request.timeout);
    olderHistoryRequest = undefined;
    if (!previous
      || selectedId !== instanceId
      || !previous.meta.idle
      || previous.generation !== incoming.generation
      || previous.snapshotSequence !== incoming.snapshotSequence
      || numberValue(page?.offset) !== request.offset) {
      if (previous) {
        previous.historyLoadingOlder = false;
        previous.historyPreserve = true;
        publishSelected();
        previous.historyPreserve = false;
      }
      showToast("History changed while loading. Try again.");
      return;
    }
    previous.snapshot = {
      ...previous.snapshot,
      entries: [...(incoming.snapshot?.entries ?? []), ...(previous.snapshot?.entries ?? [])],
    };
    previous.historyHasOlder = page?.hasOlder === true;
    previous.historyLoadedCount = request.offset + (numberValue(page?.count) ?? 0);
    previous.historyLoadingOlder = false;
    previous.historyPrepend = true;
    rememberHistory(instanceId);
    publishSelected();
    previous.historyPrepend = false;
    return;
  }

  if (activeHistoryRequest?.instanceId !== instanceId || activeHistoryRequest.requestId !== requestId) return;
  const previous = agents.get(instanceId);
  if (!previous
    || previous.meta.sessionId !== incoming.meta.sessionId
    || previous.generation !== incoming.generation
    || activeHistoryRequest.generation !== incoming.generation) {
    if (selectedId === instanceId) requestHistory(instanceId, true);
    return;
  }
  clearTimeout(activeHistoryRequest.timeout);
  const queuedEvents = activeHistoryRequest.awaiting ? activeHistoryRequest.events : [];
  if (olderHistoryRequest?.instanceId === instanceId) {
    clearTimeout(olderHistoryRequest.timeout);
    olderHistoryRequest = undefined;
  }
  incoming.lastActivityAt = Math.max(previous.lastActivityAt ?? 0, incoming.lastActivityAt ?? 0);
  incoming.historyLoaded = true;
  incoming.historyLoading = false;
  incoming.historyLoadError = undefined;
  incoming.historyHasOlder = page?.hasOlder === true;
  incoming.historyLoadedCount = numberValue(page?.count) ?? incoming.snapshot?.entries?.length ?? 0;
  incoming.historyLoadingOlder = false;
  agents.set(instanceId, incoming);
  rememberHistory(instanceId);
  activeHistoryRequest.awaiting = false;
  activeHistoryRequest.events = [];
  activeHistoryRequest.eventBytes = 0;
  publishAgents();
  if (selectedId === instanceId) {
    publishSelected();
    for (const queued of eventsAfterSnapshot(queuedEvents, incoming.snapshotSequence, incoming.generation)) {
      applyEvent(queued.event);
    }
  }
}

function handleHistoryError(message: Record<string, unknown>): void {
  const instanceId = stringValue(message.instanceId);
  const requestId = stringValue(message.requestId);
  const error = stringValue(message.error) || "History could not be loaded.";
  if (!instanceId || !requestId) return;
  if (olderHistoryRequest?.instanceId === instanceId && olderHistoryRequest.requestId === requestId) {
    clearTimeout(olderHistoryRequest.timeout);
    olderHistoryRequest = undefined;
    const agent = agents.get(instanceId);
    if (agent) {
      agent.historyLoadingOlder = false;
      agent.historyPreserve = true;
    }
    if (selectedId === instanceId) {
      publishSelected();
      if (agent) agent.historyPreserve = false;
      showToast(error);
    }
    return;
  }
  if (activeHistoryRequest?.instanceId !== instanceId || activeHistoryRequest.requestId !== requestId) return;
  clearTimeout(activeHistoryRequest.timeout);
  activeHistoryRequest = undefined;
  const agent = agents.get(instanceId);
  if (agent && !agent.historyLoaded) {
    agent.historyLoading = false;
    agent.historyLoadError = error;
  }
  if (selectedId === instanceId) {
    publishSelected();
    if (agent?.historyLoaded) showToast(error);
  }
}

function handleAgentRemoved(instanceId: string): void {
  agents.delete(instanceId);
  historyCacheOrder = historyCacheOrder.filter((cachedId) => cachedId !== instanceId);
  if (olderHistoryRequest?.instanceId === instanceId) {
    clearTimeout(olderHistoryRequest.timeout);
    olderHistoryRequest = undefined;
  }
  if (activeHistoryRequest?.instanceId === instanceId) {
    clearTimeout(activeHistoryRequest.timeout);
    activeHistoryRequest.awaiting = true;
    activeHistoryRequest.events = [];
    activeHistoryRequest.eventBytes = 0;
  }
  const selectedWasRemoved = selectedId === instanceId;
  publishAgents();
  if (!selectedWasRemoved) publishSelected();
  if (selectedWasRemoved) scheduleSelectedRemoval(instanceId, false);
}

function handleAgentEvent(message: Record<string, unknown>): void {
  const instanceId = stringValue(message.instanceId);
  if (!instanceId) return;
  const agent = agents.get(instanceId);
  const generation = numberValue(message.generation);
  if (agent && generation !== agent.generation) return;
  if (agent) {
    let listChanged = touchAgentActivity(agent, message.event);
    const event = asRecord(message.event);
    if (event?.type === "agent_start" && agent.meta.idle) {
      agent.meta.idle = false;
      if (olderHistoryRequest?.instanceId === instanceId) {
        clearTimeout(olderHistoryRequest.timeout);
        olderHistoryRequest = undefined;
        agent.historyLoadingOlder = false;
      }
      listChanged = true;
    }
    if (event?.type === "agent_settled" && !agent.meta.idle) {
      agent.meta.idle = true;
      listChanged = true;
    }
    if (listChanged) publishAgents();
    if (selectedId === instanceId && listChanged) {
      agent.historyPreserve = true;
      publishSelected();
      agent.historyPreserve = false;
    } else if (selectedId === instanceId) {
      publishComposer(agent);
    }
  }
  if (selectedId !== instanceId) return;
  if (activeHistoryRequest?.instanceId === instanceId && activeHistoryRequest.awaiting) {
    const eventBytes = encodedBytes(message.event);
    if (activeHistoryRequest.events.length >= 1_000
      || activeHistoryRequest.eventBytes + eventBytes > MAX_STATE_QUEUE_BYTES) {
      socket?.close(1013, "too many updates while loading history");
      return;
    }
    activeHistoryRequest.events.push({
      sequence: numberValue(message.sequence) ?? 0,
      generation,
      event: message.event,
    });
    activeHistoryRequest.eventBytes += eventBytes;
  } else {
    applyEvent(message.event);
  }
}

function requestHistory(instanceId: string, force = false): void {
  const agent = agents.get(instanceId);
  if (!agent || socket?.readyState !== WebSocket.OPEN) return;
  if (!force && activeHistoryRequest?.instanceId === instanceId && activeHistoryRequest.awaiting) return;
  if (activeHistoryRequest) clearTimeout(activeHistoryRequest.timeout);
  const requestId = crypto.randomUUID();
  if (!agent.historyLoaded) {
    agent.historyLoading = true;
    agent.historyLoadError = undefined;
  }
  activeHistoryRequest = {
    instanceId,
    requestId,
    generation: agent.generation,
    awaiting: true,
    events: [],
    eventBytes: 0,
    retryCount: 0,
  };
  activeHistoryRequest.timeout = armHistoryTimeout(activeHistoryRequest);
  sendSocket({
    v: PROTOCOL_VERSION,
    type: "history_request",
    instanceId,
    requestId,
    limit: HISTORY_PAGE_SIZE,
  });
  if (!agent.historyLoaded && selectedId === instanceId) publishSelected();
}

function armHistoryTimeout(request: ActiveHistoryRequest): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (activeHistoryRequest?.requestId !== request.requestId) return;
    if (request.retryCount === 0 && socket?.readyState === WebSocket.OPEN) {
      request.retryCount = 1;
      request.timeout = armHistoryTimeout(request);
      sendSocket({
        v: PROTOCOL_VERSION,
        type: "history_request",
        instanceId: request.instanceId,
        requestId: request.requestId,
        limit: HISTORY_RETRY_PAGE_SIZE,
      });
      return;
    }
    activeHistoryRequest = undefined;
    const current = agents.get(request.instanceId);
    if (current && !current.historyLoaded) {
      current.historyLoading = false;
      current.historyLoadError = "The connection did not return history in time.";
    }
    if (selectedId === request.instanceId) {
      publishSelected();
      if (current?.historyLoaded) showToast("History refresh timed out. Showing the cached copy.");
    }
  }, HISTORY_REQUEST_TIMEOUT_MS);
}

function clearHistoryRequests(): void {
  if (activeHistoryRequest) clearTimeout(activeHistoryRequest.timeout);
  if (olderHistoryRequest) {
    clearTimeout(olderHistoryRequest.timeout);
    const agent = agents.get(olderHistoryRequest.instanceId);
    if (agent) agent.historyLoadingOlder = false;
  }
  activeHistoryRequest = undefined;
  olderHistoryRequest = undefined;
}

function mergeCachedHistory(agent: LiveAgent, cached?: LiveAgent): LiveAgent {
  if (!cached?.historyLoaded || cached.meta.sessionId !== agent.meta.sessionId) return agent;
  return {
    ...agent,
    snapshot: cached.snapshot,
    historyLoaded: true,
    historyHasOlder: cached.historyHasOlder,
    historyLoadedCount: cached.historyLoadedCount,
    historyLoadingOlder: false,
  };
}

function rememberHistory(instanceId: string): void {
  historyCacheOrder = historyCacheOrder.filter((cachedId) => cachedId !== instanceId);
  historyCacheOrder.push(instanceId);
  while (historyCacheOrder.length > MAX_HISTORY_CACHE) {
    const evictedId = historyCacheOrder.shift();
    if (!evictedId || evictedId === selectedId) continue;
    const agent = agents.get(evictedId);
    if (!agent) continue;
    agent.snapshot = { ...agent.snapshot, entries: [] };
    agent.historyLoaded = false;
    agent.historyHasOlder = false;
    agent.historyLoadedCount = 0;
    agent.historyLoadingOlder = false;
  }
}

function publishAgents(syncing = false): void {
  sessionListState.set({ agents: [...agents.values()], ...(selectedId ? { selectedId } : {}), syncing });
}

function publishSelected(): void {
  const agent = selectedId ? agents.get(selectedId) : undefined;
  if (!agent) {
    updateApp({ hasConversation: false, conversationName: "Session", conversationMeta: "", conversationTitle: "" });
    publishComposer();
    return;
  }
  const model = agent.meta.model?.split("/").at(-1) || "unknown model";
  const cwdName = basename(agent.meta.cwd) || agent.meta.cwd;
  updateApp({
    hasConversation: true,
    conversationName: sessionName(agent),
    conversationMeta: `${cwdName} · ${model}`,
    conversationTitle: `${agent.meta.cwd} · PID ${agent.meta.pid} · ${agent.meta.model || "unknown model"}`,
  });
  transcriptState.set(buildTranscript({
    instanceId: agent.instanceId,
    entries: agent.snapshot?.entries ?? [],
    historyTruncated: Boolean(agent.snapshot?.historyTruncated),
    omittedEntries: agent.snapshot?.omittedEntries,
    loading: !agent.historyLoaded && agent.historyLoading !== false,
    loadError: agent.historyLoadError,
    hasOlder: agent.historyHasOlder === true,
    loadingOlder: agent.historyLoadingOlder === true,
    canLoadOlder: agent.meta.idle,
    scrollMode: agent.historyPrepend ? "prepend" : agent.historyPreserve ? "preserve" : "bottom",
  }));
  publishComposer(agent);
}

function publishComposer(agent = selectedId ? agents.get(selectedId) : undefined): void {
  composerState.set({
    ...(agent ? { selectedId: agent.instanceId } : {}),
    connected: socket?.readyState === WebSocket.OPEN && get(appState).connection === "online",
    supportsImages: agent?.meta.supportsImages === true,
    working: Boolean(agent && !agent.meta.idle),
  });
}

function applyEvent(event: unknown): void {
  transcriptState.update((state) => applyTranscriptEvent(state, event));
}

function showSystem(text: string): void {
  if (!selectedId) return;
  transcriptState.update((state) => appendSystemMessage(state, text));
}

function sendCommand(command: "prompt" | "abort" | "snapshot", payload?: PromptInput): string | undefined {
  if (!selectedId || socket?.readyState !== WebSocket.OPEN) {
    showSystem("Not connected. Your message was not sent.");
    return undefined;
  }
  const commandId = crypto.randomUUID();
  sendSocket({
    v: PROTOCOL_VERSION,
    type: "command",
    instanceId: selectedId,
    commandId,
    command,
    ...(payload ? { payload } : {}),
  });
  return commandId;
}

function sendSocket(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setNavigation(open: boolean): void {
  const hasSelected = Boolean(selectedId);
  updateApp({ navigationOpen: open || !hasSelected });
}

function clearSelectedRemoval(): void {
  clearTimeout(selectedRemovalTimer);
  selectedRemovalTimer = undefined;
  restoreSelectedOnReconnect = false;
}

function scheduleSelectedRemoval(instanceId: string, restoreOnReconnect: boolean): void {
  clearSelectedRemoval();
  restoreSelectedOnReconnect = restoreOnReconnect;
  selectedRemovalTimer = setTimeout(() => {
    selectedRemovalTimer = undefined;
    if (selectedId === instanceId && !agents.has(instanceId)) {
      selectedId = undefined;
      restoreSelectedOnReconnect = false;
      publishAgents();
      publishSelected();
      setNavigation(true);
    }
  }, 5_000);
}

function showToast(text: string): void {
  clearTimeout(toastTimer);
  updateApp({ toast: text });
  toastTimer = setTimeout(() => updateApp({ toast: undefined }), 3_500);
}

function setConnection(connection: ConnectionStatus): void {
  updateApp({ connection });
  publishComposer();
}

function updateApp(patch: Partial<AppUiState>): void {
  appState.update((state) => ({ ...state, ...patch }));
}

function setNotificationState(patch: Partial<AppUiState["notifications"]>): void {
  appState.update((state) => ({
    ...state,
    notifications: { ...state.notifications, ...patch },
  }));
}

async function refreshNotificationState(syncWithServer: boolean): Promise<void> {
  if (!notificationsSupported()) {
    setNotificationState({ supported: false, active: false, warning: false, busy: false });
    return;
  }
  let localSubscription: PushSubscription | null = null;
  try {
    const registration = await navigator.serviceWorker.ready;
    localSubscription = await registration.pushManager.getSubscription();
    let confirmed = Boolean(localSubscription && Notification.permission === "granted");
    if (confirmed && syncWithServer && localSubscription) {
      const response = await authenticatedFetch("/api/push/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localSubscription.toJSON()),
      });
      confirmed = response.ok;
    }
    setNotificationState({
      supported: true,
      active: confirmed,
      warning: Boolean(localSubscription) && !confirmed,
      label: confirmed
        ? "Disable notifications"
        : localSubscription
          ? "Notifications need attention"
          : "Enable notifications",
    });
  } catch {
    setNotificationState({
      supported: true,
      active: false,
      warning: Boolean(localSubscription),
      label: localSubscription ? "Notifications need attention" : "Enable notifications",
    });
  }
}

function notificationsSupported(): boolean {
  return globalThis.isSecureContext === true
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function currentCredential(): string | null {
  try {
    return localStorage.getItem(DEVICE_CREDENTIAL_KEY) ?? sessionStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return sessionStorage.getItem(LEGACY_TOKEN_KEY);
  }
}

function clearStoredCredentials(): void {
  try { localStorage.removeItem(DEVICE_CREDENTIAL_KEY); }
  catch { /* Storage can be unavailable in restricted browser modes. */ }
  sessionStorage.removeItem(LEGACY_TOKEN_KEY);
}

async function exchangePairingCode(): Promise<void> {
  const url = new URL(location.href);
  const code = url.searchParams.get("pair");
  if (!code) return;
  url.searchParams.delete("pair");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  setConnection("pairing");
  try {
    const response = await fetch("/api/pair/exchange", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: mobileDeviceName() }),
    });
    const result = await response.json() as { error?: unknown; device?: { credential?: unknown } };
    if (!response.ok || typeof result.device?.credential !== "string") {
      throw new Error(typeof result.error === "string" ? result.error : "Pairing failed");
    }
    localStorage.setItem(DEVICE_CREDENTIAL_KEY, result.device.credential);
    if (localStorage.getItem(DEVICE_CREDENTIAL_KEY) !== result.device.credential) {
      throw new Error("The browser could not persist the device credential");
    }
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
    reconnectEnabled = true;
    showToast("Device paired successfully.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Pairing failed.");
  }
}

function mobileDeviceName(): string {
  const browser = /SamsungBrowser/u.test(navigator.userAgent)
    ? "Samsung Internet"
    : /CriOS|Chrome/u.test(navigator.userAgent)
      ? "Chrome"
      : "Browser";
  const platform = /Android/u.test(navigator.userAgent)
    ? "Android"
    : /iPhone|iPad/u.test(navigator.userAgent)
      ? "iOS"
      : navigator.platform || "device";
  return `${browser} PWA on ${platform}`;
}

function authenticatedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const credential = currentCredential();
  return fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.headers ?? {}),
      authorization: `Bearer ${credential ?? ""}`,
    },
  });
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    backgroundedAt = Date.now();
    return;
  }
  const slept = backgroundedAt ? Date.now() - backgroundedAt : 0;
  backgroundedAt = undefined;
  if (slept >= BACKGROUND_RECONNECT_MS || socket?.readyState !== WebSocket.OPEN) restartConnection();
}

function handlePageShow(event: PageTransitionEvent): void {
  if (event.persisted) restartConnection();
}

function eventsAfterSnapshot(events: HistoryEvent[], snapshotSequence: number | undefined, generation: number | undefined): HistoryEvent[] {
  const representedThrough = Number.isFinite(snapshotSequence) ? snapshotSequence ?? 0 : 0;
  return events.filter((item) => item.generation === generation && item.sequence > representedThrough);
}

function asLiveAgent(value: unknown): LiveAgent | undefined {
  const agent = asRecord(value);
  const meta = asRecord(agent?.meta);
  if (!agent
    || !meta
    || typeof agent.instanceId !== "string"
    || typeof meta.cwd !== "string"
    || typeof meta.pid !== "number"
    || typeof meta.idle !== "boolean") return undefined;
  const snapshot = asRecord(agent.snapshot);
  return {
    ...(agent as unknown as LiveAgent),
    instanceId: agent.instanceId,
    connectedAt: numberValue(agent.connectedAt) ?? Date.now(),
    meta: { ...(meta as unknown as LiveAgent["meta"]) },
    ...(snapshot
      ? { snapshot: { ...(snapshot as unknown as LiveAgent["snapshot"]), entries: arrayValue(snapshot.entries) } }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function encodedBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return MAX_STATE_QUEUE_BYTES + 1; }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function sessionName(agent: LiveAgent): string {
  return agent.meta.sessionName || basename(agent.meta.cwd) || `Pi ${agent.meta.pid}`;
}
