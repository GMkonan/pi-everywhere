<script lang="ts">
  import { tick } from "svelte";
  import { transcriptState } from "../lib/ui-bridge";
  import TranscriptItem from "./TranscriptItem.svelte";

  let root: HTMLDivElement;

  $effect(() => {
    const revision = $transcriptState.revision;
    void tick().then(() => {
      if (root && revision >= 0) root.scrollTop = root.scrollHeight;
    });
  });
</script>

<div id="transcript" class="transcript" aria-live="polite" aria-busy={$transcriptState.loading} bind:this={root}>
  {#if $transcriptState.loading && $transcriptState.items.length === 0}
    <div class="conversation-loading" role="status">Loading history…</div>
  {/if}
  {#each $transcriptState.items as item (item.id)}
    <TranscriptItem {item} />
  {/each}
</div>
