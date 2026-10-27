<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { MediaItem, PublicEvent } from '../../../shared/types';
  import QR from '../components/QR.svelte';
  import { ApiError, guestApi } from '../lib/api';
  import { isVideo } from '../lib/format';
  import { pageUrl } from '../lib/router.svelte';

  let { token }: { token: string } = $props();

  let pin: string | null = null;
  try {
    pin = sessionStorage.getItem(`snapwall.pin.${token}`);
  } catch {
    /* storage unavailable */
  }
  const api = guestApi(token, () => pin);
  const SLIDE_MS = 6000;

  let event = $state<PublicEvent | null>(null);
  let items = $state<MediaItem[]>([]);
  let index = $state(0);
  let error = $state('');
  let queue: string[] = []; // newly arrived items shown next

  const photos = $derived(items.filter((i) => !isVideo(i.mime)));
  const current = $derived(photos.length ? photos[index % photos.length] : null);
  const guestUrl = pageUrl(`e/${token}`);

  let timer: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  function advance() {
    if (!photos.length) return;
    const nextId = queue.shift();
    const i = nextId ? photos.findIndex((p) => p.id === nextId) : -1;
    index = i >= 0 ? i : (index + 1) % photos.length;
    // Warm the next image so the crossfade never shows a blank frame.
    const upcoming = photos[(index + 1) % photos.length];
    if (upcoming) new Image().src = upcoming.full;
  }

  async function refresh() {
    try {
      const page = await api.media();
      const known = new Set(items.map((i) => i.id));
      for (const item of page.items) if (!known.has(item.id) && !isVideo(item.mime)) queue.push(item.id);
      const older = items.filter((i) => !page.items.some((p) => p.id === i.id));
      items = [...page.items, ...older];
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'event_disabled' || err.code === 'event_not_found')) error = 'This event is closed.';
    }
  }

  onMount(async () => {
    try {
      event = await api.event();
      if (!event.settings.guestView) {
        error = 'Slideshow is off for this event.';
        return;
      }
      const first = await api.media();
      items = first.items;
      timer = setInterval(advance, SLIDE_MS);
      poll = setInterval(refresh, 15_000);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not load the event.';
    }
  });

  onDestroy(() => {
    clearInterval(timer);
    clearInterval(poll);
  });

  function fullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => undefined);
    else document.exitFullscreen?.();
  }
</script>

<svelte:head><title>{event ? `${event.name} · Slideshow` : 'Slideshow'}</title></svelte:head>

<div class="show" role="button" tabindex="0" ondblclick={fullscreen} onkeydown={(e) => e.key === 'f' && fullscreen()}>
  {#if error}
    <p class="msg">{error}</p>
  {:else if current}
    {#key current.id}
      <img class="slide" src={current.full} alt="" />
    {/key}
    {#if current.uploader}<p class="credit">{current.uploader}</p>{/if}
  {:else if event}
    <div class="msg">
      <p class="title">{event.name}</p>
      <p>Scan to add the first photo.</p>
    </div>
  {/if}

  {#if event && !error}
    <aside class="corner">
      <div class="qrwrap"><QR value={guestUrl} label="Scan to add photos" /></div>
      <div>
        <p class="name">{event.name}</p>
        <p class="hint">Scan to add your photos</p>
      </div>
    </aside>
  {/if}
</div>

<style>
  .show {
    position: fixed;
    inset: 0;
    background: #0a0a0a;
    color: #f2f0ec;
    overflow: hidden;
    cursor: none;
    outline: none;
  }
  .slide {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    animation: in 1.2s ease both;
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: scale(1.015);
    }
  }
  .credit {
    position: absolute;
    left: 32px;
    bottom: 28px;
    margin: 0;
    font-family: var(--serif);
    font-style: italic;
    font-size: 26px;
    text-shadow: 0 2px 20px rgba(0, 0, 0, 0.6);
  }
  .msg {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    color: #bdb9b2;
    margin: 0;
  }
  .msg .title {
    color: #f2f0ec;
  }
  .corner {
    position: absolute;
    right: 28px;
    bottom: 28px;
    display: flex;
    align-items: end;
    gap: 16px;
    padding: 14px;
    border-radius: 18px;
    background: rgba(10, 10, 10, 0.55);
    backdrop-filter: blur(12px);
  }
  .qrwrap {
    width: 120px;
  }
  .qrwrap :global(.qr) {
    padding: 8px;
    border-radius: 8px;
  }
  .name {
    font-family: var(--serif);
    font-size: 24px;
    margin: 0;
    max-width: 260px;
    line-height: 1.1;
  }
  .hint {
    margin: 4px 0 0;
    font-size: 13px;
    color: #bdb9b2;
  }
  @media (max-width: 640px) {
    .corner {
      display: none;
    }
  }
</style>
