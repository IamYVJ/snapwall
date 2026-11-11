<script lang="ts">
  import { onMount } from 'svelte';
  import { session, signedInHere } from '../lib/api';
  import { go } from '../lib/router.svelte';

  let { token, nonce }: { token: string; nonce: string } = $props();

  onMount(() => {
    let next = '';
    try {
      next = sessionStorage.getItem('snapwall.next') ?? '';
      sessionStorage.removeItem('snapwall.next');
    } catch {
      /* storage unavailable */
    }
    // Replace the history entry so the session token doesn't linger in back/forward history.
    if (!signedInHere(nonce)) {
      // Not started from this browser, so possibly a link meant to sign this person in to someone else's account.
      go('signin-error/elsewhere', { replace: true });
      return;
    }
    session.set(token);
    go(next, { replace: true });
  });
</script>

<div class="center-screen"><div class="spinner"></div></div>
