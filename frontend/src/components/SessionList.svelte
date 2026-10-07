<script lang="ts">
  import { agentActivityAt, basename, formatActivityTime, groupAgentsByDate, sessionName } from "../lib/session-list";
  import { selectSession, sessionListState } from "../lib/controller";
  import SessionMark from "./SessionMark.svelte";

  let groups = $derived(groupAgentsByDate($sessionListState.agents));
</script>

<div id="agents" class="session-groups" aria-busy={$sessionListState.syncing}>
  {#if $sessionListState.agents.length === 0}
    <div class="sessions-empty">No live Pi sessions. Start Pi with the extension loaded to see it here.</div>
  {:else}
    {#each groups as group (group.key)}
      <section class="session-group">
        <h2>{group.label}</h2>
        {#each group.agents as agent (agent.instanceId)}
          {@const activity = agentActivityAt(agent)}
          <button
            type="button"
            class:selected={agent.instanceId === $sessionListState.selectedId}
            class:working={!agent.meta.idle}
            class="session-row"
            title={agent.meta.cwd}
            onclick={() => selectSession(agent.instanceId)}
          >
            <SessionMark working={!agent.meta.idle} />
            <span class="session-summary">
              <strong>{sessionName(agent)}</strong>
              <small>{basename(agent.meta.cwd) || agent.meta.cwd}</small>
            </span>
            <span class="session-trailing">
              <time datetime={new Date(activity).toISOString()}>{formatActivityTime(activity)}</time>
              {#if !agent.meta.idle}
                <span class="working-badge">
                  <span class="working-bars" aria-hidden="true"><i></i><i></i><i></i></span>
                  Working
                </span>
              {/if}
            </span>
          </button>
        {/each}
      </section>
    {/each}
  {/if}
</div>
