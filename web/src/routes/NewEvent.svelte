<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../components/Toggle.svelte';
  import Wordmark from '../components/Wordmark.svelte';
  import { ApiError, owner, session, signInUrl } from '../lib/api';
  import { go } from '../lib/router.svelte';

  let name = $state('');
  let date = $state('');
  let guestView = $state(true);
  let guestDownload = $state(true);
  let allowVideo = $state(true);
  let moderation = $state(false);
  let requireName = $state(false);
  let stripLocation = $state(true);
  let faceSearch = $state(false);
  let busy = $state(false);
  let error = $state('');

  onMount(() => {
    if (!session.get()) {
      try {
        sessionStorage.setItem('snapwall.next', 'new');
      } catch {
        /* storage unavailable */
      }
      location.href = signInUrl();
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    busy = true;
    error = '';
    try {
      const res = await owner.create({
        name: name.trim(),
        date: date || null,
        settings: { guestView, guestDownload: guestView && guestDownload, allowVideo, moderation, requireName, stripLocation, faceSearch: guestView && faceSearch },
      });
      go(`a/${res.event.id}/${res.adminToken}`, { replace: true });
    } catch (err) {
      busy = false;
      if (err instanceof ApiError && err.code === 'signin_required') {
        location.href = signInUrl();
        return;
      }
      error = err instanceof ApiError ? err.message : 'Could not create the event';
    }
  }
</script>

<div class="page narrow">
  <header class="top row">
    <Wordmark />
    <span class="spacer"></span>
    <a class="link" href="#/">Cancel</a>
  </header>

  <form class="stack rise" style="--gap: 36px" onsubmit={submit}>
    <div class="stack" style="--gap: 8px">
      <p class="eyebrow">New event</p>
      <h1 class="title">What are we celebrating?</h1>
    </div>

    <label class="field">
      <span>Event name</span>
      <input class="input big" bind:value={name} placeholder="Maya & Arjun’s wedding" maxlength="80" required />
    </label>

    <label class="field">
      <span>Date (optional)</span>
      <input class="input" type="date" bind:value={date} />
    </label>

    <div>
      <p class="eyebrow" style="margin-bottom: 4px">Guests can</p>
      <Toggle label="See the wall" hint="Off makes it upload-only: guests can’t see anyone’s photos." bind:checked={guestView} />
      <Toggle label="Download originals" hint="Full-quality files, one at a time or as a ZIP." bind:checked={guestDownload} disabled={!guestView} />
      <Toggle label="Upload videos" bind:checked={allowVideo} />
      <Toggle label="Must add their name" hint="Otherwise a name is optional." bind:checked={requireName} />
      <Toggle label="Wait for approval" hint="New uploads stay hidden until you approve them." bind:checked={moderation} />
    </div>

    <div>
      <p class="eyebrow" style="margin-bottom: 4px">Privacy</p>
      <Toggle
        label="Remove location"
        hint="Removes GPS location from photos and videos on the guest’s device before upload. Photos also lose camera details."
        bind:checked={stripLocation}
      />
      <Toggle
        label="Find me"
        hint="Guests can find the photos they’re in with a selfie. Faces are matched on the guest’s own phone; nothing is sent or saved."
        bind:checked={faceSearch}
        disabled={!guestView}
      />
    </div>

    <p class="muted small notice">
      We’ll create a <strong>SnapWall</strong> folder in your Google Drive with a folder for this event. You can change everything later.
    </p>

    {#if error}<p class="error-text">{error}</p>{/if}

    <div class="row">
      <button class="btn lg" type="submit" disabled={busy || !name.trim()}>
        {#if busy}<span class="spinner" style="width:16px;height:16px"></span> Creating…{:else}Create event{/if}
      </button>
    </div>
  </form>
</div>

<style>
  .top {
    padding: 24px 0 40px;
  }
  form {
    padding-bottom: 80px;
  }
</style>
