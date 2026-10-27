<script lang="ts">
  import Wordmark from '../components/Wordmark.svelte';
  import { signInUrl } from '../lib/api';

  let { code }: { code: string } = $props();

  const messages: Record<string, string> = {
    access_denied: 'Sign-in was cancelled.',
    drive_scope:
      'SnapWall needs permission to create files in your Google Drive — that is where your guests’ photos are saved. Please sign in again and keep the Drive box ticked.',
    state: 'That sign-in link expired. Please try again.',
  };
</script>

<div class="center-screen">
  <div class="stack narrow" style="--gap: 24px">
    <Wordmark />
    <h1 class="title">Couldn’t sign you in</h1>
    <p class="lede" style="margin-inline: auto">{messages[code] ?? 'Something went wrong while signing in with Google.'}</p>
    <div class="row" style="justify-content: center">
      <a class="btn" href={signInUrl()}>Try again</a>
      <a class="btn ghost" href="#/">Home</a>
    </div>
  </div>
</div>
