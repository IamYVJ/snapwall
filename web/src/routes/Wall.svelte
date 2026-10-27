<script lang="ts">
  import { downloadZip } from 'client-zip';
  import { onDestroy, onMount } from 'svelte';
  import type { MediaItem, PublicEvent } from '../../../shared/types';
  import { IMAGE_TYPES, VIDEO_TYPES } from '../../../shared/types';
  import Icon from '../components/Icon.svelte';
  import Lightbox from '../components/Lightbox.svelte';
  import MediaGrid from '../components/MediaGrid.svelte';
  import Modal from '../components/Modal.svelte';
  import { ApiError, guestApi } from '../lib/api';
  import { formatDate, plural, saveBlob } from '../lib/format';
  import { href } from '../lib/router.svelte';
  import { mimeOf, uploadFile } from '../lib/upload';

  let { token }: { token: string } = $props();

  interface Job {
    key: number;
    file: File;
    status: 'waiting' | 'uploading' | 'done' | 'error';
    progress: number;
    error?: string;
  }

  const pinKey = `snapwall.pin.${token}`;
  const nameKey = 'snapwall.name';
  const safeGet = (s: () => Storage, k: string) => {
    try {
      return s().getItem(k);
    } catch {
      return null;
    }
  };
  const safeSet = (s: () => Storage, k: string, v: string) => {
    try {
      s().setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  };

  let pin = $state(safeGet(() => sessionStorage, pinKey));
  const api = guestApi(token, () => pin);

  let phase = $state<'loading' | 'pin' | 'ready' | 'error'>('loading');
  let errorCode = $state('');
  let pinInput = $state('');
  let pinWrong = $state(false);
  let event = $state<PublicEvent | null>(null);
  let items = $state<MediaItem[]>([]);
  let next = $state<string | null>(null);
  let loadingMore = $state(false);
  let open = $state<number | null>(null);

  let jobs = $state<Job[]>([]);
  let sheetOpen = $state(false);
  let sentHere = $state(0);
  let jobKey = 0;
  let active = 0;

  let uploader = $state(safeGet(() => localStorage, nameKey) ?? '');
  let askName = $state(false);
  let pendingFiles: File[] = [];
  let fileInput: HTMLInputElement;

  let selecting = $state(false);
  let selected = $state(new Set<string>());
  let zipping = $state(false);

  let poll: ReturnType<typeof setInterval> | undefined;
  let sentinel = $state<HTMLElement>();

  const accept = $derived(event?.settings.allowVideo ? 'image/*,video/*' : 'image/*');
  const doneCount = $derived(jobs.filter((j) => j.status === 'done').length);
  const busyCount = $derived(jobs.filter((j) => j.status === 'waiting' || j.status === 'uploading').length);
  const overall = $derived(jobs.length ? jobs.reduce((s, j) => s + (j.status === 'done' ? 1 : j.progress), 0) / jobs.length : 0);

  async function load() {
    try {
      event = await api.event();
      phase = 'ready';
      if (event.settings.guestView) {
        const page = await api.media();
        items = page.items;
        next = page.next;
        poll = setInterval(refresh, 20_000);
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'pin_required' || code === 'pin_wrong') {
        pinWrong = code === 'pin_wrong';
        phase = 'pin';
      } else {
        errorCode = code;
        phase = 'error';
      }
    }
  }

  async function refresh() {
    if (document.hidden || !event?.settings.guestView) return;
    try {
      const page = await api.media();
      const known = new Set(items.map((i) => i.id));
      const fresh = page.items.filter((i) => !known.has(i.id));
      if (!next) {
        items = page.items;
        next = page.next;
      } else if (fresh.length) {
        items = [...fresh, ...items];
      }
      if (event) event.count = Math.max(event.count, items.length);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'event_disabled' || err.code === 'event_not_found')) {
        clearInterval(poll);
        errorCode = err.code;
        phase = 'error';
      }
    }
  }

  async function loadMore() {
    if (!next || loadingMore) return;
    loadingMore = true;
    try {
      const page = await api.media(next);
      items = [...items, ...page.items.filter((i) => !items.some((x) => x.id === i.id))];
      next = page.next;
    } finally {
      loadingMore = false;
    }
  }

  async function submitPin(e: SubmitEvent) {
    e.preventDefault();
    pin = pinInput.trim();
    safeSet(() => sessionStorage, pinKey, pin);
    phase = 'loading';
    await load();
  }

  function pick() {
    fileInput.value = '';
    fileInput.click();
  }

  function onFiles(files: FileList | null) {
    if (!files?.length || !event) return;
    pendingFiles = [...files];
    const seen = safeGet(() => localStorage, `${nameKey}.asked`);
    if ((event.settings.requireName && !uploader.trim()) || (!uploader && !seen)) {
      askName = true;
    } else {
      enqueue();
    }
  }

  function confirmName(skip = false) {
    if (!skip && event?.settings.requireName && !uploader.trim()) return;
    if (skip) uploader = '';
    safeSet(() => localStorage, nameKey, uploader.trim());
    safeSet(() => localStorage, `${nameKey}.asked`, '1');
    askName = false;
    enqueue();
  }

  function enqueue() {
    if (!event) return;
    const s = event.settings;
    const allowed = s.allowVideo ? [...IMAGE_TYPES, ...VIDEO_TYPES] : IMAGE_TYPES;
    for (const file of pendingFiles) {
      const mime = mimeOf(file);
      const job: Job = { key: ++jobKey, file, status: 'waiting', progress: 0 };
      if (!allowed.includes(mime)) {
        job.status = 'error';
        job.error = mime.startsWith('video/') ? 'Videos aren’t accepted' : 'Unsupported file type';
      } else if (file.size > s.maxFileMB * 1024 * 1024) {
        job.status = 'error';
        job.error = `Larger than ${s.maxFileMB} MB`;
      }
      jobs.push(job);
    }
    pendingFiles = [];
    sheetOpen = true;
    pump();
  }

  function pump() {
    while (active < 2) {
      const job = jobs.find((j) => j.status === 'waiting');
      if (!job) return;
      active++;
      run(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function run(job: Job) {
    if (!event) return;
    job.status = 'uploading';
    try {
      const item = await uploadFile(
        api,
        job.file,
        { uploader: uploader.trim() || null, stripLocation: event.settings.stripLocation },
        (p) => (job.progress = p),
      );
      job.status = 'done';
      job.progress = 1;
      sentHere++;
      if (event.settings.guestView && !item.hidden) {
        items = [item, ...items];
        event.count++;
      }
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof ApiError ? err.message : 'Upload failed';
    }
  }

  function retry(job: Job) {
    job.status = 'waiting';
    job.progress = 0;
    job.error = undefined;
    pump();
  }

  function clearFinished() {
    jobs = jobs.filter((j) => j.status === 'waiting' || j.status === 'uploading');
    if (!jobs.length) sheetOpen = false;
  }

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected = s;
  }

  async function downloadSelected() {
    const chosen = items.filter((i) => selected.has(i.id) && i.download);
    if (!chosen.length) return;
    if (chosen.length === 1) {
      location.href = chosen[0].download!;
      return;
    }
    zipping = true;
    try {
      const used = new Map<string, number>();
      const unique = (name: string) => {
        const n = used.get(name) ?? 0;
        used.set(name, n + 1);
        return n ? name.replace(/(\.[^.]*)?$/, ` (${n})$1`) : name;
      };
      async function* files() {
        for (const item of chosen) {
          const res = await fetch(item.download!, { referrerPolicy: 'no-referrer' });
          if (res.ok) yield { name: unique(item.name), input: res, lastModified: new Date(item.createdAt * 1000) };
        }
      }
      const blob = await downloadZip(files()).blob();
      saveBlob(blob, `${event?.name ?? 'snapwall'}.zip`.replace(/[\\/:*?"<>|]/g, '_'));
      selecting = false;
      selected = new Set();
    } finally {
      zipping = false;
    }
  }

  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '800px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  onMount(load);
  onDestroy(() => clearInterval(poll));

  const errors: Record<string, [string, string]> = {
    event_not_found: ['This link isn’t valid', 'It may have been replaced by the host. Ask them for the latest link or QR code.'],
    event_disabled: ['This event is closed', 'The host has closed this event. Nothing more can be viewed or uploaded.'],
    offline: ['You’re offline', 'Check your connection and reload the page.'],
    drive_disconnected: ['Temporarily unavailable', 'The host needs to reconnect their Google Drive.'],
  };
</script>

<svelte:head><title>{event ? `${event.name} · SnapWall` : 'SnapWall'}</title></svelte:head>

<input
  bind:this={fileInput}
  type="file"
  multiple
  {accept}
  class="sr-only"
  tabindex="-1"
  onchange={(e) => onFiles((e.currentTarget as HTMLInputElement).files)}
/>

{#if phase === 'loading'}
  <div class="center-screen"><div class="spinner"></div></div>
{:else if phase === 'pin'}
  <div class="center-screen">
    <form class="stack narrow rise" style="--gap: 20px" onsubmit={submitPin}>
      <p class="eyebrow">Private event</p>
      <h1 class="title">Enter the event PIN</h1>
      <input
        class="input pin"
        bind:value={pinInput}
        inputmode="numeric"
        autocomplete="off"
        maxlength="8"
        placeholder="••••"
        aria-label="PIN"
      />
      {#if pinWrong}<p class="error-text">That PIN isn’t right.</p>{/if}
      <div><button class="btn" type="submit" disabled={pinInput.length < 4}>Continue</button></div>
    </form>
  </div>
{:else if phase === 'error'}
  <div class="center-screen">
    <div class="stack narrow" style="--gap: 16px">
      <h1 class="title">{(errors[errorCode] ?? ['Something went wrong'])[0]}</h1>
      <p class="lede" style="margin-inline: auto">{(errors[errorCode] ?? ['', 'Please reload the page in a moment.'])[1]}</p>
    </div>
  </div>
{:else if event}
  <div class="page wall">
    <header class="top row">
      <span class="brand">Snap<em>Wall</em></span>
      <span class="spacer"></span>
      {#if event.settings.guestView && items.length}
        <a class="btn ghost sm" href={href(`e/${token}/show`)}><Icon name="slideshow" size={16} /> Slideshow</a>
      {/if}
    </header>

    <section class="hero rise">
      {#if event.date}<p class="eyebrow">{formatDate(event.date)}</p>{/if}
      <h1 class="display">{event.name}</h1>
      {#if event.settings.guestView}
        <p class="muted">{event.count ? plural(event.count, 'moment') + ' shared' : 'Be the first to share a moment.'}</p>
      {/if}
    </section>

    {#if !event.settings.uploadsOpen}
      <p class="notice muted small">Uploads are closed. {event.settings.guestView ? 'You can still browse the wall.' : ''}</p>
    {/if}

    {#if event.settings.guestView}
      {#if items.length}
        <MediaGrid {items} onopen={(i) => (open = i)} {selecting} {selected} ontoggle={toggle} />
        <div bind:this={sentinel} class="sentinel">{#if loadingMore}<div class="spinner"></div>{/if}</div>
      {:else}
        <div class="empty">
          <p class="title italic muted">The wall is empty.</p>
        </div>
      {/if}
    {:else}
      <div class="card upload-only stack" style="--gap: 12px">
        <h2 class="h2">Share your photos with the host</h2>
        <p class="muted" style="margin: 0">
          This is a private collection. Your photos and videos go straight to the host — other guests can’t see them.
        </p>
        {#if sentHere}<p class="small" style="margin: 0"><strong>{plural(sentHere, 'file')}</strong> sent from this device. Thank you!</p>{/if}
      </div>
    {/if}

    {#if event.settings.moderation && sentHere}
      <p class="muted small notice" style="margin-top: 24px">Your uploads will appear once the host approves them.</p>
    {/if}

    <footer class="foot small muted">
      Photos are saved to the host’s own Google Drive. <a href="#/privacy">Privacy</a>
    </footer>
  </div>

  <!-- Upload progress -->
  {#if jobs.length && sheetOpen}
    <aside class="sheet rise" aria-label="Uploads">
      <div class="sheet-head row">
        <strong>{busyCount ? `Uploading ${doneCount + 1 > jobs.length ? jobs.length : doneCount + 1} of ${jobs.length}` : 'Uploads finished'}</strong>
        <span class="spacer"></span>
        {#if !busyCount}<button class="link" onclick={clearFinished}>Clear</button>{/if}
        <button class="link" onclick={() => (sheetOpen = false)}>Hide</button>
      </div>
      <div class="bar"><span style="width: {overall * 100}%"></span></div>
      <ul class="jobs">
        {#each jobs as job (job.key)}
          <li class="job">
            <span class="jname">{job.file.name}</span>
            {#if job.status === 'done'}
              <span class="ok"><Icon name="check" size={16} stroke={2.2} /></span>
            {:else if job.status === 'error'}
              <span class="error-text small">{job.error}</span>
              {#if job.error === 'Upload failed' || job.error?.includes('connection')}<button class="link" onclick={() => retry(job)}>Retry</button>{/if}
            {:else}
              <span class="muted small">{Math.round(job.progress * 100)}%</span>
            {/if}
          </li>
        {/each}
      </ul>
    </aside>
  {/if}

  <!-- Action bar -->
  <nav class="dock" aria-label="Actions">
    {#if selecting}
      <button class="btn ghost" onclick={() => ((selecting = false), (selected = new Set()))}>Cancel</button>
      <button class="btn" disabled={!selected.size || zipping} onclick={downloadSelected}>
        {#if zipping}<span class="spinner" style="width:16px;height:16px"></span> Preparing…{:else}<Icon name="download" size={18} /> Download {selected.size || ''}{/if}
      </button>
    {:else}
      {#if jobs.length && !sheetOpen}
        <button class="btn ghost" onclick={() => (sheetOpen = true)}>{busyCount ? `${Math.round(overall * 100)}%` : 'Uploads'}</button>
      {/if}
      {#if event.settings.uploadsOpen}
        <button class="btn accent lg" onclick={pick}><Icon name="plus" size={20} /> Add photos</button>
      {/if}
      {#if event.settings.guestDownload && items.length}
        <button class="btn ghost" onclick={() => (selecting = true)}>Select</button>
      {/if}
    {/if}
  </nav>

  <Lightbox {items} bind:index={open} />

  <Modal bind:open={askName} title={event.settings.requireName ? 'Your name' : 'Add your name?'}>
    <p class="muted" style="margin: 0">
      {event.settings.requireName ? 'The host asks guests to add a name to their uploads.' : 'So the host knows who shared these. You can skip this.'}
    </p>
    <form class="stack" onsubmit={(e) => (e.preventDefault(), confirmName())}>
      <input class="input" bind:value={uploader} placeholder="Your name" maxlength="40" autocomplete="name" />
      <div class="row">
        <button class="btn" type="submit" disabled={event.settings.requireName && !uploader.trim()}>Continue</button>
        {#if !event.settings.requireName}<button class="btn ghost" type="button" onclick={() => confirmName(true)}>Skip</button>{/if}
      </div>
    </form>
  </Modal>
{/if}

<style>
  .wall {
    padding-bottom: 140px;
  }
  .top {
    padding: 20px 0;
  }
  .brand {
    font-family: var(--serif);
    font-size: 20px;
    color: var(--muted);
  }
  .hero {
    padding: clamp(24px, 8vh, 80px) 0 clamp(28px, 5vh, 48px);
    display: grid;
    gap: 14px;
  }
  .hero p {
    margin: 0;
  }
  .notice {
    margin: 0 0 24px;
  }
  .empty {
    padding: 64px 0;
    text-align: center;
    border-top: 1px solid var(--line);
  }
  .upload-only {
    max-width: 560px;
  }
  .sentinel {
    display: grid;
    place-items: center;
    min-height: 60px;
  }
  .foot {
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }
  .pin {
    font-size: 28px;
    letter-spacing: 0.4em;
    text-align: center;
    max-width: 220px;
    margin-inline: auto;
  }

  .dock {
    position: fixed;
    left: 50%;
    bottom: max(20px, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    gap: 8px;
    padding: 8px;
    border-radius: 999px;
    background: var(--scrim);
    backdrop-filter: blur(16px) saturate(1.4);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    border: 1px solid var(--line);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
    z-index: 20;
    max-width: calc(100vw - 24px);
  }
  .dock:empty {
    display: none;
  }
  .dock .btn.ghost {
    background: var(--surface);
  }

  .sheet {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(max(20px, env(safe-area-inset-bottom)) + 84px);
    width: min(440px, calc(100vw - 24px));
    max-height: 46vh;
    display: grid;
    grid-template-rows: auto auto 1fr;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 18px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.16);
    z-index: 20;
    overflow: hidden;
  }
  .sheet-head {
    padding: 14px 18px 10px;
    font-size: 14px;
  }
  .bar {
    height: 2px;
    background: var(--line);
    margin: 0 18px;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .jobs {
    list-style: none;
    margin: 0;
    padding: 6px 18px 14px;
    overflow: auto;
  }
  .job {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    font-size: 14px;
    border-bottom: 1px solid var(--line);
  }
  .job:last-child {
    border-bottom: 0;
  }
  .jname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ok {
    color: var(--ok);
  }
</style>
