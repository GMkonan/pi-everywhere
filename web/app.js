import { eventsAfterSnapshot } from "./history-sync.js";
import { renderMarkdown } from "./markdown.js";
import {
  agentActivityAt,
  formatActivityTime,
  groupAgentsByDate,
  touchAgentActivity,
} from "./session-list.js";

const PROTOCOL_VERSION = 1;
const DEVICE_CREDENTIAL_KEY = "pi-everywhere-device";
const LEGACY_TOKEN_KEY = "pi-everywhere-token";
const MAX_STATE_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_CACHE = 3;
const HISTORY_PAGE_SIZE = 16;
const HISTORY_RETRY_PAGE_SIZE = 8;
const HISTORY_REQUEST_TIMEOUT_MS = 20_000;
const BACKGROUND_RECONNECT_MS = 5_000;
const WORKING_PHRASES = [
  "Forging code…",
  "Connecting the dots…",
  "Shaping the answer…",
  "Following the thread…",
  "Working through it…",
  "Almost there…",
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const agents = new Map();
let socket;
let reconnectTimer;
let connectionEpoch = 0;
let selectedId;
let selectedRemovalTimer;
let activeHistoryRequest;
let olderHistoryRequest;
let historyCacheOrder = [];
let stateResetCache;
let backgroundedAt;
let settingsNavigationWasOpen = true;
let restoreSelectedOnReconnect = false;
let reconnectEnabled = true;
let stateSyncing = false;
let queuedServerMessages = [];
let queuedServerMessageBytes = 0;
let rebuildingTranscript = false;
let workingSpinnerTimer;
let workingPhraseTimer;
let toastTimer;
let pendingSessionLink = new URLSearchParams(location.search).get("session");
let transcriptState = createTranscriptState();

const elements = {
  agents: document.querySelector("#agents"),
  agentCount: document.querySelector("#agent-count"),
  connection: document.querySelector("#connection-status"),
  connectionDot: document.querySelector("#connection-dot"),
  navigation: document.querySelector("#session-index"),
  openNavigation: document.querySelector("#open-navigation"),
  closeNavigation: document.querySelector("#close-navigation"),
  openSettings: document.querySelector("#open-settings"),
  closeSettings: document.querySelector("#close-settings"),
  settings: document.querySelector("#settings-view"),
  settingsConnection: document.querySelector("#settings-connection-status"),
  settingsConnectionDot: document.querySelector("#settings-connection-dot"),
  reconnect: document.querySelector("#reconnect"),
  clearHistoryCache: document.querySelector("#clear-history-cache"),
  view: document.querySelector("#session-view"),
  name: document.querySelector("#session-name"),
  meta: document.querySelector("#session-meta"),
  transcript: document.querySelector("#transcript"),
  form: document.querySelector("#prompt-form"),
  prompt: document.querySelector("#prompt"),
  abort: document.querySelector("#abort"),
  tokenDialog: document.querySelector("#token-dialog"),
  tokenForm: document.querySelector("#token-form"),
  token: document.querySelector("#token"),
  changeToken: document.querySelector("#change-token"),
  notifications: document.querySelector("#notifications"),
  workingIndicator: document.querySelector("#working-indicator"),
  workingSpinner: document.querySelector("#working-spinner"),
  workingPhrase: document.querySelector("#working-phrase"),
  toast: document.querySelector("#toast"),
};

globalThis.__PI_EVERYWHERE_SVELTE__?.bindActions({ selectAgent, loadOlderHistory, sendPrompt });

async function connect() {
  const epoch = ++connectionEpoch;
  const credential = currentCredential();
  if (!credential) {
    if (!elements.tokenDialog.open) elements.tokenDialog.showModal();
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
      if (!elements.tokenDialog.open) elements.tokenDialog.showModal();
      return;
    }
    if (!response.ok) throw new Error(`Authentication check failed: ${response.status}`);
    void refreshNotificationState(true);
  } catch {
    if (epoch !== connectionEpoch) return;
    setConnection("offline");
    if (reconnectEnabled) reconnectTimer = setTimeout(() => void connect(), 2000);
    return;
  }

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(`${scheme}//${location.host}/ws`);
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    if (epoch !== connectionEpoch) return;
    nextSocket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "authenticate",
      credential,
      capabilities: globalThis.__PI_EVERYWHERE_SVELTE__
        ? ["lazy-history-v1", "paged-history-v1"]
        : ["lazy-history-v1"],
    }));
  });
  nextSocket.addEventListener("message", ({ data }) => {
    if (epoch !== connectionEpoch) return;
    try { handleServerMessage(JSON.parse(data)); }
    catch { showSystem("Received an invalid message from the server."); }
  });
  nextSocket.addEventListener("close", () => {
    if (epoch !== connectionEpoch) return;
    clearHistoryRequests();
    socket = undefined;
    setConnection("offline");
    if (reconnectEnabled) reconnectTimer = setTimeout(() => void connect(), 2000);
  });
}

function restartConnection() {
  clearTimeout(reconnectTimer);
  connectionEpoch += 1;
  clearHistoryRequests();
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  if (reconnectEnabled) void connect();
}

function handleServerMessage(message) {
  if (message.v !== PROTOCOL_VERSION) return;
  if (message.type === "authenticated") {
    setConnection("online");
    return;
  }
  if (message.type !== "state" && stateSyncing) {
    const messageBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (queuedServerMessages.length >= 1000 || queuedServerMessageBytes + messageBytes > MAX_STATE_QUEUE_BYTES) {
      socket?.close(1013, "too many updates during state synchronization");
      return;
    }
    queuedServerMessages.push(message);
    queuedServerMessageBytes += messageBytes;
    return;
  }
  if (message.type === "state") {
    if (message.reset !== false) {
      stateResetCache = new Map(agents);
      agents.clear();
      clearHistoryRequests();
      queuedServerMessages = [];
      queuedServerMessageBytes = 0;
      stateSyncing = message.complete === false;
    }
    for (const agent of message.agents ?? []) {
      agents.set(agent.instanceId, mergeCachedHistory(agent, stateResetCache?.get(agent.instanceId)));
    }
    if (message.complete === false) {
      renderAgents(true);
      return;
    }
    stateSyncing = false;
    stateResetCache = undefined;
    historyCacheOrder = historyCacheOrder.filter((instanceId) => agents.has(instanceId));

    const selectedMissing = Boolean(selectedId && !agents.has(selectedId));
    if (selectedMissing) scheduleSelectedRemoval(selectedId, true);
    else clearSelectedRemoval();
    renderAgents();
    if (!selectedMissing) {
      renderSelected();
      if (selectedId) requestHistory(selectedId);
    }
    if (pendingSessionLink) {
      const target = pendingSessionLink;
      pendingSessionLink = undefined;
      history.replaceState({}, "", location.pathname);
      if (agents.has(target)) selectAgent(target);
      else showToast("That Pi session is no longer live.");
    } else if (!selectedId || selectedMissing) {
      setNavigation(true);
    }
    const queued = queuedServerMessages;
    queuedServerMessages = [];
    queuedServerMessageBytes = 0;
    for (const queuedMessage of queued) handleServerMessage(queuedMessage);
    return;
  }
  if (message.type === "agent_upsert") {
    const previous = agents.get(message.agent.instanceId);
    const sameSession = previous?.meta?.sessionId === message.agent.meta?.sessionId;
    if (sameSession && previous?.lastActivityAt) {
      message.agent.lastActivityAt = Math.max(previous.lastActivityAt, agentActivityAt(message.agent));
    }
    if (sameSession && previous?.historyLoaded) {
      message.agent.snapshot = previous.snapshot;
      message.agent.historyLoaded = true;
      message.agent.historyHasOlder = previous.historyHasOlder;
      message.agent.historyLoadedCount = previous.historyLoadedCount;
      message.agent.historyLoadingOlder = previous.historyLoadingOlder;
    } else if (sameSession) {
      message.agent.historyLoading = previous?.historyLoading;
      message.agent.historyLoadError = previous?.historyLoadError;
    }
    if (activeHistoryRequest?.instanceId === message.agent.instanceId && activeHistoryRequest.generation !== message.agent.generation) {
      activeHistoryRequest.generation = message.agent.generation;
      activeHistoryRequest.awaiting = true;
      activeHistoryRequest.events = [];
      activeHistoryRequest.eventBytes = 0;
      if (olderHistoryRequest) clearTimeout(olderHistoryRequest.timeout);
      olderHistoryRequest = undefined;
    }
    agents.set(message.agent.instanceId, message.agent);
    renderAgents();
    if (selectedId === message.agent.instanceId) {
      const navigationWasOpen = !elements.navigation.classList.contains("closed");
      const shouldRestoreSelection = restoreSelectedOnReconnect;
      clearSelectedRemoval();
      renderSelected();
      setNavigation(shouldRestoreSelection ? false : navigationWasOpen);
    }
    return;
  }
  if (message.type === "agent_history") {
    if (olderHistoryRequest?.instanceId === message.instanceId && olderHistoryRequest.requestId === message.requestId) {
      const previous = agents.get(message.instanceId);
      const request = olderHistoryRequest;
      clearTimeout(request.timeout);
      olderHistoryRequest = undefined;
      if (!previous
        || selectedId !== message.instanceId
        || !previous.meta.idle
        || previous.generation !== message.agent?.generation
        || previous.snapshotSequence !== message.agent?.snapshotSequence
        || message.page?.offset !== request.offset) {
        if (previous) {
          previous.historyLoadingOlder = false;
          previous.historyPreserve = true;
          renderSelected();
          previous.historyPreserve = false;
        }
        showToast("History changed while loading. Try again.");
        return;
      }
      previous.snapshot = {
        ...previous.snapshot,
        entries: [...(message.agent.snapshot?.entries ?? []), ...(previous.snapshot?.entries ?? [])],
      };
      previous.historyHasOlder = message.page?.hasOlder === true;
      previous.historyLoadedCount = request.offset + (message.page?.count ?? 0);
      previous.historyLoadingOlder = false;
      previous.historyPrepend = true;
      rememberHistory(message.instanceId);
      renderSelected();
      previous.historyPrepend = false;
      return;
    }
    if (activeHistoryRequest?.instanceId !== message.instanceId || activeHistoryRequest.requestId !== message.requestId) return;
    const previous = agents.get(message.instanceId);
    if (!previous
      || previous.meta?.sessionId !== message.agent?.meta?.sessionId
      || previous.generation !== message.agent?.generation
      || activeHistoryRequest.generation !== message.agent?.generation) {
      if (selectedId === message.instanceId) requestHistory(message.instanceId, true);
      return;
    }
    clearTimeout(activeHistoryRequest.timeout);
    const queuedEvents = activeHistoryRequest.awaiting ? activeHistoryRequest.events : [];
    if (olderHistoryRequest?.instanceId === message.instanceId) {
      clearTimeout(olderHistoryRequest.timeout);
      olderHistoryRequest = undefined;
    }
    const agent = {
      ...message.agent,
      lastActivityAt: Math.max(previous.lastActivityAt ?? 0, message.agent.lastActivityAt ?? 0),
      historyLoaded: true,
      historyLoading: false,
      historyLoadError: undefined,
      historyHasOlder: message.page?.hasOlder === true,
      historyLoadedCount: message.page?.count ?? message.agent.snapshot?.entries?.length ?? 0,
      historyLoadingOlder: false,
    };
    agents.set(message.instanceId, agent);
    rememberHistory(message.instanceId);
    activeHistoryRequest.awaiting = false;
    activeHistoryRequest.events = [];
    activeHistoryRequest.eventBytes = 0;
    renderAgents();
    if (selectedId === message.instanceId) {
      renderSelected();
      for (const queued of eventsAfterSnapshot(queuedEvents, message.agent.snapshotSequence, message.agent.generation)) {
        applyEvent(queued.event);
      }
    }
    return;
  }
  if (message.type === "agent_history_error") {
    if (olderHistoryRequest?.instanceId === message.instanceId && olderHistoryRequest.requestId === message.requestId) {
      clearTimeout(olderHistoryRequest.timeout);
      olderHistoryRequest = undefined;
      const agent = agents.get(message.instanceId);
      if (agent) {
        agent.historyLoadingOlder = false;
        agent.historyPreserve = true;
      }
      if (selectedId === message.instanceId) {
        renderSelected();
        if (agent) agent.historyPreserve = false;
        showToast(message.error || "Older history could not be loaded.");
      }
      return;
    }
    if (activeHistoryRequest?.instanceId !== message.instanceId || activeHistoryRequest.requestId !== message.requestId) return;
    clearTimeout(activeHistoryRequest.timeout);
    activeHistoryRequest = undefined;
    const agent = agents.get(message.instanceId);
    if (agent && !agent.historyLoaded) {
      agent.historyLoading = false;
      agent.historyLoadError = message.error || "History could not be loaded.";
    }
    if (selectedId === message.instanceId) {
      renderSelected();
      if (agent?.historyLoaded) showToast(message.error || "History could not be refreshed.");
    }
    return;
  }
  if (message.type === "agent_removed") {
    agents.delete(message.instanceId);
    historyCacheOrder = historyCacheOrder.filter((instanceId) => instanceId !== message.instanceId);
    if (olderHistoryRequest?.instanceId === message.instanceId) {
      clearTimeout(olderHistoryRequest.timeout);
      olderHistoryRequest = undefined;
    }
    if (activeHistoryRequest?.instanceId === message.instanceId) {
      clearTimeout(activeHistoryRequest.timeout);
      activeHistoryRequest.awaiting = true;
      activeHistoryRequest.events = [];
      activeHistoryRequest.eventBytes = 0;
    }
    const selectedWasRemoved = selectedId === message.instanceId;
    renderAgents();
    if (!selectedWasRemoved) renderSelected();
    if (selectedWasRemoved) {
      // Keep the current conversation visible during a short bridge reconnect.
      // A busy extension can intentionally reconnect when a fresh snapshot meets
      // its backpressure cap; replacing the chat with the session index causes a flash.
      scheduleSelectedRemoval(message.instanceId, false);
    }
    return;
  }
  if (message.type === "agent_event") {
    const agent = agents.get(message.instanceId);
    if (agent && message.generation !== agent.generation) return;
    if (agent) {
      let listChanged = touchAgentActivity(agent, message.event);
      if (message.event?.type === "agent_start" && agent.meta.idle) {
        agent.meta.idle = false;
        if (olderHistoryRequest?.instanceId === message.instanceId) {
          clearTimeout(olderHistoryRequest.timeout);
          olderHistoryRequest = undefined;
          agent.historyLoadingOlder = false;
        }
        listChanged = true;
      }
      if (message.event?.type === "agent_settled" && !agent.meta.idle) {
        agent.meta.idle = true;
        listChanged = true;
      }
      if (listChanged) renderAgents();
      if (selectedId === message.instanceId) {
        if (listChanged) {
          agent.historyPreserve = true;
          renderSelected();
          agent.historyPreserve = false;
        }
        syncWorkingIndicator();
      }
    }
    if (selectedId === message.instanceId) {
      if (activeHistoryRequest?.instanceId === message.instanceId && activeHistoryRequest.awaiting) {
        const eventBytes = new TextEncoder().encode(JSON.stringify(message.event)).byteLength;
        if (activeHistoryRequest.events.length >= 1000 || activeHistoryRequest.eventBytes + eventBytes > MAX_STATE_QUEUE_BYTES) {
          socket?.close(1013, "too many updates while loading history");
          return;
        }
        activeHistoryRequest.events.push({
          sequence: message.sequence,
          generation: message.generation,
          event: message.event,
        });
        activeHistoryRequest.eventBytes += eventBytes;
      } else {
        applyEvent(message.event);
      }
    }
    return;
  }
  if (message.type === "command_result") {
    globalThis.__PI_EVERYWHERE_SVELTE__?.resolvePrompt(message.commandId, message.ok === true, message.error);
    if (selectedId === message.instanceId && !message.ok) {
      showSystem(`Command failed: ${message.error ?? "unknown error"}`);
    }
  }
  if (message.type === "error") showSystem(`Bridge error: ${message.error}`);
}

function renderAgents(syncing = false) {
  elements.agentCount.textContent = syncing ? `${agents.size} loading…` : `${agents.size} live`;
  const svelteBridge = globalThis.__PI_EVERYWHERE_SVELTE__;
  if (svelteBridge) {
    svelteBridge.renderSessionList({
      agents: [...agents.values()],
      selectedId,
      syncing,
    });
    return;
  }
  elements.agents.replaceChildren();

  if (agents.size === 0) {
    const empty = div("No live Pi sessions. Start Pi with the extension loaded to see it here.", "sessions-empty");
    elements.agents.append(empty);
    return;
  }

  for (const group of groupAgentsByDate(agents.values())) {
    const section = document.createElement("section");
    section.className = "session-group";
    const heading = document.createElement("h2");
    heading.textContent = group.label;
    section.append(heading);

    for (const agent of group.agents) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `session-row${agent.instanceId === selectedId ? " selected" : ""}`;
      const name = sessionName(agent);
      const icon = div("π", `session-icon${agent.meta.idle ? "" : " working"}`);
      const summary = div("", "session-summary");
      summary.append(
        element("strong", name),
        element("small", `${basename(agent.meta.cwd) || agent.meta.cwd} · ${agent.meta.idle ? "idle" : "working"}`),
      );
      const time = document.createElement("time");
      const activity = agentActivityAt(agent);
      time.dateTime = new Date(activity).toISOString();
      time.textContent = formatActivityTime(activity);
      button.append(icon, summary, time);
      button.title = agent.meta.cwd;
      button.addEventListener("click", () => selectAgent(agent.instanceId));
      section.append(button);
    }
    elements.agents.append(section);
  }
}

function clearSelectedRemoval() {
  clearTimeout(selectedRemovalTimer);
  selectedRemovalTimer = undefined;
  restoreSelectedOnReconnect = false;
}

function scheduleSelectedRemoval(instanceId, restoreOnReconnect) {
  clearSelectedRemoval();
  restoreSelectedOnReconnect = restoreOnReconnect;
  selectedRemovalTimer = setTimeout(() => {
    selectedRemovalTimer = undefined;
    if (selectedId === instanceId && !agents.has(instanceId)) {
      selectedId = undefined;
      restoreSelectedOnReconnect = false;
      renderAgents();
      renderSelected();
      setNavigation(true);
    }
  }, 5_000);
}

function selectAgent(instanceId) {
  clearSelectedRemoval();
  clearHistoryRequests();
  selectedId = instanceId;
  renderAgents();
  renderSelected();
  setNavigation(false);
  requestHistory(instanceId);
}

function requestHistory(instanceId, force = false) {
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
  socket.send(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "history_request",
    instanceId,
    requestId,
    limit: HISTORY_PAGE_SIZE,
  }));
  if (!agent.historyLoaded && selectedId === instanceId) renderSelected();
}

function armHistoryTimeout(request) {
  return setTimeout(() => {
    if (activeHistoryRequest?.requestId !== request.requestId) return;
    if (request.retryCount === 0 && socket?.readyState === WebSocket.OPEN) {
      request.retryCount = 1;
      request.timeout = armHistoryTimeout(request);
      socket.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "history_request",
        instanceId: request.instanceId,
        requestId: request.requestId,
        limit: HISTORY_RETRY_PAGE_SIZE,
      }));
      return;
    }
    activeHistoryRequest = undefined;
    const current = agents.get(request.instanceId);
    if (current && !current.historyLoaded) {
      current.historyLoading = false;
      current.historyLoadError = "The connection did not return history in time.";
    }
    if (selectedId === request.instanceId) {
      renderSelected();
      if (current?.historyLoaded) showToast("History refresh timed out. Showing the cached copy.");
    }
  }, HISTORY_REQUEST_TIMEOUT_MS);
}

function loadOlderHistory(instanceId) {
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
      renderSelected();
      if (current) current.historyPreserve = false;
      showToast("Older history timed out. Tap to try again.");
    }
  }, HISTORY_REQUEST_TIMEOUT_MS);
  olderHistoryRequest = { instanceId, requestId, offset, timeout };
  agent.historyLoadingOlder = true;
  agent.historyPreserve = true;
  renderSelected();
  agent.historyPreserve = false;
  socket.send(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "history_request",
    instanceId,
    requestId,
    offset,
    limit: HISTORY_PAGE_SIZE,
    generation: agent.generation,
    snapshotSequence: agent.snapshotSequence,
  }));
}

function clearHistoryRequests() {
  if (activeHistoryRequest) clearTimeout(activeHistoryRequest.timeout);
  if (olderHistoryRequest) {
    clearTimeout(olderHistoryRequest.timeout);
    const agent = agents.get(olderHistoryRequest.instanceId);
    if (agent) agent.historyLoadingOlder = false;
  }
  activeHistoryRequest = undefined;
  olderHistoryRequest = undefined;
}

function mergeCachedHistory(agent, cached) {
  if (!cached?.historyLoaded || cached.meta?.sessionId !== agent.meta?.sessionId) return agent;
  return {
    ...agent,
    snapshot: cached.snapshot,
    historyLoaded: true,
    historyHasOlder: cached.historyHasOlder,
    historyLoadedCount: cached.historyLoadedCount,
    historyLoadingOlder: false,
  };
}

function clearHistoryCache() {
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
  renderSelected();
  if (selectedId) requestHistory(selectedId, true);
  showToast("Cached history cleared.");
}

function rememberHistory(instanceId) {
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

function setNavigation(open) {
  const hasSelectedAgent = Boolean(selectedId && agents.has(selectedId));
  const visible = open || !hasSelectedAgent;
  const settingsOpen = Boolean(elements.settings && !elements.settings.hidden);
  elements.navigation.classList.toggle("closed", !visible);
  elements.navigation.setAttribute("aria-hidden", String(!visible));
  elements.navigation.inert = settingsOpen || !visible;
  elements.view.inert = settingsOpen || visible;
  elements.view.setAttribute("aria-hidden", String(visible || !hasSelectedAgent));
  elements.closeNavigation.hidden = !hasSelectedAgent;
}

function renderSelected() {
  const agent = selectedId ? agents.get(selectedId) : undefined;
  elements.view.hidden = !agent;
  if (!agent) {
    syncWorkingIndicator();
    return;
  }

  elements.name.textContent = sessionName(agent);
  const model = agent.meta.model?.split("/").at(-1) || "unknown model";
  elements.meta.textContent = `${basename(agent.meta.cwd) || agent.meta.cwd} · ${model}`;
  elements.meta.title = `${agent.meta.cwd} · PID ${agent.meta.pid} · ${agent.meta.model || "unknown model"}`;
  const svelteBridge = globalThis.__PI_EVERYWHERE_SVELTE__;
  if (svelteBridge) {
    svelteBridge.renderConversation({
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
    });
    syncWorkingIndicator();
    return;
  }
  elements.transcript.replaceChildren();
  transcriptState = createTranscriptState();
  if (!agent.historyLoaded) {
    appendActivityText(agent.historyLoadError || "Loading history…", { status: true, error: Boolean(agent.historyLoadError) });
    syncWorkingIndicator();
    return;
  }
  rebuildingTranscript = true;
  try {
    if (agent.snapshot?.historyTruncated) {
      appendActivityText(`${agent.snapshot.omittedEntries ?? "Some"} older history entries were omitted.`, { status: true });
    }
    for (const entry of agent.snapshot?.entries ?? []) renderEntry(entry);
  } finally {
    rebuildingTranscript = false;
  }
  syncWorkingIndicator();
  scrollToBottom();
}

function renderEntry(entry) {
  if (entry?.type === "message" && entry.message) renderMessage(entry.message);
  else if (entry?.type === "compaction") appendActivityText(`Conversation compacted (${entry.tokensBefore ?? "?"} tokens).`, { status: true });
  else if (entry?.type === "branch_summary") appendActivityText(`Branch summary: ${entry.summary ?? ""}`, { markdown: true });
}

function renderMessage(message) {
  if (message.role === "user") appendUserMessage(message);
  else if (message.role === "assistant") appendAssistantMessage(message);
  else if (message.role === "toolResult") applyToolResult(message);
  else if (message.role === "bashExecution") {
    upsertTool({ name: "bash", args: { command: message.command }, status: "done" });
  } else if (message.role === "custom" && message.display !== false) {
    appendActivityText(contentText(message.content), { markdown: true, status: true });
  }
}

function appendUserMessage(message) {
  clearAssistantStream();
  const bubble = document.createElement("article");
  bubble.className = "user-message";
  const label = div("You", "user-label");
  const content = div("", "message-content markdown");
  content.append(renderMarkdown(contentText(message.content)));
  bubble.append(label, content);
  elements.transcript.append(bubble);
  transcriptState.activitySinceUser = false;
  scrollToBottom();
}

function appendAssistantMessage(message) {
  const blocks = normalizeAssistantContent(message.content);
  const intermediate = message.stopReason === "toolUse" || blocks.some((block) => block.type === "toolCall");
  const finalText = [];

  for (const block of blocks) {
    if (block.type === "thinking" && block.thinking) {
      appendActivityText(block.thinking, { markdown: true, thinking: true });
    } else if (block.type === "toolCall") {
      upsertTool({ id: block.id, name: block.name, args: block.arguments, status: "pending" });
    } else if (block.type === "text" && block.text) {
      if (intermediate) appendActivityText(block.text, { markdown: true });
      else finalText.push(block.text);
    }
  }

  if (finalText.length > 0) appendAnswer(finalText.join("\n"));
  else if (["error", "aborted"].includes(message.stopReason)) {
    appendActivityText(message.stopReason === "aborted" ? "Response stopped." : "The model returned an error.", { status: true, error: true });
  }
}

function normalizeAssistantContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function appendActivityText(text, options = {}) {
  if (!text) return undefined;
  const node = document.createElement("div");
  node.className = `activity-copy message-content${options.thinking ? " thinking" : ""}${options.status ? " status-copy" : ""}${options.error ? " error" : ""}`;
  if (options.markdown) {
    node.classList.add("markdown");
    node.append(renderMarkdown(text));
  } else {
    node.classList.add("plain-text");
    node.textContent = text;
  }
  elements.transcript.append(node);
  transcriptState.activitySinceUser = true;
  scrollToBottom();
  return node;
}

function appendAnswer(text) {
  if (!text) return;
  if (transcriptState.activitySinceUser) appendSeparator();
  const answer = document.createElement("article");
  answer.className = "assistant-answer";
  const content = div("", "message-content markdown");
  content.append(renderMarkdown(text));
  answer.append(content);
  elements.transcript.append(answer);
  transcriptState.activitySinceUser = false;
  scrollToBottom();
}

function appendSeparator(streaming = false) {
  const separator = document.createElement("div");
  separator.className = "answer-separator";
  separator.setAttribute("role", "separator");
  if (streaming) separator.dataset.streaming = "true";
  elements.transcript.append(separator);
  return separator;
}

function upsertTool({ id, name, args, status }) {
  let row = id ? transcriptState.tools.get(id) : undefined;
  if (!row) {
    row = document.createElement("div");
    row.className = "activity-row";
    const icon = div(toolIcon(name), "activity-icon");
    const label = div(toolLabel(name), "activity-tool");
    const detail = div("", "activity-detail");
    const state = div("", "activity-state");
    row.append(icon, label, detail, state);
    elements.transcript.append(row);
    if (id) transcriptState.tools.set(id, row);
  }

  const detail = row.querySelector(".activity-detail");
  const summary = summarizeToolArgs(name, args);
  if (summary) detail.textContent = summary;
  row.classList.remove("pending", "running", "done", "error");
  row.classList.add(status || "pending");
  row.querySelector(".activity-state").textContent = status === "running" ? "●" : status === "error" ? "!" : status === "done" ? "✓" : "";
  transcriptState.activitySinceUser = true;
  scrollToBottom();
  return row;
}

function applyToolResult(message) {
  const row = message.toolCallId ? transcriptState.tools.get(message.toolCallId) : undefined;
  if (row) {
    row.classList.remove("pending", "running", "done", "error");
    row.classList.add(message.isError ? "error" : "done");
    row.querySelector(".activity-state").textContent = message.isError ? "!" : "✓";
    if (message.isError) {
      const detail = row.querySelector(".activity-detail");
      detail.textContent = truncateLine(contentText(message.content), 220) || detail.textContent;
    }
  } else if (message.isError) {
    const created = upsertTool({ id: message.toolCallId, name: message.toolName || "tool", status: "error" });
    created.querySelector(".activity-detail").textContent = truncateLine(contentText(message.content), 220);
  }
}

function applyEvent(event) {
  if (!event?.type) return;
  const svelteBridge = globalThis.__PI_EVERYWHERE_SVELTE__;
  if (svelteBridge) {
    svelteBridge.applyConversationEvent(event);
    return;
  }
  if (event.type === "message_start") {
    if (event.message?.role === "user") appendUserMessage(event.message);
    else if (event.message?.role === "assistant") startAssistantStream();
    return;
  }
  if (event.type === "message_update") {
    applyAssistantDelta(event.assistantMessageEvent);
    return;
  }
  if (event.type === "message_end") {
    if (event.message?.role === "assistant") {
      clearAssistantStream();
      appendAssistantMessage(event.message);
    } else if (event.message?.role === "toolResult") {
      applyToolResult(event.message);
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    upsertTool({ id: event.toolCallId, name: event.toolName, args: event.args, status: "running" });
    return;
  }
  if (event.type === "tool_execution_end") {
    const row = upsertTool({ id: event.toolCallId, name: event.toolName, args: event.args, status: event.isError ? "error" : "done" });
    if (event.isError && event.result) {
      row.querySelector(".activity-detail").textContent = truncateLine(contentText(event.result?.content ?? event.result), 220);
    }
  }
}

function startAssistantStream() {
  clearAssistantStream();
  transcriptState.stream = {
    activityBefore: transcriptState.activitySinceUser,
    nodes: [],
    blocks: new Map(),
    hasSeparator: false,
  };
}

function applyAssistantDelta(delta) {
  if (!delta?.type) return;
  if (!transcriptState.stream) startAssistantStream();
  const stream = transcriptState.stream;
  const index = Number.isInteger(delta.contentIndex) ? delta.contentIndex : 0;

  if (["thinking_start", "thinking_delta", "thinking_end"].includes(delta.type)) {
    const node = ensureStreamBlock("thinking", index);
    if (delta.type === "thinking_delta") node.textContent += delta.delta ?? "";
    if (delta.type === "thinking_end" && typeof delta.content === "string") node.textContent = delta.content;
    transcriptState.activitySinceUser = true;
    scrollToBottom();
    return;
  }

  if (["text_start", "text_delta", "text_end"].includes(delta.type)) {
    if (transcriptState.activitySinceUser && !stream.hasSeparator) {
      const separator = appendSeparator(true);
      stream.nodes.push(separator);
      stream.hasSeparator = true;
    }
    const node = ensureStreamBlock("text", index);
    if (delta.type === "text_delta") node.textContent += delta.delta ?? "";
    if (delta.type === "text_end" && typeof delta.content === "string") node.textContent = delta.content;
    scrollToBottom();
  }
}

function ensureStreamBlock(kind, index) {
  const stream = transcriptState.stream;
  const key = `${kind}:${index}`;
  let content = stream.blocks.get(key);
  if (content) return content;

  const wrapper = document.createElement(kind === "thinking" ? "div" : "article");
  wrapper.className = kind === "thinking" ? "activity-copy thinking streaming" : "assistant-answer streaming";
  content = div("", "message-content plain-text");
  wrapper.append(content);
  elements.transcript.append(wrapper);
  stream.blocks.set(key, content);
  stream.nodes.push(wrapper);
  return content;
}

function clearAssistantStream() {
  const stream = transcriptState.stream;
  if (!stream) return;
  for (const node of stream.nodes) node.remove();
  transcriptState.activitySinceUser = stream.activityBefore;
  transcriptState.stream = undefined;
}

function createTranscriptState() {
  return {
    activitySinceUser: false,
    stream: undefined,
    tools: new Map(),
  };
}

function showSystem(text) {
  if (!selectedId) return;
  const svelteBridge = globalThis.__PI_EVERYWHERE_SVELTE__;
  if (svelteBridge) svelteBridge.appendSystemMessage(text);
  else appendActivityText(text, { status: true, error: true });
}

function sendPrompt(payload) {
  const agent = selectedId ? agents.get(selectedId) : undefined;
  if (payload.images?.length && agent?.meta?.supportsImages !== true) {
    showToast("The selected model does not support images.");
    return undefined;
  }
  return sendCommand("prompt", payload);
}

function sendCommand(command, payload) {
  if (!selectedId || socket?.readyState !== WebSocket.OPEN) {
    showSystem("Not connected. Your message was not sent.");
    return undefined;
  }
  const commandId = crypto.randomUUID();
  socket.send(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "command",
    instanceId: selectedId,
    commandId,
    command,
    ...(payload ? { payload } : {}),
  }));
  return commandId;
}

if (!globalThis.__PI_EVERYWHERE_SVELTE__) {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.prompt.value.trim();
    if (!text) return;
    if (sendPrompt({ text, behavior: "followUp" })) {
      elements.prompt.value = "";
      resizePrompt();
    }
  });

  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.prompt.addEventListener("input", resizePrompt);
}
function setSettings(open) {
  if (!elements.settings) return;
  if (open) {
    settingsNavigationWasOpen = !elements.navigation.classList.contains("closed");
    elements.settings.hidden = false;
    elements.navigation.inert = true;
    elements.view.inert = true;
    elements.closeSettings?.focus();
    return;
  }
  elements.settings.hidden = true;
  setNavigation(settingsNavigationWasOpen);
  elements.openSettings?.focus();
}

elements.openNavigation.addEventListener("click", () => setNavigation(true));
elements.closeNavigation.addEventListener("click", () => setNavigation(false));
elements.openSettings?.addEventListener("click", () => setSettings(true));
elements.closeSettings?.addEventListener("click", () => setSettings(false));
elements.reconnect?.addEventListener("click", () => {
  restartConnection();
  showToast("Reconnecting…");
});
elements.clearHistoryCache?.addEventListener("click", clearHistoryCache);
elements.abort.addEventListener("click", () => sendCommand("abort"));
elements.changeToken.addEventListener("click", () => {
  setSettings(false);
  reconnectEnabled = false;
  connectionEpoch += 1;
  clearHistoryRequests();
  socket?.close();
  socket = undefined;
  clearStoredCredentials();
  elements.token.value = "";
  elements.tokenDialog.showModal();
});

elements.tokenForm.addEventListener("submit", () => {
  const token = elements.token.value.trim();
  if (!token) return;
  sessionStorage.setItem(LEGACY_TOKEN_KEY, token);
  reconnectEnabled = true;
  setTimeout(() => void connect(), 0);
});
elements.notifications.addEventListener("click", () => void toggleNotifications());

function syncWorkingIndicator() {
  const agent = selectedId ? agents.get(selectedId) : undefined;
  const working = Boolean(agent && !agent.meta.idle);
  globalThis.__PI_EVERYWHERE_SVELTE__?.renderComposer({
    selectedId: agent?.instanceId,
    connected: socket?.readyState === WebSocket.OPEN && elements.connection.textContent === "online",
    supportsImages: agent?.meta?.supportsImages === true,
    working,
  });
  const wasHidden = elements.workingIndicator.hidden;
  const wasNearBottom = elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 80;
  elements.workingIndicator.hidden = !working;

  if (!working) {
    clearInterval(workingSpinnerTimer);
    clearInterval(workingPhraseTimer);
    workingSpinnerTimer = undefined;
    workingPhraseTimer = undefined;
    return;
  }
  if (!wasHidden || workingSpinnerTimer || workingPhraseTimer) return;

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  elements.workingSpinner.textContent = reduceMotion ? "●" : SPINNER_FRAMES[0];
  elements.workingPhrase.textContent = WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)];
  if (!reduceMotion) {
    let spinnerIndex = 0;
    let phraseIndex = Math.floor(Math.random() * WORKING_PHRASES.length);
    workingSpinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      elements.workingSpinner.textContent = SPINNER_FRAMES[spinnerIndex];
    }, 90);
    workingPhraseTimer = setInterval(() => {
      phraseIndex = (phraseIndex + 1) % WORKING_PHRASES.length;
      elements.workingPhrase.textContent = WORKING_PHRASES[phraseIndex];
    }, 4_800);
  }
  if (wasNearBottom) scrollToBottom();
}

async function toggleNotifications() {
  if (!notificationsSupported()) return;
  elements.notifications.disabled = true;
  let createdSubscription;
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
      const { publicKey } = await keyResponse.json();
      createdSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
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
      catch {}
    }
    showToast(error instanceof Error ? error.message : "Could not update notifications.");
  } finally {
    elements.notifications.disabled = false;
    await refreshNotificationState(false);
  }
}

async function refreshNotificationState(syncWithServer) {
  if (!notificationsSupported()) {
    elements.notifications.hidden = true;
    return;
  }
  let localSubscription;
  try {
    const registration = await navigator.serviceWorker.ready;
    localSubscription = await registration.pushManager.getSubscription();
    let confirmed = Boolean(localSubscription && Notification.permission === "granted");
    if (confirmed && syncWithServer) {
      const response = await authenticatedFetch("/api/push/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localSubscription.toJSON()),
      });
      confirmed = response.ok;
    }
    elements.notifications.classList.toggle("active", confirmed);
    elements.notifications.classList.toggle("warning", Boolean(localSubscription) && !confirmed);
    const label = confirmed ? "Disable notifications" : localSubscription ? "Notifications need attention" : "Enable notifications";
    elements.notifications.setAttribute("aria-label", label);
    elements.notifications.title = label;
  } catch {
    elements.notifications.classList.remove("active");
    elements.notifications.classList.toggle("warning", Boolean(localSubscription));
  }
}

function notificationsSupported() {
  return isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function currentCredential() {
  try {
    return localStorage.getItem(DEVICE_CREDENTIAL_KEY) ?? sessionStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return sessionStorage.getItem(LEGACY_TOKEN_KEY);
  }
}

function clearStoredCredentials() {
  try { localStorage.removeItem(DEVICE_CREDENTIAL_KEY); }
  catch { /* Storage can be unavailable in restricted browser modes. */ }
  sessionStorage.removeItem(LEGACY_TOKEN_KEY);
}

async function exchangePairingCode() {
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
    const result = await response.json();
    if (!response.ok || typeof result?.device?.credential !== "string") {
      throw new Error(result?.error || "Pairing failed");
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

function mobileDeviceName() {
  const browser = /SamsungBrowser/u.test(navigator.userAgent) ? "Samsung Internet" : /CriOS|Chrome/u.test(navigator.userAgent) ? "Chrome" : "Browser";
  const platform = /Android/u.test(navigator.userAgent) ? "Android" : /iPhone|iPad/u.test(navigator.userAgent) ? "iOS" : navigator.platform || "device";
  return `${browser} PWA on ${platform}`;
}

function authenticatedFetch(path, options = {}) {
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

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function showToast(text) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3_500);
}

function setConnection(status) {
  elements.connection.textContent = status;
  elements.connectionDot.className = `connection-dot ${status === "online" ? "online" : "offline"}`;
  if (elements.settingsConnection) elements.settingsConnection.textContent = status[0].toUpperCase() + status.slice(1);
  if (elements.settingsConnectionDot) {
    elements.settingsConnectionDot.className = `connection-dot ${status === "online" ? "online" : "offline"}`;
  }
  syncWorkingIndicator();
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block?.type === "text") return block.text || "";
    if (block?.type === "thinking") return block.thinking || "";
    if (block?.type === "image") return `[image: ${block.mimeType || "unknown"}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function summarizeToolArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  const lowered = String(name || "").toLowerCase();
  let value;
  if (lowered === "bash" || lowered.includes("shell")) value = args.command;
  else if (["read", "write", "edit"].includes(lowered)) value = args.path ?? args.filePath ?? args.file_path;
  else if (lowered.includes("search")) value = args.query ?? args.queries ?? args.pattern;
  else value = args.path ?? args.command ?? args.query ?? args.url;
  if (Array.isArray(value)) value = value.join(" · ");
  if (value === undefined) {
    try { value = JSON.stringify(args); }
    catch { value = ""; }
  }
  return truncateLine(String(value || ""), 240);
}

function toolLabel(name) {
  const labels = { bash: "Shell", read: "Read", write: "Write", edit: "Edit" };
  const value = String(name || "tool");
  return labels[value.toLowerCase()] || value.replace(/(^|[_-])\w/g, (match) => match.replace(/[_-]/, "").toUpperCase());
}

function toolIcon(name) {
  const value = String(name || "").toLowerCase();
  if (value === "bash" || value.includes("shell")) return ">_";
  if (value === "read") return "□";
  if (["write", "edit"].includes(value)) return "✎";
  if (value.includes("search")) return "⌕";
  return "◇";
}

function truncateLine(value, maximum) {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

function sessionName(agent) {
  return agent.meta.sessionName || basename(agent.meta.cwd) || `Pi ${agent.meta.pid}`;
}

function basename(path) {
  return path?.split("/").filter(Boolean).at(-1) || path;
}

function div(text, className) {
  return element("div", text, className);
}

function element(tagName, text, className = "") {
  const node = document.createElement(tagName);
  node.className = className;
  node.textContent = text;
  return node;
}

function scrollToBottom() {
  if (rebuildingTranscript) return;
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  requestAnimationFrame(() => { elements.transcript.scrollTop = elements.transcript.scrollHeight; });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    backgroundedAt = Date.now();
    return;
  }
  const slept = backgroundedAt ? Date.now() - backgroundedAt : 0;
  backgroundedAt = undefined;
  if (slept >= BACKGROUND_RECONNECT_MS || socket?.readyState !== WebSocket.OPEN) restartConnection();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restartConnection();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
setNavigation(true);
void exchangePairingCode().then(() => connect());
