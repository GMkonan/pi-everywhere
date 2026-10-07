<script lang="ts">
  let { name }: { name: "bell" | "close" | "collapse" | "expand" | "image" | "menu" | "plus" | "refresh" | "send" | "settings" | "stop" | "trash" | "key" } = $props();
</script>

<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
  {#if name === "bell"}
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  {:else if name === "close"}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === "collapse"}
    <path d="m4 4 6 6M10 5v5H5M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5M20 20l-6-6M14 19v-5h5" />
  {:else if name === "expand"}
    <path d="m10 10-6-6M4 9V4h5M14 10l6-6M15 4h5v5M10 14l-6 6M4 15v5h5M14 14l6 6M15 20h5v-5" />
  {:else if name === "image"}
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m5 17 4-4 3 3 2-2 5 3" />
  {:else if name === "menu"}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === "plus"}
    <path d="M12 5v14M5 12h14" />
  {:else if name === "refresh"}
    <path d="M20 7v5h-5M4 17v-5h5M6.1 8.5A7 7 0 0 1 18.7 7M5.3 17A7 7 0 0 0 17.9 15.5" />
  {:else if name === "send"}
    <path d="m5 12 7-7 7 7M12 5v14" />
  {:else if name === "settings"}
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
  {:else if name === "stop"}
    <rect x="7" y="7" width="10" height="10" rx="2" />
  {:else if name === "trash"}
    <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
  {:else}
    <circle cx="8" cy="15" r="3" />
    <path d="m10.5 13.5 7-7M15 6.5h3v3M5 6h5" />
  {/if}
</svg>
