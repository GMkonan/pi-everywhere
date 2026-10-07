<script lang="ts">
  import { tick } from "svelte";
  import { loadOlderHistory, selectSession, transcriptState } from "../lib/controller";
  import TranscriptItem from "./TranscriptItem.svelte";

  const BOTTOM_FOLLOW_DISTANCE = 24;

  let root: HTMLDivElement;
  let previousRevision = -1;
  let previousInstanceId: string | undefined;
  let followLatest = true;
  let lastScrollTop = 0;
  let scrollRenderToken = 0;
  let pendingScroll = {
    revision: -1,
    mode: "bottom",
    oldHeight: 0,
    oldTop: 0,
    hasPrevious: false,
    followLatest: true,
  };

  $effect.pre(() => {
    const sameConversation = previousInstanceId === $transcriptState.instanceId;
    if (!sameConversation) followLatest = true;
    pendingScroll = {
      revision: $transcriptState.revision,
      mode: $transcriptState.scrollMode,
      oldHeight: root?.scrollHeight ?? 0,
      oldTop: root?.scrollTop ?? 0,
      hasPrevious: previousRevision >= 0 && sameConversation,
      followLatest,
    };
  });

  $effect(() => {
    const revision = $transcriptState.revision;
    const instanceId = $transcriptState.instanceId;
    const scroll = pendingScroll;
    const renderToken = ++scrollRenderToken;
    previousRevision = revision;
    previousInstanceId = instanceId;
    void tick().then(() => {
      if (!root || revision < 0 || scroll.revision !== revision || renderToken !== scrollRenderToken) return;
      root.scrollTop = scroll.mode === "prepend" && scroll.hasPrevious
        ? scroll.oldTop + (root.scrollHeight - scroll.oldHeight)
        : (scroll.mode === "preserve" || !scroll.followLatest) && scroll.hasPrevious
          ? scroll.oldTop
          : root.scrollHeight;
      lastScrollTop = root.scrollTop;
    });
  });

  function trackScrollPosition(): void {
    if (!root) return;
    const top = root.scrollTop;
    const distanceFromBottom = Math.max(0, root.scrollHeight - root.clientHeight - top);
    if (top < lastScrollTop - 1) followLatest = false;
    else followLatest = distanceFromBottom <= BOTTOM_FOLLOW_DISTANCE;
    lastScrollTop = top;
  }
</script>

<div
  id="transcript"
  class="transcript"
  aria-live="polite"
  aria-busy={$transcriptState.loading || $transcriptState.loadingOlder}
  bind:this={root}
  onscroll={trackScrollPosition}
>
  {#if $transcriptState.hasOlder}
    <button
      class="load-older-button"
      type="button"
      disabled={$transcriptState.loadingOlder || !$transcriptState.canLoadOlder}
      onclick={() => $transcriptState.instanceId && loadOlderHistory($transcriptState.instanceId)}
    >
      {#if $transcriptState.loadingOlder}
        <span class="inline-loader" aria-hidden="true"></span>
        <span>Loading older messages…</span>
      {:else}
        <span>Load older messages</span>
      {/if}
    </button>
  {/if}
  {#if $transcriptState.loading && $transcriptState.items.length === 0}
    <div class="conversation-loading" role="status">
      <span class="history-loader" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
      <strong>Loading history</strong>
      <span>Syncing this Pi session…</span>
    </div>
  {:else if $transcriptState.loadError && $transcriptState.items.length === 0}
    <div class="conversation-load-error" role="alert">
      <strong>History stopped loading</strong>
      <span>{$transcriptState.loadError}</span>
      {#if $transcriptState.instanceId}
        <button type="button" onclick={() => selectSession($transcriptState.instanceId!)}>Try again</button>
      {/if}
    </div>
  {/if}
  {#each $transcriptState.items as item (item.id)}
    <TranscriptItem {item} />
  {/each}
</div>
