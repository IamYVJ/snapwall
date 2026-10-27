<script lang="ts">
  import { onMount } from 'svelte';
  import { session } from '../lib/api';
  import { go } from '../lib/router.svelte';

  let { token }: { token: string } = $props();

  onMount(() => {
    session.set(token);
    let next = '';
    try {
      next = sessionStorage.getItem('snapwall.next') ?? '';
      sessionStorage.removeItem('snapwall.next');
    } catch {
      /* storage unavailable */
    }
    // Replace the history entry so the session token doesn't linger in back/forward history.
    go(next, { replace: true });
  });
</script>

<div class="center-screen"><div class="spinner"></div></div>
