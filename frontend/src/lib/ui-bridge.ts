import { writable } from "svelte/store";
import { appendSystemMessage as appendSystemToTranscript, applyTranscriptEvent, buildTranscript, emptyTranscriptState } from "./transcript";
import type { LegacyUiActions, SessionListState, SvelteUiBridge } from "./types";

const initialState: SessionListState = { agents: [], syncing: false };

export const sessionListState = writable<SessionListState>(initialState);
export const transcriptState = writable(emptyTranscriptState());

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
  };
}

export function selectSession(instanceId: string): void {
  actions?.selectAgent(instanceId);
}

declare global {
  interface Window {
    __PI_EVERYWHERE_SVELTE__?: SvelteUiBridge;
  }
}
