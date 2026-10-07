export interface AgentMeta {
  instanceId?: string;
  cwd: string;
  sessionId?: string;
  idle: boolean;
  pid: number;
  sessionName?: string;
  model?: string;
  supportsImages?: boolean;
  thinkingLevel?: string;
}

export interface AgentSnapshot {
  entries?: unknown[];
  historyTruncated?: boolean;
  omittedEntries?: number;
}

export interface LiveAgent {
  instanceId: string;
  connectedAt: number;
  lastSeenAt?: number;
  lastActivityAt?: number;
  generation?: number;
  snapshotSequence?: number;
  meta: AgentMeta;
  snapshot?: AgentSnapshot;
  historyLoaded?: boolean;
  historyLoading?: boolean;
  historyLoadError?: string;
  historyHasOlder?: boolean;
  historyLoadedCount?: number;
  historyLoadingOlder?: boolean;
  historyPrepend?: boolean;
  historyPreserve?: boolean;
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

export type ConnectionStatus = "offline" | "connecting" | "pairing" | "online";

export interface NotificationState {
  supported: boolean;
  active: boolean;
  warning: boolean;
  busy: boolean;
  label: string;
}

export interface AppUiState {
  connection: ConnectionStatus;
  navigationOpen: boolean;
  settingsOpen: boolean;
  hasConversation: boolean;
  conversationName: string;
  conversationMeta: string;
  conversationTitle: string;
  tokenDialogOpen: boolean;
  toast?: string;
  notifications: NotificationState;
}

export interface ConversationInput {
  instanceId: string;
  entries: unknown[];
  historyTruncated: boolean;
  omittedEntries?: number;
  loading?: boolean;
  loadError?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  canLoadOlder?: boolean;
  scrollMode?: "bottom" | "prepend" | "preserve";
}
