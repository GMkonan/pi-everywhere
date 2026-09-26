import type { ConversationInput } from "./types";

export type ToolStatus = "pending" | "running" | "done" | "error";

export type TranscriptItem =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "activity"; text: string; markdown: boolean; thinking: boolean; status: boolean; error: boolean; streaming: boolean }
  | { id: string; type: "answer"; text: string; streaming: boolean }
  | { id: string; type: "tool"; toolCallId?: string; name: string; label: string; icon: string; detail: string; status: ToolStatus }
  | { id: string; type: "separator"; streaming: boolean };

interface StreamState {
  activityBefore: boolean;
  itemIds: string[];
  blockIds: Record<string, string>;
  hasSeparator: boolean;
}

export interface TranscriptState {
  instanceId?: string;
  items: TranscriptItem[];
  activitySinceUser: boolean;
  tools: Record<string, string>;
  stream?: StreamState;
  nextId: number;
  revision: number;
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  canLoadOlder: boolean;
  scrollMode: "bottom" | "prepend" | "preserve";
}

export function emptyTranscriptState(): TranscriptState {
  return {
    items: [], activitySinceUser: false, tools: {}, nextId: 1, revision: 0,
    loading: false, hasOlder: false, loadingOlder: false, canLoadOlder: false, scrollMode: "bottom",
  };
}

export function buildTranscript(input: ConversationInput): TranscriptState {
  const state: TranscriptState = {
    ...emptyTranscriptState(),
    instanceId: input.instanceId,
    loading: input.loading === true,
    hasOlder: input.hasOlder === true,
    loadingOlder: input.loadingOlder === true,
    canLoadOlder: input.canLoadOlder !== false,
    scrollMode: input.scrollMode ?? "bottom",
  };
  if (input.historyTruncated && !input.hasOlder) {
    appendActivity(state, `${input.omittedEntries ?? "Some"} older history entries were omitted.`, { status: true });
  }
  for (const entry of input.entries) renderEntry(state, entry);
  state.revision += 1;
  return state;
}

export function applyTranscriptEvent(previous: TranscriptState, value: unknown): TranscriptState {
  const state = cloneState(previous);
  state.scrollMode = "bottom";
  const event = asRecord(value);
  if (!event || typeof event.type !== "string") return state;

  if (event.type === "message_start") {
    const message = asRecord(event.message);
    if (message?.role === "user") appendUser(state, message);
    else if (message?.role === "assistant") startStream(state);
  } else if (event.type === "message_update") {
    applyDelta(state, event.assistantMessageEvent);
  } else if (event.type === "message_end") {
    const message = asRecord(event.message);
    if (message?.role === "assistant") {
      clearStream(state);
      appendAssistant(state, message);
    } else if (message?.role === "toolResult") {
      applyToolResult(state, message);
    }
  } else if (event.type === "tool_execution_start") {
    upsertTool(state, {
      id: stringValue(event.toolCallId),
      name: stringValue(event.toolName) || "tool",
      args: event.args,
      status: "running",
    });
  } else if (event.type === "tool_execution_end") {
    const isError = event.isError === true;
    upsertTool(state, {
      id: stringValue(event.toolCallId),
      name: stringValue(event.toolName) || "tool",
      args: event.args,
      status: isError ? "error" : "done",
      detail: isError ? truncateLine(contentText(asRecord(event.result)?.content ?? event.result), 220) : undefined,
    });
  }
  state.revision += 1;
  return state;
}

export function appendSystemMessage(previous: TranscriptState, text: string): TranscriptState {
  const state = cloneState(previous);
  state.scrollMode = "bottom";
  appendActivity(state, text, { status: true, error: true });
  state.revision += 1;
  return state;
}

function renderEntry(state: TranscriptState, value: unknown): void {
  const entry = asRecord(value);
  if (!entry) return;
  if (entry.type === "message") renderMessage(state, entry.message);
  else if (entry.type === "compaction") appendActivity(state, `Conversation compacted (${entry.tokensBefore ?? "?"} tokens).`, { status: true });
  else if (entry.type === "branch_summary") appendActivity(state, `Branch summary: ${stringValue(entry.summary)}`, { markdown: true });
}

function renderMessage(state: TranscriptState, value: unknown): void {
  const message = asRecord(value);
  if (!message) return;
  if (message.role === "user") appendUser(state, message);
  else if (message.role === "assistant") appendAssistant(state, message);
  else if (message.role === "toolResult") applyToolResult(state, message);
  else if (message.role === "bashExecution") {
    upsertTool(state, { name: "bash", args: { command: message.command }, status: "done" });
  } else if (message.role === "custom" && message.display !== false) {
    appendActivity(state, contentText(message.content), { markdown: true, status: true });
  }
}

function appendUser(state: TranscriptState, message: Record<string, unknown>): void {
  clearStream(state);
  state.items.push({ id: nextId(state), type: "user", text: contentText(message.content) });
  state.activitySinceUser = false;
}

function appendAssistant(state: TranscriptState, message: Record<string, unknown>): void {
  const blocks = normalizeContent(message.content);
  const intermediate = message.stopReason === "toolUse" || blocks.some((block) => block.type === "toolCall");
  const finalText: string[] = [];

  for (const block of blocks) {
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      appendActivity(state, block.thinking, { markdown: true, thinking: true });
    } else if (block.type === "toolCall") {
      upsertTool(state, {
        id: stringValue(block.id),
        name: stringValue(block.name) || "tool",
        args: block.arguments,
        status: "pending",
      });
    } else if (block.type === "text" && typeof block.text === "string" && block.text) {
      if (intermediate) appendActivity(state, block.text, { markdown: true });
      else finalText.push(block.text);
    }
  }

  if (finalText.length > 0) appendAnswer(state, finalText.join("\n"));
  else if (message.stopReason === "error" || message.stopReason === "aborted") {
    appendActivity(state, message.stopReason === "aborted" ? "Response stopped." : "The model returned an error.", { status: true, error: true });
  }
}

function appendActivity(
  state: TranscriptState,
  text: string,
  options: { markdown?: boolean; thinking?: boolean; status?: boolean; error?: boolean; streaming?: boolean } = {},
): string | undefined {
  if (!text) return undefined;
  const id = nextId(state);
  state.items.push({
    id,
    type: "activity",
    text,
    markdown: options.markdown === true,
    thinking: options.thinking === true,
    status: options.status === true,
    error: options.error === true,
    streaming: options.streaming === true,
  });
  state.activitySinceUser = true;
  return id;
}

function appendAnswer(state: TranscriptState, text: string): void {
  if (!text) return;
  if (state.activitySinceUser) appendSeparator(state, false);
  state.items.push({ id: nextId(state), type: "answer", text, streaming: false });
  state.activitySinceUser = false;
}

function appendSeparator(state: TranscriptState, streaming: boolean): string {
  const id = nextId(state);
  state.items.push({ id, type: "separator", streaming });
  return id;
}

function upsertTool(
  state: TranscriptState,
  input: { id?: string; name: string; args?: unknown; status: ToolStatus; detail?: string },
): string {
  const existingItemId = input.id ? state.tools[input.id] : undefined;
  const existingIndex = existingItemId ? state.items.findIndex((item) => item.id === existingItemId) : -1;
  const existing = existingIndex >= 0 ? state.items[existingIndex] : undefined;
  const summary = input.detail || summarizeToolArgs(input.name, input.args);
  if (existing?.type === "tool") {
    state.items[existingIndex] = {
      ...existing,
      name: input.name || existing.name,
      label: toolLabel(input.name || existing.name),
      icon: toolIcon(input.name || existing.name),
      detail: summary || existing.detail,
      status: input.status,
    };
    state.activitySinceUser = true;
    return existing.id;
  }

  const itemId = nextId(state);
  state.items.push({
    id: itemId,
    type: "tool",
    ...(input.id ? { toolCallId: input.id } : {}),
    name: input.name,
    label: toolLabel(input.name),
    icon: toolIcon(input.name),
    detail: summary,
    status: input.status,
  });
  if (input.id) state.tools[input.id] = itemId;
  state.activitySinceUser = true;
  return itemId;
}

function applyToolResult(state: TranscriptState, message: Record<string, unknown>): void {
  const toolCallId = stringValue(message.toolCallId);
  const existingId = toolCallId ? state.tools[toolCallId] : undefined;
  const existingIndex = existingId ? state.items.findIndex((item) => item.id === existingId) : -1;
  const existing = existingIndex >= 0 ? state.items[existingIndex] : undefined;
  const isError = message.isError === true;
  if (existing?.type === "tool") {
    state.items[existingIndex] = {
      ...existing,
      status: isError ? "error" : "done",
      detail: isError ? truncateLine(contentText(message.content), 220) || existing.detail : existing.detail,
    };
  } else if (isError) {
    upsertTool(state, {
      id: toolCallId,
      name: stringValue(message.toolName) || "tool",
      status: "error",
      detail: truncateLine(contentText(message.content), 220),
    });
  }
}

function startStream(state: TranscriptState): void {
  clearStream(state);
  state.stream = { activityBefore: state.activitySinceUser, itemIds: [], blockIds: {}, hasSeparator: false };
}

function applyDelta(state: TranscriptState, value: unknown): void {
  const delta = asRecord(value);
  if (!delta || typeof delta.type !== "string") return;
  if (!state.stream) startStream(state);
  const stream = state.stream;
  if (!stream) return;
  const index = Number.isInteger(delta.contentIndex) ? Number(delta.contentIndex) : 0;

  if (["thinking_start", "thinking_delta", "thinking_end"].includes(delta.type)) {
    const itemId = ensureStreamBlock(state, "thinking", index);
    updateStreamText(state, itemId, delta.type, delta);
    state.activitySinceUser = true;
  } else if (["text_start", "text_delta", "text_end"].includes(delta.type)) {
    if (state.activitySinceUser && !stream.hasSeparator) {
      stream.itemIds.push(appendSeparator(state, true));
      stream.hasSeparator = true;
    }
    const itemId = ensureStreamBlock(state, "text", index);
    updateStreamText(state, itemId, delta.type, delta);
  }
}

function ensureStreamBlock(state: TranscriptState, kind: "thinking" | "text", index: number): string {
  const stream = state.stream;
  if (!stream) throw new Error("Stream was not initialized");
  const key = `${kind}:${index}`;
  const existing = stream.blockIds[key];
  if (existing) return existing;
  const id = nextId(state);
  const item: TranscriptItem = kind === "thinking"
    ? { id, type: "activity", text: "", markdown: false, thinking: true, status: false, error: false, streaming: true }
    : { id, type: "answer", text: "", streaming: true };
  state.items.push(item);
  stream.blockIds[key] = id;
  stream.itemIds.push(id);
  return id;
}

function updateStreamText(state: TranscriptState, itemId: string, eventType: string, delta: Record<string, unknown>): void {
  const index = state.items.findIndex((item) => item.id === itemId);
  const item = state.items[index];
  if (!item || (item.type !== "activity" && item.type !== "answer")) return;
  const append = eventType.endsWith("_delta") ? stringValue(delta.delta) : undefined;
  const replace = eventType.endsWith("_end") && typeof delta.content === "string" ? delta.content : undefined;
  state.items[index] = { ...item, text: replace ?? `${item.text}${append ?? ""}` };
}

function clearStream(state: TranscriptState): void {
  const stream = state.stream;
  if (!stream) return;
  const temporary = new Set(stream.itemIds);
  state.items = state.items.filter((item) => !temporary.has(item.id));
  state.activitySinceUser = stream.activityBefore;
  state.stream = undefined;
}

function cloneState(previous: TranscriptState): TranscriptState {
  return {
    ...previous,
    items: [...previous.items],
    tools: { ...previous.tools },
    ...(previous.stream
      ? { stream: { ...previous.stream, itemIds: [...previous.stream.itemIds], blockIds: { ...previous.stream.blockIds } } }
      : { stream: undefined }),
  };
}

function nextId(state: TranscriptState): string {
  const id = `transcript-${state.nextId}`;
  state.nextId += 1;
  return id;
}

function normalizeContent(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.map(asRecord).filter((block): block is Record<string, unknown> => Boolean(block)) : [];
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((blockValue) => {
    const block = asRecord(blockValue);
    if (block?.type === "text") return stringValue(block.text);
    if (block?.type === "thinking") return stringValue(block.thinking);
    if (block?.type === "image") return `[image: ${stringValue(block.mimeType) || "unknown"}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function summarizeToolArgs(name: string, value: unknown): string {
  const args = asRecord(value);
  if (!args) return "";
  const lowered = name.toLowerCase();
  let summary: unknown;
  if (lowered === "bash" || lowered.includes("shell")) summary = args.command;
  else if (["read", "write", "edit"].includes(lowered)) summary = args.path ?? args.filePath ?? args.file_path;
  else if (lowered.includes("search")) summary = args.query ?? args.queries ?? args.pattern;
  else summary = args.path ?? args.command ?? args.query ?? args.url;
  if (Array.isArray(summary)) summary = summary.join(" · ");
  if (summary === undefined) {
    try { summary = JSON.stringify(args); }
    catch { summary = ""; }
  }
  return truncateLine(String(summary ?? ""), 240);
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = { bash: "Shell", read: "Read", write: "Write", edit: "Edit" };
  return labels[name.toLowerCase()] || name.replace(/(^|[_-])\w/gu, (match) => match.replace(/[_-]/gu, "").toUpperCase());
}

function toolIcon(name: string): string {
  const lowered = name.toLowerCase();
  if (lowered === "bash" || lowered.includes("shell")) return ">_";
  if (lowered === "read") return "□";
  if (["write", "edit"].includes(lowered)) return "✎";
  if (lowered.includes("search")) return "⌕";
  return "◇";
}

function truncateLine(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
