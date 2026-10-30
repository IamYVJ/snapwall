<script lang="ts">
  import { copyText } from '../lib/format';
  import { install } from '../lib/install.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';

  let addHelp = $state(false);
  let openHelp = $state(false);
  let copied = $state(false);

  // iOS opens links in Safari even when SnapWall is on the home screen, so the link goes over by copy and paste.
  async function openInApp() {
    copied = await copyText(location.href);
    openHelp = true;
  }

  function addAgain() {
    openHelp = false;
    addHelp = true;
  }
</script>

{#if install.canPrompt}
  <button class="btn ghost sm" onclick={() => install.prompt()}><Icon name="phone" size={16} /><span class="wide-only">Add to home screen</span><span class="narrow-only">Install</span></button>
{:else if install.manual && install.added}
  <button class="btn ghost sm" onclick={openInApp}><Icon name="phone" size={16} /><span class="wide-only">Open in the app</span><span class="narrow-only">Open in app</span></button>
{:else if install.manual}
  <button class="btn ghost sm" onclick={() => (addHelp = true)}><Icon name="phone" size={16} /><span class="wide-only">Add to home screen</span><span class="narrow-only">Install</span></button>
{/if}

<Modal bind:open={addHelp} title="Add to home screen">
  <ol class="steps">
    <li>Tap <Icon name="share" size={18} /> <strong>Share</strong> in Safari’s toolbar.</li>
    <li>Scroll down and choose <strong>Add to Home Screen</strong>.</li>
    <li>Tap <strong>Add</strong>. The icon opens this event, and its home page lists every event you’ve opened.</li>
  </ol>
  <div><button class="btn" onclick={() => (install.markAdded(), (addHelp = false))}>Done</button></div>
</Modal>

<Modal bind:open={openHelp} title="Open in the SnapWall app">
  {#if copied}
    <p class="muted" style="margin: 0">This page’s link is copied.</p>
  {:else}
    <p class="muted" style="margin: 0">Copy this page’s link first:</p>
    <input class="input" readonly value={location.href} onfocus={(e) => e.currentTarget.select()} />
  {/if}
  <ol class="steps">
    <li>Open <strong>SnapWall</strong> from your home screen.</li>
    <li>Tap <strong>Add from link</strong> and allow pasting.</li>
  </ol>
  <p class="small muted" style="margin: 0">
    The event then stays in the app. <button class="link" onclick={addAgain}>Don’t have the app?</button>
  </p>
  <div><button class="btn" onclick={() => (openHelp = false)}>Done</button></div>
</Modal>

<style>
  @media (max-width: 520px) {
    .wide-only {
      display: none;
    }
  }
  @media (min-width: 521px) {
    .narrow-only {
      display: none;
    }
  }
  .steps {
    margin: 0;
    padding-left: 20px;
    color: var(--muted);
    display: grid;
    gap: 10px;
  }
  .steps :global(svg) {
    vertical-align: -3px;
  }
  .steps strong {
    color: var(--fg);
    font-weight: 600;
  }
</style>
