<script lang="ts">
  import { onMount } from 'svelte';
  import type { DriveStorage } from '../../../shared/types';
  import { ApiError, session, signInUrl } from '../lib/api';
  import { driveSpace } from '../lib/format';

  /**
   * Shows nothing while loading, when there's room, or when Drive can't be asked: it's a hint, never a blocker.
   * The one exception is lost Google access, because then every guest upload fails until the owner signs in again.
   */
  let { load }: { load: () => Promise<DriveStorage> } = $props();

  let space = $state<ReturnType<typeof driveSpace>>(null);
  let disconnected = $state(false);

  onMount(() => {
    load()
      .then((s) => (space = driveSpace(s)))
      .catch((err) => (disconnected = err instanceof ApiError && err.code === 'drive_disconnected'));
  });
</script>

{#if disconnected}
  <div class="notice storage full small" role="alert">
    <strong>SnapWall can’t reach your Google Drive.</strong> Guests can’t upload until
    {#if session.get()}you sign in again. <a href={signInUrl()}>Sign in</a>{:else}the event’s owner signs in to SnapWall again.{/if}
  </div>
{:else if space}
  <div class="notice storage small" class:full={space.level === 'full'} role="status">
    {#if space.level === 'full'}
      <strong>Your Google Drive is full.</strong> Guests can’t upload until you free up space.
    {:else}
      <strong>Your Google Drive is almost full:</strong> {space.free} left of {space.total}. Guests’ uploads will fail once it’s full.
    {/if}
    <a href="https://drive.google.com/drive/quota" target="_blank" rel="noreferrer">Manage storage</a>
  </div>
{/if}

<style>
  .storage {
    margin: 0 0 24px;
  }
  .storage.full {
    border-left-color: var(--danger);
  }
  .storage a {
    white-space: nowrap;
  }
</style>
