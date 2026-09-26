export interface AgentMeta {
  cwd: string;
  sessionId?: string;
  idle: boolean;
  pid: number;
  sessionName?: string;
  model?: string;
}

export interface AgentSnapshot {
  entries?: unknown[];
  historyTruncated?: boolean;
  omittedEntries?: number;
}

export interface LiveAgent {
  instanceId: string;
  connectedAt: number;
  lastActivityAt?: number;
  generation?: number;
  snapshotSequence?: number;
  meta: AgentMeta;
  snapshot?: AgentSnapshot;
  historyLoaded?: boolean;
}

export interface SessionListState {
  agents: LiveAgent[];
  selectedId?: string;
  syncing: boolean;
}

export interface BrowserPromptImage {
  mimeType: "image/jpeg";
  data: string;
}

export interface ComposerState {
  selectedId?: string;
  connected: boolean;
  supportsImages: boolean;
  working: boolean;
}

export interface LegacyUiActions {
  selectAgent(instanceId: string): void;
  loadOlderHistory(instanceId: string): void;
  sendPrompt(payload: { text?: string; images?: BrowserPromptImage[]; behavior: "followUp" | "steer" }): string | undefined;
}

export interface ConversationInput {
  instanceId: string;
  entries: unknown[];
  historyTruncated: boolean;
  omittedEntries?: number;
  loading?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  canLoadOlder?: boolean;
  scrollMode?: "bottom" | "prepend" | "preserve";
}

export interface SvelteUiBridge {
  bindActions(actions: LegacyUiActions): void;
  renderSessionList(state: SessionListState): void;
  renderConversation(input: ConversationInput): void;
  applyConversationEvent(event: unknown): void;
  appendSystemMessage(text: string): void;
  renderComposer(state: ComposerState): void;
  resolvePrompt(commandId: string, ok: boolean, error?: string): void;
}
