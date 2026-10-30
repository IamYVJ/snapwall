<script lang="ts">
  import type { MediaItem } from '../../../shared/types';
  import { isVideo, timeAgo } from '../lib/format';
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
        {#if item.uploader}<strong>{item.uploader}</strong> · {/if}{timeAgo(item.createdAt)}
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
          <img src={item.full} alt={item.name} />
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
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 0 0 max(16px, env(safe-area-inset-bottom));
  }
  .stage img,
  .stage video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    animation: fade 0.25s ease both;
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
