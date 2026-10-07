<script lang="ts">
  let { working = false }: { working?: boolean } = $props();
</script>

<span class:working class="session-icon" aria-hidden="true">
  {#if working}
    <span class="session-pulse"></span>
    <span class="session-orbit"><i></i><i></i><i></i></span>
  {/if}
  <svg class="session-mark" viewBox="0 0 24 24">
    <circle cx="6" cy="12" r="2.25" />
    <circle cx="18" cy="7" r="2.25" />
    <circle cx="18" cy="17" r="2.25" />
    <path d="m8 11 7.8-3M8 13l7.8 3" />
  </svg>
</span>
