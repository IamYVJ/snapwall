<script lang="ts">
  import QRCode from 'qrcode';

  let { value, label = 'QR code' }: { value: string; label?: string } = $props();
  let svg = $state('');

  $effect(() => {
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#ffffff' } }).then(
      (s) => (svg = s),
    );
  });
</script>

<div class="qr" role="img" aria-label={label}>{@html svg}</div>

<style>
  .qr {
    background: #fff;
    padding: 18px;
    border-radius: 12px;
    aspect-ratio: 1;
    width: 100%;
  }
  .qr :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
