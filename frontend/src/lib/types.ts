export interface AgentMeta {
  cwd: string;
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
  meta: AgentMeta;
  snapshot?: AgentSnapshot;
}

export interface SessionListState {
  agents: LiveAgent[];
  selectedId?: string;
  syncing: boolean;
}

export interface LegacyUiActions {
  selectAgent(instanceId: string): void;
}

export interface ConversationInput {
  instanceId: string;
  entries: unknown[];
  historyTruncated: boolean;
  omittedEntries?: number;
}

export interface SvelteUiBridge {
  bindActions(actions: LegacyUiActions): void;
  renderSessionList(state: SessionListState): void;
  renderConversation(input: ConversationInput): void;
  applyConversationEvent(event: unknown): void;
  appendSystemMessage(text: string): void;
}
