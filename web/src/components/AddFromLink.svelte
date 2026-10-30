<script lang="ts">
  import { go } from '../lib/router.svelte';
  import { linkRoute } from '../lib/saved';
  import Modal from './Modal.svelte';

  let { button = false }: { button?: boolean } = $props();

  let open = $state(false);
  let text = $state('');
  let wrong = $state(false);

  // Mostly for the iOS app, which can't see links opened in Safari: the guest copies the link there and pastes it here.
  async function start() {
    const pasted = await navigator.clipboard?.readText().catch(() => '');
    const route = pasted ? linkRoute(pasted) : null;
    if (route) return go(route);
    text = '';
    wrong = false;
    open = true;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const route = linkRoute(text);
    if (route) go(route);
    else wrong = true;
  }
</script>

<button class={button ? 'btn ghost' : 'link'} onclick={start}>Add from link</button>

<Modal bind:open title="Add an event from a link">
  <p class="muted" style="margin: 0">Paste the guest or admin link you were sent. The event is then listed on this device.</p>
  <form class="stack" onsubmit={submit}>
    <input class="input" bind:value={text} oninput={() => (wrong = false)} placeholder="https://…/snapwall/#/e/…" autocomplete="off" />
    {#if wrong}<p class="small error-text" role="alert" style="margin: 0">That isn’t a SnapWall event link.</p>{/if}
    <div class="row">
      <button class="btn" type="submit" disabled={!text.trim()}>Open</button>
      <button class="btn ghost" type="button" onclick={() => (open = false)}>Cancel</button>
    </div>
  </form>
</Modal>
