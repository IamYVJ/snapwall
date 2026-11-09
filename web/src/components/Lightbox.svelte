<script lang="ts">
  import type { MediaItem } from '../../../shared/types';
  import { onDestroy } from 'svelte';
  import { PREVIEW_RETRY_MS, isVideo, retryUrl, timeAgo } from '../lib/format';
  import Icon from './Icon.svelte';

  let {
    items,
    index = $bindable<number | null>(null),
    ondelete,
  }: { items: MediaItem[]; index?: number | null; ondelete?: (item: MediaItem) => void } = $props();

  const item = $derived(index === null ? null : items[index]);
  // Checked as each photo opens; the server has the final say if the time runs out while it's open.
  const canDelete = $derived(!!ondelete && !!item?.deletableUntil && item.deletableUntil > Date.now() / 1000);
  let touchX = 0;

  /**
   * A photo opened right after its upload may not be ready yet (iPhone photos wait for Drive's copy browsers can
   * show), so it is asked for again for a while. Only the photo on screen is tracked.
   */
  let retry = $state<{ id: string; n: number; gaveUp: boolean } | null>(null);
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(retryTimer));

  function fullFailed(id: string) {
    const n = retry?.id === id ? retry.n : 0;
    clearTimeout(retryTimer);
    if (n >= PREVIEW_RETRY_MS.length) {
      retry = { id, n, gaveUp: true };
      return;
    }
    retry = { id, n, gaveUp: false };
    retryTimer = setTimeout(() => {
      if (retry?.id === id) retry = { id, n: n + 1, gaveUp: false };
    }, PREVIEW_RETRY_MS[n]);
  }
  const mine = $derived(item && retry?.id === item.id ? retry : null);

  const close = () => (index = null);
  const step = (d: number) => {
    if (index === null || !items.length) return;
    index = (index + d + items.length) % items.length;
  };

  function onkey(e: KeyboardEvent) {
    if (index === null) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  }

  $effect(() => {
    document.body.style.overflow = item ? 'hidden' : '';
    return () => (document.body.style.overflow = '');
  });
</script>

<svelte:window onkeydown={onkey} />

{#if item}
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={item.name}
    tabindex="-1"
    ontouchstart={(e) => (touchX = e.touches[0].clientX)}
    ontouchend={(e) => {
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    }}
  >
    <header>
      <span class="meta small">
        {#if item.uploader}<strong>{item.uploader}</strong>{' · '}{/if}{timeAgo(item.createdAt)}
      </span>
      <span class="spacer"></span>
      {#if canDelete}
        <button class="icon-btn" onclick={() => ondelete!(item)} aria-label="Delete your upload"><Icon name="trash" /></button>
      {/if}
      {#if item.download}
        <a class="icon-btn" href={item.download} download={item.name} aria-label="Download"><Icon name="download" /></a>
      {/if}
      <button class="icon-btn" onclick={close} aria-label="Close"><Icon name="close" /></button>
    </header>

    <div class="stage">
      {#key item.id}
        {#if isVideo(item.mime)}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={item.full} poster={item.thumb} controls playsinline autoplay></video>
        {:else}
          {#if mine}
            <p class="wait">
              {#if mine.gaveUp}This photo can’t be shown yet. Try again in a few minutes.{:else}<span class="spinner"></span> Preparing photo…{/if}
            </p>
          {/if}
          <img
            class:retrying={!!mine}
            src={retryUrl(item.full, mine?.n)}
            alt={item.name}
            onload={() => {
              if (retry?.id === item.id) retry = null;
            }}
            onerror={() => fullFailed(item.id)}
          />
        {/if}
      {/key}
    </div>

    {#if items.length > 1}
      <button class="nav prev" onclick={() => step(-1)} aria-label="Previous"><Icon name="left" size={26} /></button>
      <button class="nav next" onclick={() => step(1)} aria-label="Next"><Icon name="right" size={26} /></button>
    {/if}
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(8, 8, 8, 0.97);
    color: #f2f0ec;
    display: grid;
    grid-template-rows: auto 1fr;
    animation: fade 0.2s ease both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: max(12px, env(safe-area-inset-top)) 16px 12px;
  }
  .meta {
    color: #bdb9b2;
  }
  .meta strong {
    color: #f2f0ec;
    font-weight: 500;
  }
  .icon-btn {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 0;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    cursor: pointer;
  }
  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.16);
  }
  .stage {
    position: relative;
    min-height: 0;
  }
  /* Pinned to the stage's edges and centred by margin: auto, so max-height has a fixed height to go by. In a grid
     cell it had none, and tall photos ran off the screen. */
  .stage img,
  .stage video {
    position: absolute;
    inset: 0 0 max(16px, env(safe-area-inset-bottom));
    margin: auto;
    max-width: 100%;
    max-height: calc(100% - max(16px, env(safe-area-inset-bottom)));
    object-fit: contain;
    animation: fade 0.25s ease both;
  }
  .stage img.retrying {
    opacity: 0;
  }
  .wait {
    position: absolute;
    inset: 0;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    color: #bdb9b2;
  }
  .wait .spinner {
    width: 20px;
    height: 20px;
  }
  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: 0;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    display: none;
    place-items: center;
    cursor: pointer;
  }
  .prev {
    left: 16px;
  }
  .next {
    right: 16px;
  }
  @media (hover: hover) {
    .nav {
      display: grid;
    }
  }
</style>
