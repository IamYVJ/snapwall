<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { MediaItem, PublicEvent } from '../../../shared/types';
  import QR from '../components/QR.svelte';
  import { ApiError, guestApi } from '../lib/api';
  import { isVideo } from '../lib/format';
  import { pageUrl } from '../lib/router.svelte';

  let { token }: { token: string } = $props();

  // Shared with the guest wall, so a PIN entered on either works for both in this tab.
  const pinKey = `snapwall.pin.${token}`;
  let pin: string | null = null;
  try {
    pin = sessionStorage.getItem(pinKey);
  } catch {
    /* storage unavailable */
  }
  /** The slideshow is often opened in a new tab or on another screen, where no PIN was entered yet, so it asks itself. */
  let askPin = $state(false);
  let pinInput = $state('');
  let pinError = $state('');
  let checking = $state(false);
  const api = guestApi(token, () => pin);
  const SLIDE_MS = 6000;
  // A new photo cuts in as soon as it has loaded, but never before the current one has been up this long.
  const MIN_SHOW_MS = 1500;

  let event = $state<PublicEvent | null>(null);
  let items = $state<MediaItem[]>([]);
  let index = $state(0);
  let error = $state('');
  let queue: string[] = []; // newly arrived items shown next

  const photos = $derived(items.filter((i) => !isVideo(i.mime)));
  const current = $derived(photos.length ? photos[index % photos.length] : null);
  const guestUrl = pageUrl(`e/${token}`);

  let timer: ReturnType<typeof setInterval> | undefined;
  let shownAt = Date.now();
  const live = new AbortController();

  function advance() {
    if (!photos.length) return;
    const nextId = queue.shift();
    const i = nextId ? photos.findIndex((p) => p.id === nextId) : -1;
    index = i >= 0 ? i : (index + 1) % photos.length;
    shownAt = Date.now();
    // Warm the next image so the crossfade never shows a blank frame.
    const upcoming = photos[(index + 1) % photos.length];
    if (upcoming) new Image().src = upcoming.full;
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(advance, SLIDE_MS);
  }

  /** Shows the first queued photo once it has decoded, then restarts the regular rhythm from it. */
  async function cutToNew() {
    const id = queue[0];
    const item = photos.find((p) => p.id === id);
    if (!item) return;
    const img = new Image();
    img.src = item.full;
    await img.decode().catch(() => undefined);
    setTimeout(
      () => {
        if (queue[0] !== id) return;
        advance();
        startTimer();
      },
      Math.max(0, shownAt + MIN_SHOW_MS - Date.now()),
    );
  }

  function closedMessage(err: unknown): string | null {
    if (!(err instanceof ApiError)) return null;
    if (err.code === 'event_disabled' || err.code === 'event_not_found') return 'This event is closed.';
    if (err.code === 'view_disabled') return 'Slideshow is off for this event.';
    return null;
  }

  /**
   * The whole wall, not just its newest page, so a big event's older photos come round too. Live updates only fetch
   * the newest page, so this also runs every RELOAD_ALL_MS: it drops photos hidden or deleted further down, and
   * replaces signed links before they expire (they last 30–60 minutes) on a show that runs all evening.
   */
  const RELOAD_ALL_MS = 15 * 60_000;
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  async function reloadAll() {
    try {
      const all: MediaItem[] = [];
      let cursor: string | null = null;
      do {
        const page = await api.media(cursor);
        all.push(...page.items);
        cursor = page.next;
      } while (cursor && !live.signal.aborted);
      if (live.signal.aborted) return;
      // Keep anything newer that a live update brought in while the pages were loading.
      const ids = new Set(all.map((i) => i.id));
      const newest = all[0]?.createdAt ?? 0;
      const keep = current?.id;
      items = [...items.filter((i) => !ids.has(i.id) && i.createdAt > newest), ...all];
      const at = keep ? photos.findIndex((p) => p.id === keep) : -1;
      if (at >= 0) index = at;
      queue = queue.filter((id) => photos.some((p) => p.id === id));
    } catch (err) {
      if (!wantsPin(err)) error = closedMessage(err) ?? error;
    }
  }

  /** A slide that won't load (removed meanwhile, or not ready yet) is skipped after a moment. */
  function slideFailed() {
    const id = current?.id;
    setTimeout(() => {
      if (current?.id !== id) return;
      advance();
      startTimer();
    }, 1000);
  }

  /** Shows the PIN screen if the event wants a PIN (or a different one, if the host changed it). */
  function wantsPin(err: unknown): boolean {
    if (!(err instanceof ApiError) || !['pin_required', 'pin_wrong', 'pin_locked'].includes(err.code)) return false;
    pinError = err.code === 'pin_wrong' ? 'That PIN isn’t right.' : err.code === 'pin_locked' ? err.message : '';
    askPin = true;
    return true;
  }

  let refreshing = false;
  let again = false;
  async function refresh() {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      const page = await api.media();
      const known = new Set(items.map((i) => i.id));
      const fresh = page.items.filter((i) => !known.has(i.id) && !isVideo(i.mime)).map((i) => i.id);
      // Items newer than the end of this page but missing from it were hidden or deleted.
      const pageIds = new Set(page.items.map((i) => i.id));
      const oldest = page.items.at(-1)?.createdAt ?? Infinity;
      const older = items.filter((i) => !pageIds.has(i.id) && i.createdAt < oldest);
      const keep = current?.id;
      items = [...page.items, ...older];
      // Keep the current photo on screen even though its position in the list moved.
      const at = keep ? photos.findIndex((p) => p.id === keep) : -1;
      if (at >= 0) index = at;
      queue = [...queue.filter((id) => photos.some((p) => p.id === id)), ...fresh];
      if (fresh.length) void cutToNew();
    } catch (err) {
      if (!wantsPin(err)) error = closedMessage(err) ?? error;
    } finally {
      refreshing = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Keeps a live stream open; every version change refetches the media list. Falls back to polling. */
  let listening = false;
  async function listen() {
    if (listening) return;
    listening = true;
    try {
      await stream();
    } finally {
      listening = false;
    }
  }

  async function stream() {
    let seen: string | null = null;
    while (!live.signal.aborted && !error && !askPin) {
      const started = Date.now();
      try {
        await api.live((data) => {
          if (data === 'closed') error = 'This event is closed.';
          else if (data !== seen) {
            // Also runs on the first message, to catch anything that arrived between the initial load and connecting.
            seen = data;
            void refresh();
          }
        }, live.signal);
      } catch (err) {
        if (live.signal.aborted || wantsPin(err)) return;
        const closed = closedMessage(err);
        if (closed) {
          error = closed;
          return;
        }
        await refresh();
        await sleep(15_000);
        continue;
      }
      // Don't spin if a stream ends right away.
      if (Date.now() - started < 5000) await sleep(5000);
    }
  }

  async function start() {
    try {
      event = await api.event();
      askPin = false;
      if (!event.settings.guestView) {
        error = 'Slideshow is off for this event.';
        return;
      }
      // The newest page starts the show at once; the rest of the wall follows in the background.
      const first = await api.media();
      items = first.items;
      startTimer();
      void listen();
      if (first.next) void reloadAll();
      clearInterval(reloadTimer);
      reloadTimer = setInterval(reloadAll, RELOAD_ALL_MS);
    } catch (err) {
      if (!wantsPin(err)) error = err instanceof ApiError ? err.message : 'Could not load the event.';
    }
  }

  async function submitPin(e: SubmitEvent) {
    e.preventDefault();
    pin = pinInput.trim();
    try {
      sessionStorage.setItem(pinKey, pin);
    } catch {
      /* storage unavailable: the PIN lasts until the page closes */
    }
    checking = true;
    await start();
    checking = false;
  }

  onMount(start);

  onDestroy(() => {
    clearInterval(timer);
    clearInterval(reloadTimer);
    live.abort();
  });

  function fullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => undefined);
    else document.exitFullscreen?.();
  }

  /** Double-click or F anywhere on the show, photo included, but not while typing or clicking in the PIN form. */
  const onShow = (e: Event) => !(e.target as Element | null)?.closest?.('form');
</script>

<svelte:head><title>{event ? `${event.name} · Slideshow` : 'Slideshow'}</title></svelte:head>

<div
  class="show"
  class:asking={askPin}
  role="button"
  tabindex="0"
  ondblclick={(e) => onShow(e) && fullscreen()}
  onkeydown={(e) => onShow(e) && e.key === 'f' && fullscreen()}
>
  {#if error}
    <p class="msg">{error}</p>
  {:else if askPin}
    <form class="msg pinform" onsubmit={submitPin}>
      <p class="title">Enter the event PIN</p>
      <input
        class="pin"
        bind:value={pinInput}
        inputmode="numeric"
        autocomplete="off"
        maxlength="8"
        placeholder="••••"
        aria-label="PIN"
      />
      {#if pinError}<p class="pin-error">{pinError}</p>{/if}
      <div><button class="btn" type="submit" disabled={pinInput.trim().length < 4 || checking}>Start slideshow</button></div>
    </form>
  {:else if current}
    {#key current.id}
      <img class="slide" src={current.full} alt="" onerror={slideFailed} />
    {/key}
    {#if current.uploader}<p class="credit">{current.uploader}</p>{/if}
  {:else if event}
    <div class="msg">
      <p class="title">{event.name}</p>
      <p>Scan to add the first photo.</p>
    </div>
  {/if}

  {#if event && !error && !askPin}
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
  .show.asking {
    cursor: auto;
  }
  .pinform {
    gap: 16px;
  }
  .pinform .title {
    font-family: var(--serif);
    font-size: 28px;
    margin: 0;
  }
  .pin {
    font: inherit;
    font-size: 28px;
    letter-spacing: 0.4em;
    text-align: center;
    width: 220px;
    margin-inline: auto;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid #3a3835;
    background: #1a1918;
    color: #f2f0ec;
  }
  .pin-error {
    margin: 0;
    color: #f0a39a;
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
