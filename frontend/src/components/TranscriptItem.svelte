<script lang="ts">
  import type { TranscriptItem as Item } from "../lib/transcript";
  import Markdown from "./Markdown.svelte";

  let { item }: { item: Item } = $props();
</script>

{#if item.type === "user"}
  <article class="user-message">
    <div class="user-label">You</div>
    <Markdown text={item.text} />
  </article>
{:else if item.type === "answer"}
  <article class:streaming={item.streaming} class="assistant-answer">
    {#if item.streaming}
      <div class="message-content plain-text">{item.text}</div>
    {:else}
      <Markdown text={item.text} />
    {/if}
  </article>
{:else if item.type === "activity"}
  <div
    class:thinking={item.thinking}
    class:status-copy={item.status}
    class:error={item.error}
    class:streaming={item.streaming}
    class="activity-copy"
  >
    {#if item.markdown && !item.streaming}
      <Markdown text={item.text} />
    {:else}
      <div class="message-content plain-text">{item.text}</div>
    {/if}
  </div>
{:else if item.type === "tool"}
  <div class="activity-row {item.status}">
    <div class="activity-icon">{item.icon}</div>
    <div class="activity-tool">{item.label}</div>
    <div class="activity-detail">{item.detail}</div>
    <div class="activity-state">{item.status === "running" ? "●" : item.status === "error" ? "!" : item.status === "done" ? "✓" : ""}</div>
  </div>
{:else}
  <div class="answer-separator" data-streaming={item.streaming ? "true" : undefined} role="separator"></div>
{/if}
