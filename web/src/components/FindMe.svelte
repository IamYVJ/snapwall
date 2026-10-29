<script lang="ts">
  import type { MediaItem } from '../../../shared/types';
  import { FaceError, matching, scanFaces, type Descriptor } from '../lib/faces';
  import { facesIn, loadFaceModel, selfieFace } from '../lib/faceModel';
  import { plural } from '../lib/format';
  import Modal from './Modal.svelte';

  let {
    open = $bindable(false),
    list,
    onmatches,
  }: {
    open?: boolean;
    /** Every photo on the wall, not just the ones loaded so far. */
    list: () => Promise<MediaItem[]>;
    onmatches: (items: MediaItem[]) => void;
  } = $props();

  let phase = $state<'intro' | 'loading' | 'scanning' | 'none' | 'error'>('intro');
  let message = $state('');
  let done = $state(0);
  let total = $state(0);
  let camera: HTMLInputElement;
  let library: HTMLInputElement;
  let abort: AbortController | null = null;

  // Faces found so far, by media ID. Kept only in memory, so a second search skips photos already read.
  const faces = new Map<string, Descriptor[]>();

  async function thumbnail(item: MediaItem, signal: AbortSignal): Promise<Blob> {
    const res = await fetch(item.thumb, { signal });
    if (!res.ok) throw new Error(`thumbnail ${res.status}`);
    return res.blob();
  }

  async function search(file: File | undefined) {
    if (!file) return;
    abort = new AbortController();
    const signal = abort.signal;
    phase = 'loading';
    try {
      await loadFaceModel().catch(() => {
        throw new FaceError('model_failed');
      });
      const me = await selfieFace(file);
      const photos = (await list()).filter((i) => i.mime.startsWith('image/'));
      if (signal.aborted) return;
      phase = 'scanning';
      await scanFaces({
        items: photos,
        cache: faces,
        load: thumbnail,
        detect: facesIn,
        signal,
        onProgress: (d, t) => ((done = d), (total = t)),
      });
      const found = matching(me, photos, faces);
      if (found.length) {
        onmatches(found);
        open = false;
      } else {
        phase = 'none';
      }
    } catch (err) {
      if (signal.aborted) return;
      phase = 'error';
      message = err instanceof FaceError ? err.message : 'Something went wrong. Please try again.';
      if (err instanceof FaceError && err.code === 'no_face') message += '. Try one where your face is clear and facing the camera.';
    }
  }

  function stop() {
    abort?.abort();
    phase = 'intro';
  }

  // Closing the sheet stops a search in progress and starts the next one from the beginning.
  $effect(() => {
    if (!open) stop();
  });

  const choose = (input: HTMLInputElement) => {
    input.value = '';
    input.click();
  };
</script>

<input
  bind:this={camera}
  type="file"
  accept="image/*"
  capture="user"
  class="sr-only"
  tabindex="-1"
  onchange={(e) => search((e.currentTarget as HTMLInputElement).files?.[0])}
/>
<input
  bind:this={library}
  type="file"
  accept="image/*"
  class="sr-only"
  tabindex="-1"
  onchange={(e) => search((e.currentTarget as HTMLInputElement).files?.[0])}
/>

<Modal bind:open title="Find photos of you">
  {#if phase === 'loading' || phase === 'scanning'}
    <div class="stack" style="--gap: 10px" aria-live="polite">
      <p class="muted" style="margin: 0">
        {#if phase === 'loading'}
          Getting ready…
        {:else}
          Looking through {done.toLocaleString()} of {plural(total, 'photo')}…
        {/if}
      </p>
      <div class="bar"><span style="width: {phase === 'scanning' && total ? (done / total) * 100 : 0}%"></span></div>
    </div>
    <div><button class="btn ghost" onclick={stop}>Stop</button></div>
  {:else}
    {#if phase === 'none'}
      <p style="margin: 0">We couldn’t find you in any photos yet. Try a different photo of yourself, or check back once more are shared.</p>
    {:else if phase === 'error'}
      <p class="error-text" style="margin: 0">{message}</p>
    {:else}
      <p class="muted" style="margin: 0">Take a selfie or pick a photo of yourself, and we’ll look for you in this event’s photos.</p>
    {/if}
    <p class="muted small" style="margin: 0">
      It all happens on this phone: your photo and the faces in the event’s photos are never sent or saved. The first search downloads about 13 MB.
    </p>
    <div class="row">
      <button class="btn" onclick={() => choose(camera)}>Take a selfie</button>
      <button class="btn ghost" onclick={() => choose(library)}>Choose a photo</button>
    </div>
  {/if}
</Modal>

<style>
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .row {
    flex-wrap: wrap;
  }
</style>
