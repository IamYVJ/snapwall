<script lang="ts">
  import type { GuestCount } from '../../../shared/types';

  let {
    guests,
    value,
    onchange,
  }: { guests: GuestCount[]; value: string | null; onchange: (name: string | null) => void } = $props();

  // Keep the chosen guest listed even if their uploads were just hidden or removed.
  const shown = $derived(value && !guests.some((g) => g.name === value) ? [{ name: value, count: 0 }, ...guests] : guests);
</script>

{#if shown.length > 1 || value}
  <div class="guests" role="group" aria-label="Show uploads by">
    <button class:on={!value} aria-pressed={!value} onclick={() => onchange(null)}>Everyone</button>
    {#each shown as g (g.name)}
      <button class:on={value === g.name} aria-pressed={value === g.name} onclick={() => onchange(value === g.name ? null : g.name)}>
        {g.name}{#if g.count}<span class="n">{g.count}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .guests {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 2px 0 14px;
    margin-inline: -16px;
    padding-inline: 16px;
    mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 24px), transparent);
  }
  .guests::-webkit-scrollbar {
    display: none;
  }
  button {
    flex: none;
    border: 1px solid var(--line);
    background: none;
    color: var(--fg);
    border-radius: 999px;
    padding: 6px 13px;
    font-size: 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover {
    border-color: var(--muted);
  }
  button.on {
    background: var(--fg);
    border-color: var(--fg);
    color: var(--bg);
  }
  .n {
    margin-left: 6px;
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
  }
</style>
