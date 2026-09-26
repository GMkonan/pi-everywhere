import { writable } from "svelte/store";
import type { LegacyUiActions, SessionListState, SvelteUiBridge } from "./types";

const initialState: SessionListState = { agents: [], syncing: false };

export const sessionListState = writable<SessionListState>(initialState);

let actions: LegacyUiActions | undefined;

export function installUiBridge(): void {
  window.__PI_EVERYWHERE_SVELTE__ = {
    bindActions(nextActions) {
      actions = nextActions;
    },
    renderSessionList(state) {
      sessionListState.set(state);
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
