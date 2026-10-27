<script lang="ts">
  import type { Snippet } from 'svelte';

  let { open = $bindable(false), title, children }: { open?: boolean; title: string; children: Snippet } = $props();
  let dialog: HTMLDialogElement;

  $effect(() => {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} onclick={(e) => e.target === dialog && (open = false)}>
  <div class="body stack">
    <h2 class="h2">{title}</h2>
    {@render children()}
  </div>
</dialog>

<style>
  dialog {
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--surface);
    color: var(--fg);
    padding: 0;
    width: min(460px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
  }
  dialog::backdrop {
    background: rgba(10, 10, 10, 0.45);
    backdrop-filter: blur(4px);
  }
  dialog[open] {
    animation: rise 0.25s ease both;
  }
  .body {
    padding: 28px;
  }
</style>
