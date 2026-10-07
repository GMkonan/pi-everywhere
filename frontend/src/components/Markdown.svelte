<script lang="ts">
  import { renderMarkdown } from "../lib/markdown";

  let { text }: { text: string } = $props();
  let root: HTMLDivElement;

  $effect(() => {
    root.replaceChildren(renderMarkdown(text, document));
  });
</script>

<div class="message-content markdown" bind:this={root}></div>
