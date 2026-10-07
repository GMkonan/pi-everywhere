<script lang="ts">
  import { tick } from "svelte";
  import Composer from "./components/Composer.svelte";
  import ConversationTranscript from "./components/ConversationTranscript.svelte";
  import Icon from "./components/Icon.svelte";
  import SessionList from "./components/SessionList.svelte";
  import Settings from "./components/Settings.svelte";
  import {
    abortSelected,
    appState,
    closeNavigation,
    composerState,
    dismissTokenDialog,
    openNavigation,
    openSettings,
    sessionListState,
    submitMasterToken,
  } from "./lib/controller";

  const workingPhrases = [
    "Forging code…",
    "Connecting the dots…",
    "Shaping the answer…",
    "Following the thread…",
    "Working through it…",
    "Almost there…",
  ];
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let tokenDialog: HTMLDialogElement;
  let token = $state("");
  let spinner = $state(spinnerFrames[0]);
  let workingPhrase = $state(workingPhrases[0]);
  let settingsWasOpen = false;
  let navigationVisible = $derived($appState.navigationOpen || !$appState.hasConversation);

  $effect(() => {
    if (!tokenDialog) return;
    if ($appState.tokenDialogOpen && !tokenDialog.open) openDialog(tokenDialog);
    else if (!$appState.tokenDialogOpen && tokenDialog.open) closeDialog(tokenDialog);
  });

  $effect(() => {
    const open = $appState.settingsOpen;
    if (open !== settingsWasOpen) {
      settingsWasOpen = open;
      void tick().then(() => {
        const target = document.querySelector<HTMLElement>(open ? "#close-settings" : "#open-settings");
        target?.focus();
      });
    }
  });

  $effect(() => {
    if (!$composerState.working) return;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let spinnerIndex = 0;
    let phraseIndex = Math.floor(Math.random() * workingPhrases.length);
    spinner = reduceMotion ? "●" : spinnerFrames[spinnerIndex];
    workingPhrase = workingPhrases[phraseIndex];
    if (reduceMotion) return;
    const spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      spinner = spinnerFrames[spinnerIndex];
    }, 90);
    const phraseTimer = setInterval(() => {
      phraseIndex = (phraseIndex + 1) % workingPhrases.length;
      workingPhrase = workingPhrases[phraseIndex];
    }, 4_800);
    return () => {
      clearInterval(spinnerTimer);
      clearInterval(phraseTimer);
    };
  });

  function submitToken(event: SubmitEvent): void {
    event.preventDefault();
    submitMasterToken(token);
    token = "";
  }

  function cancelToken(event: Event): void {
    event.preventDefault();
    dismissTokenDialog();
  }

  function openDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
</script>

<main class="app-shell">
  <nav
    id="session-index"
    class="session-index"
    class:closed={!navigationVisible}
    aria-label="Pi sessions"
    aria-hidden={!navigationVisible}
    inert={$appState.settingsOpen || !navigationVisible}
  >
    <header class="index-header">
      <div>
        <h1>Sessions</h1>
        <div class="connection-line">
          <span id="connection-dot" class:online={$appState.connection === "online"} class:offline={$appState.connection !== "online"} class="connection-dot"></span>
          <span id="connection-status">{$appState.connection}</span>
          <span aria-hidden="true">·</span>
          <span id="agent-count">{$sessionListState.agents.length} {$sessionListState.syncing ? "loading…" : "live"}</span>
        </div>
      </div>
      <div class="index-actions">
        <button id="open-settings" class="icon-button" type="button" aria-label="Open settings" title="Settings" onclick={openSettings}><Icon name="settings" /></button>
        <button id="close-navigation" class="icon-button" type="button" aria-label="Close sessions" hidden={!$appState.hasConversation} onclick={closeNavigation}><Icon name="close" /></button>
      </div>
    </header>
    <SessionList />
  </nav>

  <section
    id="session-view"
    class="conversation"
    hidden={!$appState.hasConversation}
    inert={$appState.settingsOpen || navigationVisible}
    aria-hidden={navigationVisible || !$appState.hasConversation}
  >
    <header class="conversation-header">
      <button id="open-navigation" class="icon-button hamburger" type="button" aria-label="Open sessions" aria-controls="session-index" onclick={openNavigation}>
        <Icon name="menu" />
      </button>
      <div class="conversation-title">
        <h1 id="session-name">{$appState.conversationName}</h1>
        <p id="session-meta" title={$appState.conversationTitle}>{$appState.conversationMeta}</p>
      </div>
    </header>

    <ConversationTranscript />

    <footer class="conversation-footer">
      <div id="working-indicator" class="working-indicator" hidden={!$composerState.working}>
        <span id="working-spinner" class="working-spinner" aria-hidden="true">{spinner}</span>
        <span id="working-phrase" aria-hidden="true">{workingPhrase}</span>
        <span class="sr-only">Pi is working</span>
        <button
          id="abort"
          class="working-stop-button"
          type="button"
          aria-label="Stop current response"
          title="Stop current response"
          onclick={abortSelected}
        >
          <Icon name="stop" />
        </button>
      </div>
      <Composer />
    </footer>
  </section>

  <Settings />
</main>

<div id="toast" class="toast" role="status" aria-live="polite" hidden={!$appState.toast}>{$appState.toast ?? ""}</div>

<dialog id="token-dialog" bind:this={tokenDialog} oncancel={cancelToken}>
  <form method="dialog" id="token-form" onsubmit={submitToken}>
    <h2>Connect to pi-everywhere</h2>
    <p>Prefer pairing from the PC with <code>pi-everywhere pair</code>. For legacy access, paste the master token:</p>
    <code>cat ~/.config/pi-everywhere/token</code>
    <input id="token" bind:value={token} type="password" autocomplete="off" placeholder="Access token" required />
    <div class="dialog-actions">
      <button value="cancel" class="quiet" onclick={cancelToken}>Cancel</button>
      <button value="connect">Connect</button>
    </div>
  </form>
</dialog>
