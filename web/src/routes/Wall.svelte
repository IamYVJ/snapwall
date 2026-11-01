<script lang="ts">
  import { flushSync, onDestroy, onMount } from 'svelte';
  import type { GuestCount, MediaItem, PublicEvent } from '../../../shared/types';
  import { IMAGE_TYPES, VIDEO_TYPES } from '../../../shared/types';
  import AppButton from '../components/AppButton.svelte';
  import FindMe from '../components/FindMe.svelte';
  import GuestFilter from '../components/GuestFilter.svelte';
  import Icon from '../components/Icon.svelte';
  import Lightbox from '../components/Lightbox.svelte';
  import MediaGrid from '../components/MediaGrid.svelte';
  import Modal from '../components/Modal.svelte';
  import { ApiError, guestApi } from '../lib/api';
  import { formatDate, plural, saveBlob, sizeLabel } from '../lib/format';
  import { saved } from '../lib/saved.svelte';
  import { install } from '../lib/install.svelte';
  import { href } from '../lib/router.svelte';
  import { hold } from '../lib/activity';
  import { canRetry, mimeOf, retriesItself, uploadFile, type UploadState } from '../lib/upload';
  import { collectMedia, zipFiles, zipMedia, type ZipProgress } from '../lib/zip';

  let { token }: { token: string } = $props();

  interface Job {
    key: number;
    file: File;
    /** reconnecting: lost the connection, and tries again when it's back or the guest returns to the page. */
    status: 'waiting' | 'uploading' | 'reconnecting' | 'done' | 'error';
    progress: number;
    /** Drive is busy and the upload will try again by itself. */
    paused?: boolean;
    error?: string;
    canRetry?: boolean;
    /** Times it went back to reconnecting, so a file that never gets through ends up with a Retry button. */
    reconnects: number;
    /** The upload once it's on the wall, so the guest can still delete it for a while. */
    item?: MediaItem;
    deleted?: boolean;
    /** An exact copy of a file already in the event, so the server skipped it. */
    duplicate?: boolean;
    /** The same file was picked again on this page, so it isn't sent twice. */
    repeat?: boolean;
  }

  /** Files sent at once. More helps lots of small photos; the phone's upload speed is shared between them anyway. */
  const PARALLEL = 3;
  const MAX_RECONNECTS = 5;
  const RECONNECT_MS = 15_000;
  const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

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
  let guests = $state<GuestCount[]>([]);
  let by = $state<string | null>(null);
  let findOpen = $state(false);
  /** Photos Find me matched, shown instead of the whole wall until the guest goes back. */
  let matches = $state<MediaItem[] | null>(null);
  let findMe = $state<FindMe>();
  let findProgress = $state<{ done: number; total: number } | null>(null);
  const shown = $derived(matches ?? items);

  let jobs = $state<Job[]>([]);
  let sheetOpen = $state(false);
  let sentHere = $state(0);
  let jobKey = 0;
  let active = 0;
  /** Each unfinished upload's progress, kept out of the reactive jobs so a retry can carry on from it. */
  const progressOf = new Map<number, UploadState>();
  let showDone = $state(false);

  let uploader = $state(safeGet(() => localStorage, nameKey) ?? '');
  let askName = $state(false);
  let pendingFiles: File[] = [];
  let fileInput: HTMLInputElement;

  let selecting = $state(false);
  let selected = $state(new Set<string>());
  let zipping = $state(false);
  /** How much of the chosen photos has downloaded into the ZIP, 0 to 1. */
  let zipped = $state(0);
  let zipStop: AbortController | null = null;
  /**
   * On iPhone the chosen photos download as they are and wait here for a second tap, which opens the share sheet: it
   * needs a fresh tap, and its Save Images puts them in Photos, where a ZIP would only reach Files.
   */
  let ready = $state<{ files: File[]; of: Set<string> } | null>(null);
  const toPhotos = install.ios && !!navigator.canShare?.({ files: [new File([''], 'photo.jpg', { type: 'image/jpeg' })] });

  let poll: ReturnType<typeof setInterval> | undefined;

  // Lists the event on this device's home page, and in the app if it's installed.
  $effect(() => {
    if (event) saved.add({ id: event.id, name: event.name, date: event.date, path: `e/${token}`, role: 'guest' });
  });
  let sentinel = $state<HTMLElement>();

  // Per-guest limits: what the server counted at load, plus everything queued or sent from this page since.
  const limits = $derived.by(() => {
    if (!event?.usage) return null;
    const mine = jobs.filter((j) => j.status !== 'error' && !j.duplicate && !j.repeat);
    return {
      files: event.settings.guestMaxFiles === null ? null : event.settings.guestMaxFiles - event.usage.files - mine.length,
      bytes:
        event.settings.guestMaxMB === null
          ? null
          : event.settings.guestMaxMB * 1024 * 1024 - event.usage.bytes - mine.reduce((s, j) => s + j.file.size, 0),
    };
  });
  const atLimit = $derived(!!limits && ((limits.files !== null && limits.files <= 0) || (limits.bytes !== null && limits.bytes <= 0)));

  const accept = $derived(event?.settings.allowVideo ? 'image/*,video/*' : 'image/*');
  const busy = (j: Job) => j.status === 'waiting' || j.status === 'uploading' || j.status === 'reconnecting';
  const busyCount = $derived(jobs.filter(busy).length);
  const failedCount = $derived(jobs.filter((j) => j.status === 'error').length);
  const retryable = $derived(jobs.filter((j) => j.status === 'error' && j.canRetry));
  const doneCount = $derived(jobs.length - busyCount - failedCount);
  // Weighted by size, so one long video doesn't count the same as a photo. Files that won't be sent are left out.
  const counted = $derived(jobs.filter((j) => j.status !== 'error' && !j.repeat));
  const totalBytes = $derived(counted.reduce((s, j) => s + j.file.size, 0));
  const sentBytes = $derived(counted.reduce((s, j) => s + j.file.size * (j.status === 'done' ? 1 : j.progress), 0));
  const overall = $derived(totalBytes ? sentBytes / totalBytes : 0);
  // Find me puts its matches on the wall, so the upload list makes way for them. The dock button brings it back.
  $effect(() => {
    if (findOpen) sheetOpen = false;
  });
  // While a long list is going, finished files fold away so the ones still sending stay in view.
  const listed = $derived(busyCount && !showDone ? jobs.filter((j) => j.status !== 'done') : jobs);

  // Keeps the screen on and asks before leaving while anything is sending.
  const uploading = $derived(busyCount > 0);
  $effect(() => {
    if (uploading) return hold();
  });

  async function load() {
    try {
      event = await api.event();
      phase = 'ready';
      if (event.settings.guestView) {
        const [page, g] = await Promise.all([api.media(), api.guests().catch(() => [])]);
        items = page.items;
        next = page.next;
        guests = g;
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
      const want = by;
      const [page, g] = await Promise.all([api.media(null, want), api.guests().catch(() => guests)]);
      guests = g;
      if (by !== want) return;
      const known = new Set(items.map((i) => i.id));
      const fresh = page.items.filter((i) => !known.has(i.id));
      // A wall on one page is taken whole, so photos the host hid go too. A longer one keeps what has been scrolled
      // to or selected, and new photos join the top.
      if (!page.next || !items.length) {
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

  let more: Promise<void> | null = null;

  /** The next page of the wall. Asked again while one is on its way, it waits for that one. */
  function loadMore(): Promise<void> {
    if (!next) return Promise.resolve();
    more ??= (async () => {
      loadingMore = true;
      try {
        const want = by;
        const page = await api.media(next, want);
        if (by !== want) return;
        items = [...items, ...page.items.filter((i) => !items.some((x) => x.id === i.id))];
        next = page.next;
      } finally {
        loadingMore = false;
        more = null;
      }
    })();
    return more;
  }

  async function showGuest(name: string | null) {
    by = name;
    items = [];
    next = null;
    selected = new Set();
    try {
      const page = await api.media(null, name);
      if (by !== name) return;
      items = page.items;
      next = page.next;
    } catch {
      /* the next refresh tries again */
    }
  }

  /** Every item on the wall, page by page, for Find me. */
  async function allMedia(): Promise<MediaItem[]> {
    const all: MediaItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await api.media(cursor);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return all;
  }

  function showMatches(found: MediaItem[] | null, more = false) {
    if (more && found) {
      // More turned up while the search carries on: keep the photo the guest has open in front of them.
      const id = open === null ? null : shown[open]?.id;
      matches = found;
      if (id) open = found.findIndex((i) => i.id === id);
      return;
    }
    if (!found) findMe?.stop();
    matches = found;
    open = null;
    selected = new Set();
    if (found) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submitPin(e: SubmitEvent) {
    e.preventDefault();
    pin = pinInput.trim();
    safeSet(() => sessionStorage, pinKey, pin);
    phase = 'loading';
    await load();
  }

  const needsName = () =>
    !!event && ((event.settings.requireName && !uploader.trim()) || (!uploader && !safeGet(() => localStorage, `${nameKey}.asked`)));

  // The name is asked before the picker opens: an iPhone can take a while to get a big pick ready, and a question
  // after that wait feels like one more hold-up.
  function pick() {
    if (needsName()) {
      askName = true;
      return;
    }
    fileInput.value = '';
    fileInput.click();
  }

  function onFiles(files: FileList | null) {
    if (!files?.length || !event) return;
    pendingFiles = [...files];
    if (needsName()) askName = true;
    else enqueue();
  }

  function confirmName(skip = false) {
    if (!skip && event?.settings.requireName && !uploader.trim()) return;
    if (skip) uploader = '';
    safeSet(() => localStorage, nameKey, uploader.trim());
    safeSet(() => localStorage, `${nameKey}.asked`, '1');
    // Closes the dialog now, since the page behind it can't open the picker while it's showing. Tapping Continue
    // counts as the tap the picker needs.
    flushSync(() => (askName = false));
    if (pendingFiles.length) enqueue();
    else pick();
  }

  function enqueue() {
    if (!event) return;
    const s = event.settings;
    const allowed = s.allowVideo ? [...IMAGE_TYPES, ...VIDEO_TYPES] : IMAGE_TYPES;
    for (const file of pendingFiles) {
      const mime = mimeOf(file);
      const job: Job = { key: ++jobKey, file, status: 'waiting', progress: 0, reconnects: 0 };
      const left = limits;
      const before = jobs.find((j) => !j.deleted && sameFile(j.file, file));
      if (before?.status === 'error' && before.canRetry) {
        retry(before);
        continue;
      }
      if (before && before.status !== 'error') {
        job.status = 'done';
        job.repeat = true;
      } else if (left?.files !== null && left?.files !== undefined && left.files <= 0) {
        job.status = 'error';
        job.error = `Over the limit of ${s.guestMaxFiles} files`;
      } else if (left?.bytes !== null && left?.bytes !== undefined && file.size > left.bytes) {
        job.status = 'error';
        job.error = `Over your ${sizeLabel(s.guestMaxMB!)} limit`;
      } else if (!allowed.includes(mime)) {
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
    while (active < PARALLEL) {
      const job = jobs.find((j) => j.status === 'waiting');
      if (!job) return;
      active++;
      run(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  /** Sends the uploads that lost their connection again, once there is one and the guest is on the page. */
  function reconnect() {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    for (const j of jobs) if (j.status === 'reconnecting') j.status = 'waiting';
    pump();
  }

  async function run(job: Job) {
    if (!event) return;
    job.status = 'uploading';
    const state = progressOf.get(job.key) ?? {};
    progressOf.set(job.key, state);
    try {
      const item = await uploadFile(
        api,
        job.file,
        { uploader: uploader.trim() || null, stripLocation: event.settings.stripLocation, onWait: (w) => (job.paused = w) },
        (p) => (job.progress = p),
        state,
      );
      progressOf.delete(job.key);
      job.status = 'done';
      job.progress = 1;
      job.item = item;
      sentHere++;
      if (event.settings.guestView && !item.hidden) {
        if (!by || by === item.uploader) items = [item, ...items];
        event.count++;
      }
    } catch (err) {
      job.paused = false;
      if (retriesItself(err) && job.reconnects < MAX_RECONNECTS) {
        job.reconnects++;
        job.status = 'reconnecting';
        setTimeout(reconnect, RECONNECT_MS);
        return;
      }
      progressOf.delete(job.key);
      if (err instanceof ApiError && err.code === 'duplicate') {
        job.status = 'done';
        job.progress = 1;
        job.duplicate = true;
        return;
      }
      job.status = 'error';
      job.error =
        err instanceof ApiError && err.code === 'drive_disconnected'
          ? 'Not sent: the host needs to reconnect their Drive'
          : err instanceof ApiError
            ? err.message
            : 'Upload failed';
      job.canRetry = canRetry(err);
      // Nothing else can be saved either, so don't make every queued file fail one by one.
      if (err instanceof ApiError && err.code === 'storage_full') {
        for (const j of jobs) {
          if (j.status !== 'waiting' && j.status !== 'reconnecting') continue;
          j.status = 'error';
          j.error = 'Not sent: the host’s Drive is full';
          j.canRetry = true;
        }
      }
    }
  }

  const canDelete = (item?: MediaItem) => !!item?.deletableUntil && item.deletableUntil > Date.now() / 1000;

  /** Deletes one of the guest's own uploads, from the upload list or the photo viewer. */
  async function removeMine(item: MediaItem) {
    if (!confirm(`Delete “${item.name}”? It will be removed from the wall and the host’s Drive.`)) return;
    try {
      await api.deleteUpload(item.id);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Couldn’t delete it. Please try again.');
      return;
    }
    const wasShown = items.some((i) => i.id === item.id);
    if (open !== null) {
      const id = shown[open]?.id;
      open = null;
      if (id !== item.id) open = shown.filter((i) => i.id !== item.id).findIndex((i) => i.id === id);
    }
    items = items.filter((i) => i.id !== item.id);
    if (matches) matches = matches.filter((i) => i.id !== item.id);
    if (event && wasShown) event.count = Math.max(0, event.count - 1);
    for (const j of jobs) if (j.item?.id === item.id) j.deleted = true;
  }

  function retry(job: Job) {
    job.status = 'waiting';
    job.error = undefined;
    job.canRetry = false;
    job.reconnects = 0;
    pump();
  }

  function retryAll() {
    for (const j of retryable) retry(j);
  }

  function clearFinished() {
    jobs = jobs.filter(busy);
    showDone = false;
    if (!jobs.length) sheetOpen = false;
  }

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected = s;
  }

  /** Select all is offered for one guest's photos or Find me's: a set worth taking whole, unlike the entire wall. */
  const narrowed = $derived(!!matches || !!by);
  const allSelected = $derived(!next && shown.some((i) => i.download) && shown.every((i) => !i.download || selected.has(i.id)));
  let gathering = $state(false);

  async function selectAll() {
    if (allSelected) {
      selected = new Set();
      return;
    }
    const want = by;
    gathering = true;
    try {
      // A guest's photos come a page at a time, so the rest load first.
      while (!matches && next && by === want) await loadMore();
    } catch {
      /* selects what has loaded */
    } finally {
      gathering = false;
    }
    if (by === want) selected = new Set(shown.filter((i) => i.download).map((i) => i.id));
  }

  async function downloadSelected() {
    const chosen = shown.filter((i) => selected.has(i.id) && i.download);
    if (!chosen.length) return;
    if (chosen.length === 1 && !toPhotos) {
      location.href = chosen[0].download!;
      return;
    }
    zipping = true;
    zipped = 0;
    zipStop = new AbortController();
    const of = selected;
    const onProgress = (p: ZipProgress) => (zipped = p.totalBytes ? p.bytes / p.totalBytes : 0);
    try {
      if (toPhotos) {
        const { files } = await collectMedia({ items: chosen, signal: zipStop.signal, onProgress });
        if (files.length && selected === of) ready = { files, of };
      } else if (await zipMedia({ filename: zipName(), list: async () => chosen, signal: zipStop.signal, onProgress })) {
        doneSelecting();
      }
    } catch (err) {
      if (!zipStop.signal.aborted) throw err;
    } finally {
      zipping = false;
      zipStop = null;
    }
  }

  const zipName = () => `${event?.name ?? 'snapwall'}.zip`;

  /** Ready only counts for the photos it was made from; choosing others asks for a new download. */
  const saving = $derived(ready?.of === selected ? ready : null);
  $effect(() => {
    if (ready && ready.of !== selected) ready = null;
  });

  async function saveToPhotos() {
    if (!saving) return;
    const { files } = saving;
    if (navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files });
        return doneSelecting();
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // the sheet was closed; the button stays for another go
      }
    }
    // Too many or too big for the share sheet: one ZIP instead, which goes to Files.
    saveBlob(await zipFiles(files), zipName());
    doneSelecting();
  }

  function doneSelecting() {
    selecting = false;
    selected = new Set();
  }

  function cancelSelecting() {
    zipStop?.abort();
    doneSelecting();
  }

  // The photos are gathered on the phone, so locking it or leaving the page would lose them.
  $effect(() => {
    if (zipping || saving) return hold();
  });

  $effect(() => {
    if (!sentinel || matches) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '800px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  onMount(() => {
    load();
    addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
  });
  onDestroy(() => {
    clearInterval(poll);
    removeEventListener('online', reconnect);
    document.removeEventListener('visibilitychange', reconnect);
  });

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
      <AppButton />
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
      {#if event.settings.faceSearch && items.length && !matches}
        <div><button class="btn ghost sm" onclick={() => (findOpen = true)}><Icon name="face" size={16} /> Find photos of me</button></div>
      {/if}
    </section>

    {#if !event.settings.uploadsOpen}
      <!-- Without the wall, the card below says it. -->
      {#if event.settings.guestView}<p class="notice muted small">Uploads are closed. You can still browse the wall.</p>{/if}
    {:else if limits}
      <p class="notice muted small">
        {#if atLimit}
          You’ve reached this event’s upload limit. Thank you for sharing!
        {:else}
          Each guest can add
          {[
            event.settings.guestMaxFiles !== null ? plural(event.settings.guestMaxFiles, 'file') : '',
            event.settings.guestMaxMB !== null ? sizeLabel(event.settings.guestMaxMB) : '',
          ]
            .filter(Boolean)
            .join(' or ')}{event.settings.guestMaxFiles !== null && event.settings.guestMaxMB !== null ? ', whichever comes first' : ''}.
          {[
            limits.files !== null ? `${limits.files.toLocaleString()} ${limits.files === 1 ? 'file' : 'files'}` : '',
            limits.bytes !== null ? sizeLabel(limits.bytes / 1024 / 1024) : '',
          ]
            .filter(Boolean)
            .join(' / ')} left.
        {/if}
      </p>
    {/if}
    {#if install.ios && event.settings.uploadsOpen && !atLimit && !jobs.length}
      <!-- iOS gets every picked photo and video ready (downloading originals from iCloud, shrinking videos) before the page sees any. -->
      <p class="notice muted small">On iPhone, add 20–30 at a time so they start sooner. You can keep adding while they upload.</p>
    {/if}

    {#if event.settings.guestView}
      {#if matches}
        <div class="found row small">
          {#if findProgress}
            <span aria-live="polite">
              <strong>You’re in {plural(matches.length, 'photo')} so far.</strong>
              <span class="muted">Still looking: {findProgress.done.toLocaleString()} of {findProgress.total.toLocaleString()}…</span>
            </span>
          {:else}
            <span><strong>You’re in {plural(matches.length, 'photo')}.</strong> <span class="muted">Found on this phone.</span></span>
          {/if}
          <span class="spacer"></span>
          {#if findProgress}
            <button class="link" onclick={() => findMe?.stop()}>Stop looking</button>
          {:else}
            <button class="link" onclick={() => (findOpen = true)}>Try another photo</button>
          {/if}
          <button class="link" onclick={() => showMatches(null)}>Show everyone</button>
          {#if findProgress}
            <div class="bar"><span style="width: {findProgress.total ? (findProgress.done / findProgress.total) * 100 : 0}%"></span></div>
          {/if}
        </div>
      {:else}
        <GuestFilter {guests} value={by} onchange={showGuest} />
      {/if}
      {#if shown.length}
        <MediaGrid items={shown} onopen={(i) => (open = i)} {selecting} {selected} ontoggle={toggle} names />
        {#if !matches}<div bind:this={sentinel} class="sentinel">{#if loadingMore}<div class="spinner"></div>{/if}</div>{/if}
      {:else}
        <div class="empty">
          <p class="title italic muted">The wall is empty.</p>
        </div>
      {/if}
    {:else}
      <div class="card upload-only stack" style="--gap: 12px">
        {#if event.settings.uploadsOpen}
          <h2 class="h2">Share your photos with the host</h2>
          <p class="muted" style="margin: 0">
            This is a private collection. Your photos and videos go straight to the host — other guests can’t see them.
          </p>
        {:else}
          <h2 class="h2">Uploads are closed</h2>
          <p class="muted" style="margin: 0">The host is no longer collecting photos for this event. Everything shared went to the host.</p>
        {/if}
        {#if sentHere}<p class="small" style="margin: 0"><strong>{plural(sentHere, 'file')}</strong> sent from this device. Thank you!</p>{/if}
      </div>
    {/if}

    {#if event.settings.moderation && sentHere}
      <p class="muted small notice" style="margin-top: 24px">Your uploads will appear once the host approves them.</p>
    {/if}

    <footer class="foot small muted">
      Photos are saved to the host’s own Google Drive.
      {event.settings.stripLocation ? 'Location is removed from your photos and videos before they’re sent.' : 'Location data in your files is kept.'}
      <a href="#/privacy">Privacy</a>
    </footer>
  </div>

  <!-- Upload progress -->
  {#if jobs.length && sheetOpen}
    <aside class="sheet rise" aria-label="Uploads">
      <div class="sheet-head row">
        <strong>
          {busyCount
            ? `Uploading ${Math.min(jobs.length - busyCount + 1, jobs.length)} of ${jobs.length}`
            : failedCount
              ? `${failedCount} of ${jobs.length} not sent`
              : 'Uploads finished'}
        </strong>
        <span class="spacer"></span>
        {#if retryable.length > 1}<button class="link" onclick={retryAll}>Retry all</button>{/if}
        {#if !busyCount}<button class="link" onclick={clearFinished}>Clear</button>{/if}
        <button class="link" onclick={() => (sheetOpen = false)}>Hide</button>
      </div>
      <div class="bar"><span style="width: {overall * 100}%"></span></div>
      {#if busyCount}
        <p class="hint small muted">
          {sizeLabel(Math.ceil((totalBytes - sentBytes) / 1024 / 1024))} to go. Keep SnapWall open until it’s done. If you leave, uploads pause and
          carry on when you’re back.{install.ios ? ' You can add more while these upload.' : ''}
        </p>
      {/if}
      <ul class="jobs">
        {#if busyCount && doneCount}
          <li class="job">
            <button class="link small" onclick={() => (showDone = !showDone)}>{showDone ? 'Hide' : 'Show'} {doneCount} done</button>
          </li>
        {/if}
        {#each listed as job (job.key)}
          <li class="job">
            <span class="jname">{job.file.name}</span>
            {#if job.deleted}
              <span class="muted small">Deleted</span>
            {:else if job.repeat}
              <span class="muted small">Already added</span>
            {:else if job.duplicate}
              <span class="muted small">Already uploaded</span>
            {:else if job.status === 'done'}
              {#if canDelete(job.item)}<button class="link small" onclick={() => removeMine(job.item!)}>Delete</button>{/if}
              <span class="ok"><Icon name="check" size={16} stroke={2.2} /></span>
            {:else if job.status === 'error'}
              <span class="error-text small">{job.error}</span>
              {#if job.canRetry}<button class="link" onclick={() => retry(job)}>Retry</button>{/if}
            {:else if job.status === 'reconnecting'}
              <span class="muted small">Reconnecting…</span>
            {:else if job.paused}
              <span class="muted small">Drive is busy, retrying…</span>
            {:else if job.status === 'waiting'}
              <span class="muted small">{job.progress ? `${Math.round(job.progress * 100)}%` : 'Waiting'}</span>
            {:else}
              <span class="muted small">{Math.round(job.progress * 100)}%</span>
            {/if}
          </li>
        {/each}
      </ul>
    </aside>
  {/if}

  <!-- Action bar -->
  <nav class="dock" class:tight={selecting && narrowed} aria-label="Actions">
    {#if selecting}
      <button class="btn ghost" class:round={narrowed} aria-label="Cancel" onclick={cancelSelecting}>
        {#if narrowed}<Icon name="close" size={18} />{:else}Cancel{/if}
      </button>
      {#if narrowed && !saving}
        <button class="btn ghost" disabled={gathering || zipping} onclick={selectAll}>
          {#if gathering}<span class="spinner" style="width:16px;height:16px"></span>{/if}
          {allSelected ? 'Clear' : 'Select all'}
        </button>
      {/if}
      {#if saving}
        <button class="btn accent" onclick={saveToPhotos}><Icon name="download" size={18} /> Save {saving.files.length} to Photos</button>
      {:else}
        <button class="btn" class:filling={zipping} style:--p="{zipped * 100}%" disabled={!selected.size || zipping} onclick={downloadSelected}>
          {#if zipping}<span aria-live="polite">Preparing {zipped ? `${Math.floor(zipped * 100)}%` : '…'}</span>{:else}<Icon name="download" size={18} /> Download {selected.size || ''}{/if}
        </button>
      {/if}
    {:else}
      {#if jobs.length && !sheetOpen}
        <button class="btn ghost" onclick={() => (sheetOpen = true)}>{busyCount ? `${Math.round(overall * 100)}%` : 'Uploads'}</button>
      {/if}
      {#if event.settings.uploadsOpen}
        <button class="btn accent lg" onclick={pick} disabled={atLimit}><Icon name="plus" size={20} /> Add photos</button>
      {/if}
      {#if event.settings.guestDownload && shown.length}
        <button class="btn ghost" onclick={() => (selecting = true)}>Select</button>
      {/if}
    {/if}
  </nav>

  <Lightbox items={shown} bind:index={open} ondelete={event.settings.guestDelete ? removeMine : undefined} />

  {#if event.settings.faceSearch}
    <FindMe bind:this={findMe} bind:open={findOpen} bind:progress={findProgress} list={allMedia} onmatches={showMatches} />
  {/if}

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
  .found {
    flex-wrap: wrap;
    gap: 6px 16px;
    padding: 12px 16px;
    margin-bottom: 14px;
    border-radius: 14px;
    background: var(--shade);
  }
  .found .bar {
    flex-basis: 100%;
    height: 3px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .found .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
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
  /* Three buttons while selecting, still on one line on a phone. */
  .dock.tight .btn {
    padding: 0 12px;
  }
  /* The Download button fills up as the photos for the ZIP arrive. */
  .dock .btn.filling {
    opacity: 1;
    cursor: progress;
    border-color: var(--accent);
    background: linear-gradient(to right, var(--accent) var(--p), var(--fg) var(--p));
    font-variant-numeric: tabular-nums;
    min-width: 136px;
  }
  .dock .btn.round {
    width: 44px;
    padding: 0;
    flex-shrink: 0;
  }

  .sheet {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(max(20px, env(safe-area-inset-bottom)) + 84px);
    width: min(440px, calc(100vw - 24px));
    max-height: 46vh;
    display: flex;
    flex-direction: column;
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
  .hint {
    margin: 0;
    padding: 8px 18px 0;
  }
  .jobs {
    list-style: none;
    margin: 0;
    padding: 6px 18px 14px;
    flex: 1;
    min-height: 0;
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
