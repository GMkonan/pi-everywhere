<script lang="ts">
  import { tick } from "svelte";
  import { loadOlderHistory, transcriptState } from "../lib/ui-bridge";
  import TranscriptItem from "./TranscriptItem.svelte";

  let root: HTMLDivElement;
  let previousRevision = -1;
  let pendingScroll = { revision: -1, mode: "bottom", oldHeight: 0, oldTop: 0, hasPrevious: false };

  $effect.pre(() => {
    pendingScroll = {
      revision: $transcriptState.revision,
      mode: $transcriptState.scrollMode,
      oldHeight: root?.scrollHeight ?? 0,
      oldTop: root?.scrollTop ?? 0,
      hasPrevious: previousRevision >= 0,
    };
  });

  $effect(() => {
    const revision = $transcriptState.revision;
    const scroll = pendingScroll;
    previousRevision = revision;
    void tick().then(() => {
      if (!root || revision < 0 || scroll.revision !== revision) return;
      root.scrollTop = scroll.mode === "prepend" && scroll.hasPrevious
        ? scroll.oldTop + (root.scrollHeight - scroll.oldHeight)
        : scroll.mode === "preserve" && scroll.hasPrevious
          ? scroll.oldTop
          : root.scrollHeight;
    });
  });
</script>

<div id="transcript" class="transcript" aria-live="polite" aria-busy={$transcriptState.loading || $transcriptState.loadingOlder} bind:this={root}>
  {#if $transcriptState.hasOlder}
    <button
      class="load-older-button"
      type="button"
      disabled={$transcriptState.loadingOlder || !$transcriptState.canLoadOlder}
      onclick={() => $transcriptState.instanceId && loadOlderHistory($transcriptState.instanceId)}
    >
      {$transcriptState.loadingOlder ? "Loading older messages…" : "Load older messages"}
    </button>
  {/if}
  {#if $transcriptState.loading && $transcriptState.items.length === 0}
    <div class="conversation-loading" role="status">Loading history…</div>
  {/if}
  {#each $transcriptState.items as item (item.id)}
    <TranscriptItem {item} />
  {/each}
</div>
