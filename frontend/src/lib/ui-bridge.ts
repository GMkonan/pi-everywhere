import { writable } from "svelte/store";
import { appendSystemMessage as appendSystemToTranscript, applyTranscriptEvent, buildTranscript, emptyTranscriptState } from "./transcript";
import type { BrowserPromptImage, ComposerState, LegacyUiActions, SessionListState, SvelteUiBridge } from "./types";

const initialState: SessionListState = { agents: [], syncing: false };

export const sessionListState = writable<SessionListState>(initialState);
export const transcriptState = writable(emptyTranscriptState());
export const composerState = writable<ComposerState>({ connected: false, supportsImages: false, working: false });
export const promptResult = writable<{ commandId: string; ok: boolean; error?: string } | undefined>();

let currentTranscript = emptyTranscriptState();
let actions: LegacyUiActions | undefined;

export function installUiBridge(): void {
  window.__PI_EVERYWHERE_SVELTE__ = {
    bindActions(nextActions) {
      actions = nextActions;
    },
    renderSessionList(state) {
      sessionListState.set(state);
    },
    renderConversation(input) {
      currentTranscript = buildTranscript(input);
      transcriptState.set(currentTranscript);
    },
    applyConversationEvent(event) {
      currentTranscript = applyTranscriptEvent(currentTranscript, event);
      transcriptState.set(currentTranscript);
    },
    appendSystemMessage(text) {
      currentTranscript = appendSystemToTranscript(currentTranscript, text);
      transcriptState.set(currentTranscript);
    },
    renderComposer(state) {
      composerState.set(state);
    },
    resolvePrompt(commandId, ok, error) {
      promptResult.set({ commandId, ok, ...(error ? { error } : {}) });
    },
  };
}

export function selectSession(instanceId: string): void {
  actions?.selectAgent(instanceId);
}

export function loadOlderHistory(instanceId: string): void {
  actions?.loadOlderHistory(instanceId);
}

export function sendPrompt(payload: {
  text?: string;
  images?: BrowserPromptImage[];
  behavior: "followUp" | "steer";
}): string | undefined {
  return actions?.sendPrompt(payload);
}

declare global {
  interface Window {
    __PI_EVERYWHERE_SVELTE__?: SvelteUiBridge;
  }
}
