<script lang="ts">
  let { name }: { name: "bell" | "close" | "menu" | "send" | "stop" | "key" } = $props();
</script>

<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
  {#if name === "bell"}
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  {:else if name === "close"}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === "menu"}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === "send"}
    <path d="m5 12 7-7 7 7M12 5v14" />
  {:else if name === "stop"}
    <rect x="7" y="7" width="10" height="10" rx="2" />
  {:else}
    <circle cx="8" cy="15" r="3" />
    <path d="m10.5 13.5 7-7M15 6.5h3v3M5 6h5" />
  {/if}
</svg>
