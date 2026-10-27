<script lang="ts">
  import { onMount } from 'svelte';
  import type { Me } from '../../../shared/types';
  import Modal from '../components/Modal.svelte';
  import Wordmark from '../components/Wordmark.svelte';
  import { owner, session, signInUrl } from '../lib/api';
  import { formatDate, plural } from '../lib/format';
  import { go } from '../lib/router.svelte';

  let me = $state<Me | null>(null);
  let loading = $state(!!session.get());
  let confirmDisconnect = $state(false);
  let busy = $state(false);

  onMount(() => {
    if (!session.get()) return;
    owner
      .me()
      .then((m) => (me = m))
      .catch(() => (me = null))
      .finally(() => (loading = false));
  });

  function startCreate() {
    try {
      sessionStorage.setItem('snapwall.next', 'new');
    } catch {
      /* storage unavailable */
    }
  }

  async function signOut() {
    await owner.logout().catch(() => undefined);
    me = null;
  }

  async function disconnect() {
    busy = true;
    await owner.disconnect().catch(() => undefined);
    busy = false;
    confirmDisconnect = false;
    me = null;
  }
</script>

{#if loading}
  <div class="center-screen"><div class="spinner"></div></div>
{:else if me}
  <div class="page">
    <header class="top row">
      <Wordmark />
      <span class="spacer"></span>
      <span class="muted small email">{me.email}</span>
      <button class="link" onclick={signOut}>Sign out</button>
    </header>

    <section class="head row rise">
      <div class="stack" style="--gap: 8px">
        <p class="eyebrow">Your events</p>
        <h1 class="title">{me.events.length ? 'Welcome back' : 'Your first event'}</h1>
      </div>
      <span class="spacer"></span>
      <button class="btn" onclick={() => go('new')}>New event</button>
    </section>

    {#if me.events.length}
      <ul class="events">
        {#each me.events as e (e.id)}
          <li>
            <a href="#/manage/{e.id}" class="event">
              <span class="name">{e.name}</span>
              <span class="meta muted small">{e.date ? formatDate(e.date) : 'No date'} · {plural(e.count, 'item')}</span>
              <span class="pill" class:live={e.status === 'active'} class:off={e.status !== 'active'}>
                <span class="dot"></span>{e.status === 'active' ? 'Live' : 'Disabled'}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="empty card">
        <p class="lede">Create an event to get a guest link and QR code. Everything your guests share lands in a folder in your Google Drive.</p>
      </div>
    {/if}

    <footer class="foot row">
      <a class="link" href="#/privacy">Privacy</a>
      <span class="spacer"></span>
      <button class="link" onclick={() => (confirmDisconnect = true)}>Disconnect Google</button>
    </footer>
  </div>

  <Modal bind:open={confirmDisconnect} title="Disconnect Google?">
    <p class="muted">
      This revokes SnapWall’s access to your Drive and erases your account and every event from SnapWall. All guest links stop working. Photos
      already in your Drive stay there.
    </p>
    <div class="row">
      <button class="btn danger solid" disabled={busy} onclick={disconnect}>Disconnect and erase</button>
      <button class="btn ghost" onclick={() => (confirmDisconnect = false)}>Cancel</button>
    </div>
  </Modal>
{:else}
  <div class="landing">
    <div class="page">
      <header class="top row">
        <Wordmark />
        <span class="spacer"></span>
        <a class="link" href={signInUrl()}>Sign in</a>
      </header>

      <section class="hero rise">
        <p class="eyebrow">Shared event albums</p>
        <h1 class="display">Every moment,<br /><em class="serif">in your own</em> Drive.</h1>
        <p class="lede">
          Guests scan a QR code and add their photos and videos. No app, no account. Everything lands straight in your Google Drive and nowhere
          else.
        </p>
        <div class="row cta">
          <a class="btn lg" href={signInUrl()} onclick={startCreate}>Create an event</a>
          <span class="muted small">Free · Sign in with Google</span>
        </div>
      </section>

      <section class="points">
        <article>
          <span class="num">01</span>
          <h2 class="h2">Your storage</h2>
          <p class="muted">Files go directly from each guest’s phone to a folder in your Drive. SnapWall never keeps a copy.</p>
        </article>
        <article>
          <span class="num">02</span>
          <h2 class="h2">Private by default</h2>
          <p class="muted">Unguessable links, nothing made public in Drive, and location data removed from photos before upload.</p>
        </article>
        <article>
          <span class="num">03</span>
          <h2 class="h2">You’re in control</h2>
          <p class="muted">Pause uploads, approve photos, rotate a leaked link or delete the event. It all takes effect instantly.</p>
        </article>
      </section>

      <footer class="foot row">
        <span class="muted small">SnapWall</span>
        <span class="spacer"></span>
        <a class="link" href="#/privacy">Privacy</a>
      </footer>
    </div>
  </div>
{/if}

<style>
  .top {
    padding: 24px 0;
  }
  .email {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 50vw;
  }
  .hero {
    padding: clamp(48px, 12vh, 140px) 0 clamp(56px, 10vh, 120px);
    display: grid;
    gap: 28px;
  }
  .cta {
    gap: 20px;
    margin-top: 8px;
  }
  .points {
    display: grid;
    gap: 40px;
    padding: 48px 0 80px;
    border-top: 1px solid var(--line);
  }
  @media (min-width: 800px) {
    .points {
      grid-template-columns: repeat(3, 1fr);
      gap: 48px;
    }
  }
  .points article {
    display: grid;
    gap: 10px;
    align-content: start;
  }
  .points p {
    margin: 0;
  }
  .num {
    font-size: 12px;
    letter-spacing: 0.14em;
    color: var(--accent);
    font-weight: 600;
  }
  .head {
    padding: 40px 0 32px;
    align-items: end;
  }
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--line);
  }
  .event {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 16px;
    padding: 22px 0;
    border-bottom: 1px solid var(--line);
    text-decoration: none;
    transition: padding 0.2s ease;
  }
  .event:hover {
    padding-left: 8px;
  }
  .name {
    font-family: var(--serif);
    font-size: 28px;
    line-height: 1.1;
  }
  .meta {
    grid-column: 1;
  }
  .event .pill {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
  }
  .empty {
    margin-top: 8px;
  }
  .foot {
    padding: 32px 0 48px;
    border-top: 1px solid var(--line);
    margin-top: 48px;
  }
  .landing .foot {
    margin-top: 0;
  }
</style>
