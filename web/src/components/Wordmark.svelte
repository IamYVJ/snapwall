<script lang="ts">
  let { href = '#/' }: { href?: string } = $props();
</script>

<a {href} class="wordmark" aria-label="SnapWall home">Snap<em>Wall</em></a>

<style>
  .wordmark {
    font-family: var(--serif);
    font-size: 24px;
    line-height: 1;
    text-decoration: none;
    letter-spacing: -0.01em;
  }
  em {
    font-style: italic;
  }
</style>
