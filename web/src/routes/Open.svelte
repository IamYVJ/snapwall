<script lang="ts">
  import { onMount } from 'svelte';
  import { go } from '../lib/router.svelte';
  import { decodeHandoff } from '../lib/saved';
  import { saved } from '../lib/saved.svelte';

  // The installed app's start link on iOS, carrying what Safari had (see install.svelte.ts).
  let { code }: { code: string } = $props();

  const KEY = 'snapwall.received';

  onMount(() => {
    // A fingerprint rather than the link itself, so the sign-in it carries isn't kept after signing out.
    const fingerprint = [...code].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);
    // iOS opens the same start link on every launch. Only the first takes it in, so events removed and sign-outs
    // in the app stick, and later launches open the home page.
    let first = true;
    try {
      first = localStorage.getItem(KEY) !== fingerprint;
      localStorage.setItem(KEY, fingerprint);
    } catch {
      /* storage unavailable */
    }
    const handoff = first ? decodeHandoff(code) : null;
    if (handoff) saved.receive(handoff);
    // Replace the history entry so the sign-in and links don't linger in back/forward history.
    go(handoff?.to ?? '', { replace: true });
  });
</script>

<div class="center-screen"><div class="spinner"></div></div>
