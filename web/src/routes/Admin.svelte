<script lang="ts">
  import QRCode from 'qrcode';
  import { onDestroy, onMount } from 'svelte';
  import type { AdminEvent, EventSettings, GuestCount, MediaFilter, MediaItem } from '../../../shared/types';
  import GuestFilter from '../components/GuestFilter.svelte';
  import Icon from '../components/Icon.svelte';
  import Lightbox from '../components/Lightbox.svelte';
  import MediaGrid from '../components/MediaGrid.svelte';
  import Modal from '../components/Modal.svelte';
  import Poster from '../components/Poster.svelte';
  import QR from '../components/QR.svelte';
  import StorageWarning from '../components/StorageWarning.svelte';
  import Toggle from '../components/Toggle.svelte';
  import Wordmark from '../components/Wordmark.svelte';
  import { ApiError, adminApi, session, signInUrl, type EventPatch } from '../lib/api';
  import { AUTO_CLOSE_DAYS, autoCloseAt, closeLabel, copyText, formatDate, isVideo, plural, saveBlob, shiftClose, sizeLabel } from '../lib/format';
  import { go, href, pageUrl } from '../lib/router.svelte';
  import { streamsToDisk, zipMedia, type ZipProgress, type ZipResult } from '../lib/zip';

  let { eventId, adminToken }: { eventId: string; adminToken: string | null } = $props();

  const api = adminApi(eventId, adminToken);

  let phase = $state<'loading' | 'ready' | 'error'>('loading');
  let errorCode = $state('');
  let event = $state<AdminEvent | null>(null);
  let items = $state<MediaItem[]>([]);
  let next = $state<string | null>(null);
  let filter = $state<MediaFilter>('all');
  let guests = $state<GuestCount[]>([]);
  let by = $state<string | null>(null);
  let open = $state<number | null>(null);
  let saving = $state(false);
  let toast = $state('');
  let newAdminLink = $state<string | null>(null);

  let confirmDelete = $state(false);
  let deleteName = $state('');
  let trashFolder = $state(false);
  let deleting = $state(false);
  let confirmRotate = $state<'guest' | 'admin'>('guest');
  let rotateOpen = $state(false);
  let pinModal = $state(false);
  let pinInput = $state('');
  let posterOpen = $state(false);
  let editOpen = $state(false);
  let editName = $state('');
  let editDate = $state('');
  let approving = $state(false);

  let zipOpen = $state(false);
  let zipVideos = $state(true);
  let zipHidden = $state(false);
  let zipFolders = $state(false);
  let zipPhase = $state<'idle' | 'listing' | 'zipping' | 'done' | 'error'>('idle');
  let zipProgress = $state<ZipProgress | null>(null);
  let zipResult = $state<ZipResult | null>(null);
  let zipAbort: AbortController | null = null;

  let poll: ReturnType<typeof setInterval> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const guestUrl = $derived(event ? pageUrl(`e/${event.guestToken}`) : '');
  const adminUrl = $derived(adminToken ? pageUrl(`a/${eventId}/${adminToken}`) : newAdminLink);
  const expiresLocal = $derived(event?.settings.expiresAt ? toLocalInput(event.settings.expiresAt) : '');
  // Checked when the event loads or changes; the 15-second refresh keeps it close enough.
  const expired = $derived(!!event?.settings.expiresAt && event.settings.expiresAt <= Date.now() / 1000);
  // Where the close time ends up if the date in the edit form is saved.
  const editClose = $derived(event ? shiftClose(event.settings.expiresAt, event.date, editDate || null) : null);

  function toLocalInput(sec: number): string {
    const d = new Date(sec * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function flash(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2400);
  }

  function fail(err: unknown) {
    flash(err instanceof ApiError ? err.message : 'Something went wrong');
  }

  async function load() {
    if (!adminToken && !session.get()) {
      location.href = signInUrl();
      return;
    }
    try {
      event = await api.get();
      const [page, g] = await Promise.all([api.media(null, filter), api.guests().catch(() => [])]);
      guests = g;
      items = page.items;
      next = page.next;
      phase = 'ready';
      poll = setInterval(refreshMedia, 15_000);
    } catch (err) {
      errorCode = err instanceof ApiError ? err.code : 'error';
      phase = 'error';
    }
  }

  async function refreshMedia() {
    if (document.hidden) return;
    try {
      const want = { filter, by };
      const [ev, page, g] = await Promise.all([api.get(), api.media(null, filter, by), api.guests().catch(() => guests)]);
      if (!saving) event = ev;
      guests = g;
      if (want.filter !== filter || want.by !== by) return;
      const known = new Set(items.map((i) => i.id));
      const fresh = page.items.filter((i) => !known.has(i.id));
      if (!next) {
        items = page.items;
        next = page.next;
      } else if (fresh.length) items = [...fresh, ...items];
      if (event) event.count = Math.max(event.count, items.length);
    } catch {
      /* keep the current view */
    }
  }

  async function loadMore() {
    if (!next) return;
    const page = await api.media(next, filter, by);
    items = [...items, ...page.items.filter((i) => !items.some((x) => x.id === i.id))];
    next = page.next;
  }

  async function showFilter(f: MediaFilter, reload = false, name = by) {
    if (f === filter && name === by && !reload) return;
    filter = f;
    by = name;
    items = [];
    next = null;
    try {
      const page = await api.media(null, f, name);
      if (filter !== f || by !== name) return;
      items = page.items;
      next = page.next;
    } catch (err) {
      fail(err);
    }
  }

  const matches = (i: MediaItem) =>
    (!by || i.uploader === by) && (filter === 'awaiting' ? i.awaiting : filter === 'hidden' ? i.hidden && !i.awaiting : true);

  async function refreshCounts() {
    event = await api.get().catch(() => event);
  }

  async function approve(item?: MediaItem) {
    approving = true;
    try {
      const { approved } = await api.approve(item ? [item.id] : undefined);
      if (item) {
        items = items.map((i) => (i.id === item.id ? { ...i, hidden: false, awaiting: false } : i)).filter(matches);
      } else {
        items = items.map((i) => (i.awaiting ? { ...i, hidden: false, awaiting: false } : i)).filter(matches);
        flash(`${plural(approved, 'upload')} approved`);
      }
      await refreshCounts();
      // The next page of the queue may still hold more.
      if (filter === 'awaiting' && !items.length && event?.awaiting) await showFilter('awaiting', true);
    } catch (err) {
      fail(err);
    } finally {
      approving = false;
    }
  }

  /** Every item in the event, all pages. */
  async function listAll(): Promise<MediaItem[]> {
    const all: MediaItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await api.media(cursor);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return all;
  }

  const zipPick = (all: MediaItem[]) => all.filter((i) => (zipVideos || !isVideo(i.mime)) && (zipHidden || !i.hidden));

  async function downloadAll() {
    if (!event) return;
    zipAbort = new AbortController();
    zipResult = null;
    zipProgress = null;
    zipPhase = 'listing';
    try {
      const res = await zipMedia({
        filename: `${event.name}.zip`,
        list: async () => zipPick(await listAll()),
        refresh: listAll,
        folder: zipFolders ? (i) => i.uploader ?? 'No name' : undefined,
        signal: zipAbort.signal,
        onProgress: (p) => {
          zipPhase = 'zipping';
          zipProgress = p;
        },
      });
      if (!res) zipPhase = 'idle';
      else {
        zipResult = res;
        zipPhase = 'done';
      }
    } catch (err) {
      zipPhase = zipAbort?.signal.aborted ? 'idle' : 'error';
    } finally {
      zipAbort = null;
    }
  }

  function closeZip() {
    zipAbort?.abort();
    zipOpen = false;
    zipPhase = 'idle';
  }

  const zipRunning = $derived(zipPhase === 'listing' || zipPhase === 'zipping');
  const zipPercent = $derived(zipProgress?.totalBytes ? Math.min(100, Math.round((zipProgress.bytes / zipProgress.totalBytes) * 100)) : 0);
  // Closing the dialog mid-download keeps it going; only Cancel stops it. A finished result is cleared on close.
  $effect(() => {
    if (!zipOpen && (zipPhase === 'done' || zipPhase === 'error')) zipPhase = 'idle';
  });

  const mb = (bytes: number) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes / 1e6, bytes ? 0.1 : 0).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;

  async function patch(p: EventPatch, message = 'Saved') {
    saving = true;
    try {
      event = await api.update(p);
      flash(message);
    } catch (err) {
      fail(err);
      event = await api.get().catch(() => event);
    } finally {
      saving = false;
    }
  }

  const setting = (key: keyof EventSettings) => (value: boolean) => patch({ settings: { [key]: value } });

  async function rotate(which: 'guest' | 'admin') {
    rotateOpen = false;
    try {
      const res = await api.rotate(which);
      event = res.event;
      if (which === 'admin') {
        if (adminToken) {
          go(`a/${eventId}/${res.adminToken}`, { replace: true });
          return;
        }
        newAdminLink = pageUrl(`a/${eventId}/${res.adminToken}`);
      }
      flash(which === 'guest' ? 'New guest link created — the old one no longer works' : 'New admin link created');
    } catch (err) {
      fail(err);
    }
  }

  async function copy(text: string, what: string) {
    flash((await copyText(text)) ? `${what} copied` : 'Copy failed — select and copy manually');
  }

  /** A text file with the event's links, so the host has them somewhere other than this browser. */
  function saveLinks() {
    if (!event) return;
    const lines = [`SnapWall: ${event.name}`];
    if (event.date) lines.push(formatDate(event.date));
    lines.push('', 'Guest link (share this with guests):', guestUrl);
    if (event.hasPin) lines.push('Guests also need the event PIN. Share it separately.');
    lines.push('');
    if (adminUrl) {
      lines.push('Admin link (keep this private: anyone with it can manage the event):', adminUrl);
    } else {
      lines.push(`Manage the event by signing in to SnapWall with Google as ${event.ownerEmail}:`, pageUrl(`manage/${eventId}`));
    }
    lines.push('', 'Google Drive folder:', event.folderUrl, '', `Saved ${new Date().toLocaleString()}.`, '');
    saveBlob(new Blob([lines.join('\n')], { type: 'text/plain' }), `${event.name} links.txt`.replace(/[\\/:*?"<>|]/g, '_'));
  }

  async function downloadQr() {
    if (!event) return;
    const url = await QRCode.toDataURL(guestUrl, { width: 1400, margin: 3, errorCorrectionLevel: 'M' });
    saveBlob(await (await fetch(url)).blob(), `${event.name} QR.png`.replace(/[\\/:*?"<>|]/g, '_'));
  }

  // Without the system share sheet, Share would only copy the link, the same as Copy, so it isn't shown.
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  async function share() {
    if (!event) return;
    await navigator.share({ title: event.name, text: `Add your photos to ${event.name}`, url: guestUrl }).catch(() => undefined);
  }

  async function setHidden(item: MediaItem, hidden: boolean) {
    try {
      const updated = await api.setHidden(item.id, hidden);
      items = items.map((i) => (i.id === item.id ? updated : i)).filter(matches);
      await refreshCounts();
    } catch (err) {
      fail(err);
    }
  }

  async function removeItem(item: MediaItem) {
    if (!confirm(`Move “${item.name}” to your Drive trash and remove it from the wall?`)) return;
    try {
      await api.removeMedia(item.id);
      items = items.filter((i) => i.id !== item.id);
      await refreshCounts();
    } catch (err) {
      fail(err);
    }
  }

  async function savePin(e: SubmitEvent) {
    e.preventDefault();
    await patch({ pin: pinInput.trim() }, 'PIN set');
    pinModal = false;
    pinInput = '';
  }

  function openEdit() {
    editName = event!.name;
    editDate = event!.date ?? '';
    editOpen = true;
  }

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    const date = editDate || null;
    const p: EventPatch = { name: editName.trim(), date };
    if (editClose !== event!.settings.expiresAt) p.settings = { expiresAt: editClose };
    await patch(p);
    editOpen = false;
  }

  async function deleteEvent() {
    deleting = true;
    try {
      await api.remove(trashFolder);
      clearInterval(poll);
      go(session.get() ? '' : 'privacy', { replace: true });
    } catch (err) {
      deleting = false;
      fail(err);
    }
  }

  onMount(load);
  onDestroy(() => {
    zipAbort?.abort();
    clearInterval(poll);
    clearTimeout(toastTimer);
  });
</script>

<svelte:head><title>{event ? `${event.awaiting ? `(${event.awaiting}) ` : ''}Manage ${event.name} · SnapWall` : 'SnapWall'}</title></svelte:head>

{#if phase === 'loading'}
  <div class="center-screen"><div class="spinner"></div></div>
{:else if phase === 'error'}
  <div class="center-screen">
    <div class="stack narrow" style="--gap: 16px">
      <h1 class="title">{errorCode === 'event_not_found' ? 'Event not found' : 'Couldn’t open this event'}</h1>
      <p class="lede" style="margin-inline: auto">
        {errorCode === 'event_not_found'
          ? 'This admin link is no longer valid. It may have been replaced, or the event was deleted.'
          : errorCode === 'drive_disconnected'
            ? 'Google Drive access has expired. Sign in again to reconnect.'
            : 'Please try again in a moment.'}
      </p>
      <div class="row" style="justify-content: center">
        {#if errorCode === 'drive_disconnected' || errorCode === 'signin_required'}<a class="btn" href={signInUrl()}>Sign in</a>{/if}
        <a class="btn ghost" href="#/">Home</a>
      </div>
    </div>
  </div>
{:else if event}
  <div class="page admin">
    <header class="top row">
      <Wordmark href={session.get() ? '#/' : '#/privacy'} />
      <span class="spacer"></span>
      <span class="muted small">{event.ownerEmail}</span>
    </header>

    <StorageWarning load={api.storage} />

    {#if adminToken}
      <div class="card save-link rise stack" style="--gap: 10px">
        <p class="eyebrow">Your admin link</p>
        <p class="small muted" style="margin: 0">
          Anyone with this link can manage the event. Bookmark it or keep it somewhere safe. {event.ownerEmail} can always get back in by signing in with Google.
        </p>
        <div class="linkbox row">
          <code>{adminUrl}</code>
          <button class="btn sm ghost" onclick={() => copy(adminUrl!, 'Admin link')}><Icon name="copy" size={16} /> Copy</button>
          <button class="btn sm ghost" onclick={saveLinks}><Icon name="download" size={16} /> Save to file</button>
        </div>
      </div>
    {/if}

    <section class="hero rise">
      <div class="row" style="gap: 10px">
        <span class="pill" class:live={event.status === 'active'} class:off={event.status !== 'active'}>
          <span class="dot"></span>{event.status !== 'active'
            ? 'Disabled'
            : !event.settings.uploadsOpen
              ? 'Uploads paused'
              : expired
                ? 'Uploads closed'
                : 'Live'}
        </span>
        {#if event.date}<span class="eyebrow">{formatDate(event.date)}</span>{/if}
        <button class="link small" onclick={openEdit}>{event.date ? 'Edit name or date' : 'Edit name or add a date'}</button>
      </div>
      <h1 class="display">{event.name}</h1>
      <p class="muted">
        {plural(event.count, 'item')}{event.awaiting ? ` · ${event.awaiting} awaiting approval` : ''}{event.hidden ? ` · ${event.hidden} hidden` : ''}
      </p>
    </section>

    <div class="layout">
      <!-- Share -->
      <section class="card share stack" style="--gap: 18px">
        <p class="eyebrow">Invite guests</p>
        <QR value={guestUrl} label="QR code for the guest link" />
        <div class="linkbox row">
          <code>{guestUrl}</code>
        </div>
        <div class="row">
          {#if canShare}<button class="btn" onclick={share}>Share link</button>{/if}
          <button class="btn" class:ghost={canShare} onclick={() => copy(guestUrl, 'Guest link')}><Icon name="copy" size={16} /> Copy link</button>
          <button class="btn ghost" onclick={downloadQr}><Icon name="download" size={16} /> QR</button>
          <button class="btn ghost" onclick={() => (posterOpen = true)}>Poster</button>
        </div>
        <hr class="rule" />
        <div class="row small">
          <a class="link" href={href(`e/${event.guestToken}`)} target="_blank" rel="noreferrer">Open wall</a>
          <a class="link" href={href(`e/${event.guestToken}/show`)} target="_blank" rel="noreferrer">Slideshow</a>
          <a class="link" href={event.folderUrl} target="_blank" rel="noreferrer">Drive folder <Icon name="external" size={12} /></a>
          <button class="link" onclick={saveLinks}>Save links to a file</button>
        </div>
      </section>

      <!-- Controls -->
      <section class="card stack controls" style="--gap: 6px">
        <p class="eyebrow">Controls</p>
        <div>
          <Toggle label="Accept uploads" checked={event.settings.uploadsOpen} onchange={setting('uploadsOpen')} disabled={saving} />
          <Toggle
            label="Close uploads automatically"
            hint={event.settings.expiresAt === null
              ? `${AUTO_CLOSE_DAYS} days after the event date, or a week from now if it has none.`
              : `${expired ? 'Closed' : 'Closes'} ${closeLabel(event.settings.expiresAt)}. Change the time below.`}
            checked={event.settings.expiresAt !== null}
            onchange={(on) => patch({ settings: { expiresAt: on ? autoCloseAt(event!.date) : null } })}
            disabled={saving}
          />
          <Toggle
            label="Guests can see the wall"
            hint="Off makes it upload-only."
            checked={event.settings.guestView}
            onchange={setting('guestView')}
            disabled={saving}
          />
          <Toggle
            label="Guests can download"
            checked={event.settings.guestDownload}
            onchange={setting('guestDownload')}
            disabled={saving || !event.settings.guestView}
          />
          <Toggle label="Allow videos" checked={event.settings.allowVideo} onchange={setting('allowVideo')} disabled={saving} />
          <Toggle
            label="Approve uploads first"
            hint="New uploads stay hidden until you show them."
            checked={event.settings.moderation}
            onchange={setting('moderation')}
            disabled={saving}
          />
          <Toggle label="Require guest names" checked={event.settings.requireName} onchange={setting('requireName')} disabled={saving} />
          <Toggle
            label="Guests can delete their uploads"
            hint="For an hour after sending, from the same phone. Deleted files go to your Drive trash."
            checked={event.settings.guestDelete}
            onchange={setting('guestDelete')}
            disabled={saving}
          />
          <Toggle
            label="Remove location"
            hint="Removes GPS location from photos and videos on the guest’s device before upload. Photos also lose camera details."
            checked={event.settings.stripLocation}
            onchange={setting('stripLocation')}
            disabled={saving}
          />
          <Toggle
            label="Find me"
            hint="Guests can find the photos they’re in with a selfie. Faces are matched on the guest’s own phone; nothing is sent or saved."
            checked={event.settings.faceSearch}
            onchange={setting('faceSearch')}
            disabled={saving || !event.settings.guestView}
          />
        </div>

        <div class="grid2">
          <label class="field">
            <span>Max file size</span>
            <select
              class="input"
              value={String(event.settings.maxFileMB)}
              onchange={(e) => patch({ settings: { maxFileMB: Number((e.currentTarget as HTMLSelectElement).value) } })}
            >
              {#each [25, 100, 250, 500, 1000, 2000, 5000] as mb}
                <option value={String(mb)}>{mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`}</option>
              {/each}
              {#if ![25, 100, 250, 500, 1000, 2000, 5000].includes(event.settings.maxFileMB)}
                <option value={String(event.settings.maxFileMB)}>{event.settings.maxFileMB} MB</option>
              {/if}
            </select>
          </label>
          <label class="field">
            <span>Files per guest</span>
            <select
              class="input"
              value={String(event.settings.guestMaxFiles ?? '')}
              onchange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                patch({ settings: { guestMaxFiles: v ? Number(v) : null } });
              }}
            >
              <option value="">No limit</option>
              {#each [10, 25, 50, 100, 250, 500] as n}
                <option value={String(n)}>{n}</option>
              {/each}
              {#if event.settings.guestMaxFiles !== null && ![10, 25, 50, 100, 250, 500].includes(event.settings.guestMaxFiles)}
                <option value={String(event.settings.guestMaxFiles)}>{event.settings.guestMaxFiles}</option>
              {/if}
            </select>
          </label>
          <label class="field">
            <span>Storage per guest</span>
            <select
              class="input"
              value={String(event.settings.guestMaxMB ?? '')}
              onchange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                patch({ settings: { guestMaxMB: v ? Number(v) : null } });
              }}
            >
              <option value="">No limit</option>
              {#each [250, 500, 1000, 2000, 5000, 10000] as n}
                <option value={String(n)}>{sizeLabel(n)}</option>
              {/each}
              {#if event.settings.guestMaxMB !== null && ![250, 500, 1000, 2000, 5000, 10000].includes(event.settings.guestMaxMB)}
                <option value={String(event.settings.guestMaxMB)}>{sizeLabel(event.settings.guestMaxMB)}</option>
              {/if}
            </select>
          </label>
          {#if event.settings.expiresAt !== null}
            <label class="field">
              <span>Close uploads at</span>
              <input
                class="input"
                type="datetime-local"
                value={expiresLocal}
                onchange={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  patch({ settings: { expiresAt: v ? Math.floor(new Date(v).getTime() / 1000) : null } });
                }}
              />
            </label>
          {/if}
        </div>

        <div class="row pinrow">
          <div style="display: grid; gap: 2px; flex: 1">
            <strong class="small">Event PIN</strong>
            <span class="muted small">{event.hasPin ? 'Guests need a PIN as well as the link.' : 'Optional extra step for guests.'}</span>
          </div>
          {#if event.hasPin}
            <button class="btn ghost sm" onclick={() => patch({ pin: null }, 'PIN removed')}>Remove</button>
          {/if}
          <button class="btn ghost sm" onclick={() => (pinModal = true)}>{event.hasPin ? 'Change' : 'Set PIN'}</button>
        </div>
      </section>
    </div>

    <!-- Media -->
    <section class="media">
      <div class="row media-head">
        <h2 class="h2">Wall</h2>
        <span class="spacer"></span>
        {#if event.count}
          <button class="btn ghost sm" onclick={() => (zipOpen = true)}>
            <Icon name="download" size={16} />
            {zipRunning ? `Downloading ${zipPercent}%` : 'Download all'}
          </button>
        {/if}
      </div>
      <div class="row media-tabs">
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={filter === 'all'} class:on={filter === 'all'} onclick={() => showFilter('all')}>All</button>
          {#if event.settings.moderation || event.awaiting}
            <button role="tab" aria-selected={filter === 'awaiting'} class:on={filter === 'awaiting'} onclick={() => showFilter('awaiting')}>
              To approve{event.awaiting ? ` (${event.awaiting})` : ''}
            </button>
          {/if}
          <button role="tab" aria-selected={filter === 'hidden'} class:on={filter === 'hidden'} onclick={() => showFilter('hidden')}>
            Hidden{event.hidden ? ` (${event.hidden})` : ''}
          </button>
        </div>
        <span class="spacer"></span>
        {#if filter === 'awaiting' && event.awaiting > 1}
          <button class="btn sm" disabled={approving} onclick={() => approve()}><Icon name="check" size={16} /> Approve all {event.awaiting}</button>
        {/if}
      </div>
      <GuestFilter {guests} value={by} onchange={(name) => showFilter(filter, false, name)} />
      {#if items.length}
        <MediaGrid {items} onopen={(i) => (open = i)} names>
          {#snippet actions(item)}
            {#if item.awaiting}
              <button class="mini approve" disabled={approving} onclick={() => approve(item)} aria-label="Approve" title="Approve and show on the wall">
                <Icon name="check" size={16} stroke={2.2} />
              </button>
              <button class="mini" onclick={() => setHidden(item, true)} aria-label="Reject" title="Reject and keep hidden">
                <Icon name="close" size={16} />
              </button>
            {:else}
              <button
                class="mini"
                onclick={() => setHidden(item, !item.hidden)}
                aria-label={item.hidden ? 'Show on wall' : 'Hide from wall'}
                title={item.hidden ? 'Show on wall' : 'Hide from wall'}
              >
                <Icon name={item.hidden ? 'eye' : 'eyeOff'} size={16} />
              </button>
            {/if}
            <button class="mini" onclick={() => removeItem(item)} aria-label="Delete" title="Move to Drive trash">
              <Icon name="trash" size={16} />
            </button>
          {/snippet}
        </MediaGrid>
        {#if next}
          <div class="row" style="justify-content: center; padding: 24px 0"><button class="btn ghost" onclick={loadMore}>Load more</button></div>
        {/if}
      {:else}
        <p class="muted empty">
          {filter === 'hidden' ? 'Nothing hidden.' : filter === 'awaiting' ? 'Nothing waiting for approval.' : 'No uploads yet. Share the QR code to get started.'}
        </p>
      {/if}
    </section>

    <!-- Access & danger -->
    <section class="danger card stack" style="--gap: 0">
      <p class="eyebrow" style="margin-bottom: 8px">Access</p>
      <div class="drow">
        <div><strong>Replace guest link</strong><p class="muted small">The current link and QR code stop working immediately.</p></div>
        <button class="btn ghost sm" onclick={() => ((confirmRotate = 'guest'), (rotateOpen = true))}>Replace</button>
      </div>
      <div class="drow">
        <div>
          <strong>{adminToken ? 'Replace admin link' : 'Create admin link'}</strong>
          <p class="muted small">
            {adminToken ? 'Use this if the admin link was shared by mistake.' : 'Share management with a co-host. Any previous admin link stops working.'}
          </p>
        </div>
        <button class="btn ghost sm" onclick={() => ((confirmRotate = 'admin'), (rotateOpen = true))}>{adminToken ? 'Replace' : 'Create'}</button>
      </div>
      {#if newAdminLink}
        <div class="linkbox row" style="margin: 0 0 16px">
          <code>{newAdminLink}</code>
          <button class="btn sm ghost" onclick={() => copy(newAdminLink!, 'Admin link')}><Icon name="copy" size={16} /> Copy</button>
          <button class="btn sm ghost" onclick={saveLinks}><Icon name="download" size={16} /> Save to file</button>
        </div>
      {/if}
      <div class="drow">
        <div>
          <strong>{event.status === 'active' ? 'Disable event' : 'Enable event'}</strong>
          <p class="muted small">
            {event.status === 'active' ? 'Guests see “event closed”. Nothing is deleted.' : 'The guest link works again.'}
          </p>
        </div>
        <button
          class="btn sm"
          class:danger={event.status === 'active'}
          onclick={() => patch({ status: event!.status === 'active' ? 'disabled' : 'active' }, event!.status === 'active' ? 'Event disabled' : 'Event enabled')}
        >
          {event.status === 'active' ? 'Disable' : 'Enable'}
        </button>
      </div>
      <div class="drow">
        <div><strong>Delete event</strong><p class="muted small">Removes the event from SnapWall. You choose what happens to the Drive folder.</p></div>
        <button class="btn danger sm" onclick={() => (confirmDelete = true)}>Delete</button>
      </div>
    </section>
  </div>

  <Lightbox {items} bind:index={open} />

  <Modal bind:open={zipOpen} title="Download all">
    {#if zipPhase === 'idle'}
      <p class="muted" style="margin: 0">Saves every photo{zipVideos ? ' and video' : ''} as one ZIP file, straight from your Drive.</p>
      <div>
        <Toggle label="Include videos" hint="Videos can make the ZIP very large." bind:checked={zipVideos} />
        {#if event.hidden || event.awaiting}
          <Toggle label="Include hidden uploads" hint="Also those still waiting for approval." bind:checked={zipHidden} />
        {/if}
        <Toggle label="A folder for each guest" hint="Uploads without a name go in “No name”." bind:checked={zipFolders} />
      </div>
      {#if !streamsToDisk}
        <p class="muted small" style="margin: 0">
          This browser builds the ZIP in memory before saving. For large events, use Chrome or Edge on a computer, or download the Drive folder.
        </p>
      {/if}
      <div class="row">
        <button class="btn" onclick={downloadAll}><Icon name="download" size={16} /> Download</button>
        <button class="btn ghost" onclick={closeZip}>Cancel</button>
      </div>
    {:else if zipRunning}
      <p style="margin: 0">
        {#if zipPhase === 'listing' || !zipProgress}
          Getting the file list…
        {:else}
          {Math.min(zipProgress.done + 1, zipProgress.total)} of {plural(zipProgress.total, 'file')} · {mb(zipProgress.bytes)} of {mb(zipProgress.totalBytes)}
        {/if}
      </p>
      <div class="zipbar"><span style="width: {zipPercent}%"></span></div>
      <p class="muted small" style="margin: 0">Keep this tab open until it finishes.</p>
      <div><button class="btn ghost" onclick={closeZip}>Cancel</button></div>
    {:else if zipPhase === 'done' && zipResult}
      <p style="margin: 0">
        {zipResult.saved ? `Saved ${plural(zipResult.saved, 'file')}.` : 'Nothing to download.'}
        {#if zipResult.failed}<span class="error-text">{plural(zipResult.failed, 'file')} couldn’t be downloaded.</span>{/if}
      </p>
      <div><button class="btn" onclick={closeZip}>Done</button></div>
    {:else}
      <p class="error-text" style="margin: 0">The download stopped. Check your connection and try again.</p>
      <div class="row">
        <button class="btn" onclick={downloadAll}>Try again</button>
        <button class="btn ghost" onclick={closeZip}>Close</button>
      </div>
    {/if}
  </Modal>

  <Modal bind:open={confirmDelete} title="Delete this event?">
    <p class="muted" style="margin: 0">All guest and admin links stop working and SnapWall forgets this event. Type the event name to confirm.</p>
    <input class="input" bind:value={deleteName} placeholder={event.name} aria-label="Event name" />
    <Toggle label="Also move the Drive folder to trash" hint="Every photo and video in it. You can restore it from Drive’s trash for 30 days." bind:checked={trashFolder} />
    <div class="row">
      <button class="btn danger solid" disabled={deleteName.trim() !== event.name || deleting} onclick={deleteEvent}>
        {deleting ? 'Deleting…' : 'Delete event'}
      </button>
      <button class="btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
    </div>
  </Modal>

  <Modal bind:open={rotateOpen} title={confirmRotate === 'guest' ? 'Replace the guest link?' : 'New admin link?'}>
    <p class="muted" style="margin: 0">
      {confirmRotate === 'guest'
        ? 'Printed QR codes and shared links will stop working. You’ll need to share the new one.'
        : 'Any existing admin link stops working.'}
    </p>
    <div class="row">
      <button class="btn" onclick={() => rotate(confirmRotate)}>Continue</button>
      <button class="btn ghost" onclick={() => (rotateOpen = false)}>Cancel</button>
    </div>
  </Modal>

  <Poster bind:open={posterOpen} name={event.name} date={event.date} url={guestUrl} />

  <Modal bind:open={editOpen} title="Edit event">
    <form class="stack" onsubmit={saveEdit}>
      <label class="field">
        <span>Event name</span>
        <input class="input" bind:value={editName} maxlength="80" required />
      </label>
      <label class="field">
        <span>Date (optional)</span>
        <input class="input" type="date" bind:value={editDate} />
      </label>
      {#if editClose !== null && editClose !== event.settings.expiresAt}
        <p class="muted small" style="margin: 0">
          Uploads will {editClose <= Date.now() / 1000 ? 'close straight away (the new time has passed)' : `now close ${closeLabel(editClose)}`}.
        </p>
      {/if}
      <div class="row">
        <button class="btn" type="submit" disabled={saving || !editName.trim()}>Save</button>
        <button class="btn ghost" type="button" onclick={() => (editOpen = false)}>Cancel</button>
      </div>
    </form>
  </Modal>

  <Modal bind:open={pinModal} title="Event PIN">
    <form class="stack" onsubmit={savePin}>
      <p class="muted" style="margin: 0">4–8 digits. Guests enter it once per visit. Share it separately from the link.</p>
      <input class="input" bind:value={pinInput} inputmode="numeric" pattern="\d{'{'}4,8{'}'}" maxlength="8" placeholder="1234" />
      <div class="row">
        <button class="btn" type="submit" disabled={!/^\d{4,8}$/.test(pinInput)}>Save PIN</button>
        <button class="btn ghost" type="button" onclick={() => (pinModal = false)}>Cancel</button>
      </div>
    </form>
  </Modal>

  {#if toast}<div class="toast rise" role="status">{toast}</div>{/if}
{/if}

<style>
  .admin {
    padding-bottom: 80px;
  }
  .top {
    padding: 24px 0;
  }
  .save-link {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  }
  .hero {
    padding: 40px 0 36px;
    display: grid;
    gap: 14px;
  }
  .hero p {
    margin: 0;
  }
  .hero .display {
    font-size: clamp(40px, 7vw, 88px);
  }
  .layout {
    display: grid;
    gap: 16px;
  }
  .layout > :global(*) {
    min-width: 0;
  }
  @media (min-width: 900px) {
    .layout {
      grid-template-columns: 360px 1fr;
      align-items: start;
    }
  }
  .share :global(.qr) {
    max-width: 280px;
  }
  .linkbox {
    flex-wrap: nowrap;
    background: var(--shade);
    border-radius: 10px;
    padding: 6px 6px 6px 12px;
  }
  .linkbox code {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .grid2 {
    display: grid;
    gap: 12px;
    padding: 12px 0;
  }
  @media (min-width: 560px) {
    .grid2 {
      grid-template-columns: 1fr 1fr;
    }
  }
  .pinrow {
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .media {
    padding: 56px 0 24px;
  }
  .media-head {
    margin-bottom: 14px;
  }
  .media-tabs {
    margin-bottom: 20px;
  }
  .zipbar {
    height: 4px;
    border-radius: 2px;
    background: var(--shade);
    overflow: hidden;
  }
  .zipbar span {
    display: block;
    height: 100%;
    background: var(--fg);
    transition: width 0.2s;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px;
  }
  .seg button {
    border: 0;
    background: none;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 14px;
    color: var(--muted);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--fg);
    color: var(--bg);
  }
  .mini {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    cursor: pointer;
    backdrop-filter: blur(6px);
  }
  .mini:hover {
    background: rgba(0, 0, 0, 0.8);
  }
  .mini.approve {
    background: var(--accent);
  }
  .empty {
    padding: 40px 0;
    border-top: 1px solid var(--line);
  }
  .danger {
    margin-top: 40px;
  }
  .drow {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 16px 0;
    border-top: 1px solid var(--line);
  }
  .drow > div {
    flex: 1;
  }
  .drow p {
    margin: 2px 0 0;
  }
  .drow strong {
    font-weight: 500;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: max(24px, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: var(--fg);
    color: var(--bg);
    padding: 12px 20px;
    border-radius: 999px;
    font-size: 14px;
    z-index: 60;
    max-width: calc(100vw - 32px);
    text-align: center;
  }
</style>
