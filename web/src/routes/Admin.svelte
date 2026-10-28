<script lang="ts">
  import QRCode from 'qrcode';
  import { onDestroy, onMount } from 'svelte';
  import type { AdminEvent, EventSettings, MediaItem } from '../../../shared/types';
  import Icon from '../components/Icon.svelte';
  import Lightbox from '../components/Lightbox.svelte';
  import MediaGrid from '../components/MediaGrid.svelte';
  import Modal from '../components/Modal.svelte';
  import Poster from '../components/Poster.svelte';
  import QR from '../components/QR.svelte';
  import Toggle from '../components/Toggle.svelte';
  import Wordmark from '../components/Wordmark.svelte';
  import { ApiError, adminApi, session, signInUrl, type EventPatch } from '../lib/api';
  import { copyText, formatDate, plural, saveBlob } from '../lib/format';
  import { go, href, pageUrl } from '../lib/router.svelte';

  let { eventId, adminToken }: { eventId: string; adminToken: string | null } = $props();

  const api = adminApi(eventId, adminToken);

  let phase = $state<'loading' | 'ready' | 'error'>('loading');
  let errorCode = $state('');
  let event = $state<AdminEvent | null>(null);
  let items = $state<MediaItem[]>([]);
  let next = $state<string | null>(null);
  let filter = $state<'all' | 'hidden'>('all');
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

  let poll: ReturnType<typeof setInterval> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const guestUrl = $derived(event ? pageUrl(`e/${event.guestToken}`) : '');
  const adminUrl = $derived(adminToken ? pageUrl(`a/${eventId}/${adminToken}`) : newAdminLink);
  const visible = $derived(filter === 'hidden' ? items.filter((i) => i.hidden) : items);
  const hiddenCount = $derived(items.filter((i) => i.hidden).length);
  const expiresLocal = $derived(event?.settings.expiresAt ? toLocalInput(event.settings.expiresAt) : '');

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
      const page = await api.media();
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
      const page = await api.media();
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
    const page = await api.media(next);
    items = [...items, ...page.items];
    next = page.next;
  }

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

  async function downloadQr() {
    if (!event) return;
    const url = await QRCode.toDataURL(guestUrl, { width: 1400, margin: 3, errorCorrectionLevel: 'M' });
    saveBlob(await (await fetch(url)).blob(), `${event.name} QR.png`.replace(/[\\/:*?"<>|]/g, '_'));
  }

  async function share() {
    if (!event) return;
    if (navigator.share) {
      await navigator.share({ title: event.name, text: `Add your photos to ${event.name}`, url: guestUrl }).catch(() => undefined);
    } else {
      copy(guestUrl, 'Guest link');
    }
  }

  async function setHidden(item: MediaItem, hidden: boolean) {
    try {
      const updated = await api.setHidden(item.id, hidden);
      items = items.map((i) => (i.id === item.id ? updated : i));
    } catch (err) {
      fail(err);
    }
  }

  async function removeItem(item: MediaItem) {
    if (!confirm(`Move “${item.name}” to your Drive trash and remove it from the wall?`)) return;
    try {
      await api.removeMedia(item.id);
      items = items.filter((i) => i.id !== item.id);
      if (event) event.count--;
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
    clearInterval(poll);
    clearTimeout(toastTimer);
  });
</script>

<svelte:head><title>{event ? `Manage ${event.name} · SnapWall` : 'SnapWall'}</title></svelte:head>

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

    {#if adminToken}
      <div class="card save-link rise stack" style="--gap: 10px">
        <p class="eyebrow">Your admin link</p>
        <p class="small muted" style="margin: 0">
          Anyone with this link can manage the event. Bookmark it or keep it somewhere safe — you can always get back in by signing in with Google.
        </p>
        <div class="linkbox row">
          <code>{adminUrl}</code>
          <button class="btn sm ghost" onclick={() => copy(adminUrl!, 'Admin link')}><Icon name="copy" size={16} /> Copy</button>
        </div>
      </div>
    {/if}

    <section class="hero rise">
      <div class="row" style="gap: 10px">
        <span class="pill" class:live={event.status === 'active'} class:off={event.status !== 'active'}>
          <span class="dot"></span>{event.status === 'active' ? (event.settings.uploadsOpen ? 'Live' : 'Uploads paused') : 'Disabled'}
        </span>
        {#if event.date}<span class="eyebrow">{formatDate(event.date)}</span>{/if}
      </div>
      <h1 class="display">{event.name}</h1>
      <p class="muted">{plural(event.count, 'item')}{hiddenCount ? ` · ${hiddenCount} awaiting approval or hidden` : ''}</p>
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
          <button class="btn" onclick={share}>Share link</button>
          <button class="btn ghost" onclick={() => copy(guestUrl, 'Guest link')}><Icon name="copy" size={16} /> Copy</button>
          <button class="btn ghost" onclick={downloadQr}><Icon name="download" size={16} /> QR</button>
          <button class="btn ghost" onclick={() => (posterOpen = true)}>Poster</button>
        </div>
        <hr class="rule" />
        <div class="row small">
          <a class="link" href={href(`e/${event.guestToken}`)} target="_blank" rel="noreferrer">Open wall</a>
          <a class="link" href={href(`e/${event.guestToken}/show`)} target="_blank" rel="noreferrer">Slideshow</a>
          <a class="link" href={event.folderUrl} target="_blank" rel="noreferrer">Drive folder <Icon name="external" size={12} /></a>
        </div>
      </section>

      <!-- Controls -->
      <section class="card stack controls" style="--gap: 6px">
        <p class="eyebrow">Controls</p>
        <div>
          <Toggle label="Accept uploads" checked={event.settings.uploadsOpen} onchange={setting('uploadsOpen')} disabled={saving} />
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
            label="Remove photo location"
            hint="Strips GPS and camera data from JPEG and PNG on the guest’s device."
            checked={event.settings.stripLocation}
            onchange={setting('stripLocation')}
            disabled={saving}
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
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={filter === 'all'} class:on={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
          <button role="tab" aria-selected={filter === 'hidden'} class:on={filter === 'hidden'} onclick={() => (filter = 'hidden')}>
            Hidden{hiddenCount ? ` (${hiddenCount})` : ''}
          </button>
        </div>
      </div>
      {#if visible.length}
        <MediaGrid items={visible} onopen={(i) => (open = i)}>
          {#snippet actions(item)}
            <button
              class="mini"
              onclick={() => setHidden(item, !item.hidden)}
              aria-label={item.hidden ? 'Show on wall' : 'Hide from wall'}
              title={item.hidden ? 'Show on wall' : 'Hide from wall'}
            >
              <Icon name={item.hidden ? 'eye' : 'eyeOff'} size={16} />
            </button>
            <button class="mini" onclick={() => removeItem(item)} aria-label="Delete" title="Move to Drive trash">
              <Icon name="trash" size={16} />
            </button>
          {/snippet}
        </MediaGrid>
        {#if next && filter === 'all'}
          <div class="row" style="justify-content: center; padding: 24px 0"><button class="btn ghost" onclick={loadMore}>Load more</button></div>
        {/if}
      {:else}
        <p class="muted empty">{filter === 'hidden' ? 'Nothing hidden.' : 'No uploads yet. Share the QR code to get started.'}</p>
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

  <Lightbox items={visible} bind:index={open} />

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
    margin-bottom: 20px;
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
