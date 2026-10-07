<script lang="ts">
  import {
    appState,
    changeDeviceAccess,
    clearHistoryCache,
    closeSettings,
    reconnect,
    toggleNotifications,
  } from "../lib/controller";
  import { applyTheme, storedTheme, themes, type ThemeId } from "../lib/theme";
  import Icon from "./Icon.svelte";

  let selectedTheme = $state<ThemeId>(storedTheme());

  function chooseTheme(theme: ThemeId): void {
    selectedTheme = theme;
    applyTheme(theme);
  }
</script>

<section id="settings-view" class="settings-view" aria-labelledby="settings-title" hidden={!$appState.settingsOpen}>
  <header class="settings-header">
    <button id="close-settings" class="icon-button" type="button" aria-label="Close settings" onclick={closeSettings}>
      <Icon name="close" />
    </button>
    <h1 id="settings-title">Settings</h1>
    <span class="settings-header-spacer" aria-hidden="true"></span>
  </header>

  <div class="settings-content">
    <div class="settings-identity">
      <img src="/icon.svg" alt="" />
      <div>
        <strong>pi-everywhere</strong>
        <span>Your live Pi, anywhere.</span>
      </div>
    </div>

    <section class="settings-section" aria-labelledby="connection-settings-title">
      <h2 id="connection-settings-title">Connection</h2>
      <div class="settings-card">
        <div class="setting-status-row">
          <span class="setting-icon"><span id="settings-connection-dot" class:online={$appState.connection === "online"} class:offline={$appState.connection !== "online"} class="connection-dot"></span></span>
          <span class="setting-copy">
            <strong>Bridge status</strong>
            <small id="settings-connection-status">{$appState.connection[0].toUpperCase() + $appState.connection.slice(1)}</small>
          </span>
        </div>
        <button id="reconnect" class="setting-row" type="button" onclick={reconnect}>
          <span class="setting-icon"><Icon name="refresh" /></span>
          <span class="setting-copy">
            <strong>Reconnect now</strong>
            <small>Refresh the live connection without reloading the app</small>
          </span>
        </button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="appearance-settings-title">
      <h2 id="appearance-settings-title">Appearance</h2>
      <div class="theme-picker" role="radiogroup" aria-label="Color theme">
        {#each themes as theme}
          <button
            type="button"
            class="theme-choice"
            class:active={selectedTheme === theme.id}
            data-theme-option={theme.id}
            role="radio"
            aria-checked={selectedTheme === theme.id}
            onclick={() => chooseTheme(theme.id)}
          >
            <span class="theme-preview" aria-hidden="true">
              <span class="theme-preview-sidebar"></span>
              <span class="theme-preview-lines"><i></i><i></i><i></i></span>
              <span class="theme-preview-accent"></span>
            </span>
            <span class="theme-choice-copy">
              <strong>{theme.name}</strong>
              <small>{theme.description}</small>
            </span>
            <span class="theme-check" aria-hidden="true">✓</span>
          </button>
        {/each}
      </div>
    </section>

    <section class="settings-section" aria-labelledby="app-settings-title">
      <h2 id="app-settings-title">App</h2>
      <div class="settings-card">
        <button
          id="notifications"
          class="setting-row notification-button"
          class:active={$appState.notifications.active}
          class:warning={$appState.notifications.warning}
          type="button"
          aria-label={$appState.notifications.label}
          title={$appState.notifications.label}
          hidden={!$appState.notifications.supported}
          disabled={$appState.notifications.busy}
          onclick={() => void toggleNotifications()}
        >
          <span class="setting-icon"><Icon name="bell" /></span>
          <span class="setting-copy">
            <strong>Notifications</strong>
            <small>Get a notice when Pi finishes working</small>
          </span>
        </button>
        <button id="clear-history-cache" class="setting-row" type="button" onclick={clearHistoryCache}>
          <span class="setting-icon"><Icon name="trash" /></span>
          <span class="setting-copy">
            <strong>Clear history cache</strong>
            <small>Forget locally cached conversations and fetch them again</small>
          </span>
        </button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="access-settings-title">
      <h2 id="access-settings-title">Access</h2>
      <div class="settings-card">
        <button id="change-token" class="setting-row setting-row-danger" type="button" onclick={changeDeviceAccess}>
          <span class="setting-icon"><Icon name="key" /></span>
          <span class="setting-copy">
            <strong>Change device access</strong>
            <small>Disconnect this credential and pair again</small>
          </span>
        </button>
      </div>
    </section>

    <p class="settings-footnote">Session history stays in memory only and is never stored by the service worker.</p>
  </div>
</section>
