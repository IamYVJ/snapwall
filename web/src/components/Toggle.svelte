<script lang="ts">
  let {
    label,
    hint = '',
    checked = $bindable(false),
    disabled = false,
    onchange,
  }: { label: string; hint?: string; checked?: boolean; disabled?: boolean; onchange?: (v: boolean) => void } = $props();
</script>

<label class="toggle" class:disabled>
  <span class="text">
    <span class="label">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <input type="checkbox" role="switch" bind:checked {disabled} onchange={() => onchange?.(checked)} />
  <span class="track" aria-hidden="true"><span class="thumb"></span></span>
</label>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 0;
    cursor: pointer;
    position: relative;
  }
  .toggle + :global(.toggle) {
    border-top: 1px solid var(--line);
  }
  .disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .label {
    font-size: 15px;
    font-weight: 500;
  }
  .hint {
    font-size: 13px;
    color: var(--muted);
  }
  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .track {
    flex: none;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fg) 16%, transparent);
    position: relative;
    transition: background 0.2s ease;
  }
  .thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: transform 0.2s cubic-bezier(0.3, 0.7, 0.3, 1);
  }
  input:checked + .track {
    background: var(--fg);
  }
  input:checked + .track .thumb {
    transform: translateX(18px);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
