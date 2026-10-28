<script lang="ts">
  import { formatDate } from '../lib/format';
  import Icon from './Icon.svelte';
  import QR from './QR.svelte';

  let { open = $bindable(false), name, date, url }: { open?: boolean; name: string; date: string | null; url: string } = $props();

  // Photo sizes are the standard R prints (4R = 4×6 in, 5R = 5×7 in, 6R = 6×8 in), for photo labs and table frames.
  const SIZES = {
    a4: { label: 'A4', group: 'paper', page: 'A4 portrait', ratio: '210 / 297' },
    a5: { label: 'A5', group: 'paper', page: 'A5 portrait', ratio: '148 / 210' },
    letter: { label: 'Letter', group: 'paper', page: 'letter portrait', ratio: '8.5 / 11' },
    r4: { label: '4R', group: 'photo', page: '4in 6in', ratio: '4 / 6' },
    r5: { label: '5R', group: 'photo', page: '5in 7in', ratio: '5 / 7' },
    r6: { label: '6R', group: 'photo', page: '6in 8in', ratio: '6 / 8' },
  } as const;
  type Size = keyof typeof SIZES;
  const GROUPS = [
    { id: 'paper', label: 'Paper' },
    { id: 'photo', label: 'Photo print' },
  ] as const;

  let size = $state<Size>('a4');
  // Long event names step down in size so three lines plus a note still fit the shortest page.
  const nameSize = $derived(name.length > 60 ? 6.8 : name.length > 40 ? 8 : name.length > 26 ? 9.5 : 11);
  let theme = $state<'light' | 'dark'>('light');
  let headline = $state('Share your photos');
  let note = $state('');

  // @page can't be scoped, so the chosen paper size is injected only while the poster is open.
  const pageCss = $derived(`<style>@page { size: ${SIZES[size].page}; margin: 0; }</style>`);

  $effect(() => {
    document.body.classList.toggle('printing-poster', open);
    return () => document.body.classList.remove('printing-poster');
  });

  /** Moves the overlay to <body> so printing can hide everything else without blank extra pages. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

<svelte:head>
  {#if open}{@html pageCss}{/if}
</svelte:head>

{#if open}
  <div class="overlay poster-overlay" use:portal role="dialog" aria-modal="true" aria-label="Printable poster">
    <aside class="panel stack" style="--gap: 18px">
      <div class="row">
        <h2 class="h2">Poster</h2>
        <span class="spacer"></span>
        <button class="close" onclick={() => (open = false)} aria-label="Close"><Icon name="close" /></button>
      </div>

      {#each GROUPS as g (g.id)}
        <div class="field">
          <span>{g.label}</span>
          <div class="seg" role="radiogroup" aria-label="{g.label} size">
            {#each Object.entries(SIZES).filter(([, s]) => s.group === g.id) as [key, s] (key)}
              <button role="radio" aria-checked={size === key} class:on={size === key} onclick={() => (size = key as Size)}>
                {s.label}
              </button>
            {/each}
          </div>
        </div>
      {/each}

      <div class="field">
        <span>Theme</span>
        <div class="seg" role="radiogroup" aria-label="Poster theme">
          <button role="radio" aria-checked={theme === 'light'} class:on={theme === 'light'} onclick={() => (theme = 'light')}>Light</button>
          <button role="radio" aria-checked={theme === 'dark'} class:on={theme === 'dark'} onclick={() => (theme = 'dark')}>Dark</button>
        </div>
      </div>

      <label class="field">
        <span>Headline</span>
        <input class="input" bind:value={headline} maxlength="40" />
      </label>

      <label class="field">
        <span>Note (optional)</span>
        <input class="input" bind:value={note} maxlength="80" placeholder="e.g. Use the hashtag #MayaAndArjun" />
      </label>

      <button class="btn lg" onclick={() => window.print()}>Print or save as PDF</button>
      <p class="muted small" style="margin: 0">
        Turn off “Headers and footers” in the print dialog and keep scale at 100%. Choose “Save as PDF” to get a file for a print shop.
      </p>
    </aside>

    <div class="stage">
      <article class="poster" class:dark={theme === 'dark'} style="aspect-ratio: {SIZES[size].ratio}">
        <div class="inner">
          <p class="kicker">{headline || 'Share your photos'}</p>
          <h1 class="name" style="--name: {nameSize}">{name}</h1>
          {#if date}<p class="date">{formatDate(date)}</p>{/if}

          <div class="code"><QR value={url} label="Scan to add photos" /></div>

          <ol class="steps">
            <li><span>1</span>Point your phone camera at the code</li>
            <li><span>2</span>Add your photos and videos</li>
            <li><span>3</span>No app or account needed</li>
          </ol>

          {#if note}<p class="note">{note}</p>{/if}

          <p class="foot">Photos go straight to the host’s Google Drive · Snap<em>Wall</em></p>
        </div>
      </article>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: var(--bg);
    display: grid;
    grid-template-columns: 1fr;
    overflow: auto;
    animation: rise 0.25s ease both;
  }
  @media (min-width: 900px) {
    .overlay {
      grid-template-columns: 340px 1fr;
      overflow: hidden;
    }
  }
  .panel {
    padding: 24px var(--gutter);
    border-bottom: 1px solid var(--line);
  }
  @media (min-width: 900px) {
    .panel {
      border-bottom: 0;
      border-right: 1px solid var(--line);
      overflow: auto;
      padding: 28px;
    }
  }
  .close {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: none;
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px;
    width: max-content;
  }
  .seg button {
    border: 0;
    background: none;
    padding: 6px 16px;
    border-radius: 999px;
    font-size: 14px;
    color: var(--muted);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--fg);
    color: var(--bg);
  }
  .stage {
    display: grid;
    place-items: center;
    padding: 24px var(--gutter) 48px;
    background: var(--shade);
    min-height: 0;
    overflow: auto;
  }

  /* The poster has its own light/dark theme, independent of the site's. Everything is sized in --u,
     which follows the width but shrinks on squatter pages (Letter, 6R), so one layout fits every size. */
  .poster {
    --p-bg: #ffffff;
    --p-ink: #141414;
    --p-muted: #6d6a65;
    --p-faint: #8a867f;
    --p-accent: #b4532a;
    container-type: size;
    width: min(100%, 520px, calc((100dvh - 96px) * 0.7));
    background: var(--p-bg);
    color: var(--p-ink);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
    overflow: hidden;
  }
  .inner {
    --u: min(1cqw, 0.66cqh);
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: calc(9 * var(--u)) calc(9 * var(--u)) calc(6 * var(--u));
  }
  .kicker {
    margin: 0;
    font-family: var(--sans);
    font-size: calc(3.2 * var(--u));
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--p-accent);
  }
  .name {
    margin: calc(3 * var(--u)) 0 0;
    font-family: var(--serif);
    font-weight: 400;
    font-size: calc(var(--name) * var(--u));
    line-height: 0.98;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  .date {
    margin: calc(2.5 * var(--u)) 0 0;
    font-size: calc(3.4 * var(--u));
    color: var(--p-muted);
  }
  .code {
    width: calc(50 * var(--u));
    margin: calc(6 * var(--u)) 0 calc(5 * var(--u));
    border: calc(0.35 * var(--u)) solid var(--p-ink);
    border-radius: calc(3 * var(--u));
    padding: calc(2 * var(--u));
    /* Always white behind the code: scanners need a light quiet zone around it. */
    background: #fff;
  }
  .code :global(.qr) {
    padding: 0;
    border-radius: 0;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: calc(1.8 * var(--u));
    font-size: calc(3.4 * var(--u));
    text-align: left;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: calc(2.4 * var(--u));
  }
  .steps span {
    flex: none;
    width: calc(5.2 * var(--u));
    height: calc(5.2 * var(--u));
    border-radius: 50%;
    border: calc(0.3 * var(--u)) solid currentColor;
    display: grid;
    place-items: center;
    font-size: calc(2.6 * var(--u));
    font-weight: 600;
  }
  .note {
    margin: calc(4 * var(--u)) 0 0;
    font-family: var(--serif);
    font-style: italic;
    font-size: calc(4.4 * var(--u));
  }
  .foot {
    margin: auto 0 0;
    padding-top: calc(4 * var(--u));
    font-size: calc(2.3 * var(--u));
    letter-spacing: 0.04em;
    color: var(--p-faint);
  }
  .foot em {
    font-family: var(--serif);
    font-size: 1.15em;
  }
  .poster.dark {
    --p-bg: #0e0e0d;
    --p-ink: #f2f0ec;
    --p-muted: #a19d96;
    --p-faint: #8a867f;
    --p-accent: #e3825a;
  }

  /* Print only the poster, edge to edge on one page of the chosen size. */
  @media print {
    :global(body.printing-poster > :not(.poster-overlay)) {
      display: none !important;
    }
    .overlay {
      position: static;
      display: block;
      overflow: visible;
      background: #fff;
      animation: none;
    }
    .panel {
      display: none;
    }
    .stage {
      padding: 0;
      background: none;
      display: block;
      overflow: visible;
    }
    .poster {
      width: 100vw;
      height: 100vh;
      aspect-ratio: auto !important;
      box-shadow: none;
      break-inside: avoid;
      /* Keep the dark background and accent colour when printing. */
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
  }
</style>
