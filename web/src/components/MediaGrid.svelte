<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import type { MediaItem } from '../../../shared/types';
  import { PREVIEW_RETRY_MS, isVideo, retryUrl } from '../lib/format';
  import Icon from './Icon.svelte';

  let {
    items,
    onopen,
    selecting = false,
    selected = new Set<string>(),
    ontoggle,
    actions,
    names = false,
  }: {
    items: MediaItem[];
    onopen: (index: number) => void;
    selecting?: boolean;
    selected?: Set<string>;
    ontoggle?: (id: string) => void;
    actions?: Snippet<[MediaItem]>;
    /** Show each upload's guest name on its tile. */
    names?: boolean;
  } = $props();

  let failed = $state<Record<string, boolean>>({});
  /** Tries so far for previews that didn't load, which is normal for a minute or so after an upload. */
  let tries = $state<Record<string, number>>({});
  /** Bumped when a retry is due; changing the address makes the browser ask again. */
  let waits = $state<Record<string, number>>({});
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onDestroy(() => timers.forEach(clearTimeout));

  function retry(id: string) {
    const n = tries[id] ?? 0;
    if (n >= PREVIEW_RETRY_MS.length) {
      failed[id] = true;
      return;
    }
    tries[id] = n + 1;
    const t = setTimeout(() => {
      timers.delete(t);
      waits[id] = (waits[id] ?? 0) + 1;
    }, PREVIEW_RETRY_MS[n]);
    timers.add(t);
  }
  const loaded = (id: string) => {
    delete tries[id];
    delete waits[id];
  };
</script>

<ul class="grid">
  {#each items as item, i (item.id)}
    <li class="tile" class:hidden={item.hidden} class:picked={selected.has(item.id)}>
      <button
        class="hit"
        onclick={() => (selecting ? ontoggle?.(item.id) : onopen(i))}
        aria-label={selecting ? `Select ${item.name}` : `Open ${item.name}`}
      >
        {#if failed[item.id]}
          <span class="placeholder">
            <Icon name={isVideo(item.mime) ? 'play' : 'image'} size={28} />
            <span class="small">{isVideo(item.mime) ? 'Video processing' : 'Preview unavailable'}</span>
          </span>
        {:else}
          {#if tries[item.id]}
            <span class="placeholder">
              <span class="spinner" style="width: 22px; height: 22px"></span>
              <span class="small">Preparing preview…</span>
            </span>
          {/if}
          <img
            class:retrying={!!tries[item.id]}
            src={retryUrl(item.thumb, waits[item.id])}
            alt=""
            loading="lazy"
            decoding="async"
            onload={() => loaded(item.id)}
            onerror={() => retry(item.id)}
          />
        {/if}
        {#if isVideo(item.mime) && !failed[item.id]}
          <span class="badge"><Icon name="play" size={14} /></span>
        {/if}
        {#if names && item.uploader}
          <span class="who">{item.uploader}</span>
        {/if}
        {#if selecting}
          <span class="check" aria-hidden="true">{#if selected.has(item.id)}<Icon name="check" size={16} stroke={2.4} />{/if}</span>
        {/if}
      </button>
      {#if actions}
        <div class="actions">{@render actions(item)}</div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    columns: 2;
    column-gap: 6px;
  }
  @media (min-width: 640px) {
    .grid {
      columns: 3;
      column-gap: 10px;
    }
  }
  @media (min-width: 1000px) {
    .grid {
      columns: 4;
    }
  }
  .tile {
    break-inside: avoid;
    margin-bottom: 6px;
    position: relative;
    border-radius: 6px;
    overflow: hidden;
    background: var(--shade);
    animation: rise 0.4s ease both;
  }
  @media (min-width: 640px) {
    .tile {
      margin-bottom: 10px;
      border-radius: 8px;
    }
  }
  .hit {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
    position: relative;
  }
  img {
    width: 100%;
    height: auto;
    min-height: 80px;
    transition:
      transform 0.5s ease,
      opacity 0.2s ease;
  }
  /* Kept in the page so the browser keeps asking, but out of sight behind the placeholder until it loads. */
  img.retrying {
    position: absolute;
    inset: 0;
    min-height: 0;
    opacity: 0;
  }
  .hit:hover img {
    transform: scale(1.02);
  }
  .hidden .hit {
    opacity: 0.35;
  }
  .placeholder {
    aspect-ratio: 4 / 5;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .badge {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    backdrop-filter: blur(4px);
  }
  .who {
    position: absolute;
    inset: auto 0 0 0;
    padding: 22px 44px 7px 9px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
    color: #fff;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  @media (min-width: 640px) {
    .who {
      font-size: 13px;
      padding: 28px 46px 9px 11px;
    }
  }
  .check {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: rgba(0, 0, 0, 0.25);
    display: grid;
    place-items: center;
    color: #fff;
  }
  .picked .check {
    background: var(--accent);
    border-color: var(--accent);
  }
  .picked img {
    transform: scale(0.94);
    border-radius: 6px;
  }
  .actions {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
  }
</style>
