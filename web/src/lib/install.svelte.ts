/**
 * Home-screen install. Chrome and Edge fire `beforeinstallprompt`, which is kept so the guest wall can offer
 * its own button; iOS has no prompt, so the wall shows the Share-menu steps instead.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred = $state<InstallPrompt | null>(null);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
});
window.addEventListener('appinstalled', () => (deferred = null));

const standalone =
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
// iPadOS reports itself as a Mac, so touch support tells them apart.
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const install = {
  /** True when the browser will show its own install dialog. */
  get canPrompt() {
    return deferred !== null;
  },
  /** True on iOS/iPadOS outside the installed app, where the guest adds it through the Share menu. */
  get manual() {
    return !standalone && !deferred && ios;
  },
  async prompt() {
    const e = deferred;
    if (!e) return;
    deferred = null;
    await e.prompt();
    await e.userChoice.catch(() => undefined);
  },
};

/**
 * Points the page's manifest at one event, so the home-screen icon carries the event's name and opens its wall.
 * The manifest is built in the browser as a blob, so the event name and link never leave the device.
 * Returns a function that restores the site-wide manifest.
 */
export function eventManifest(name: string): () => void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return () => undefined;
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  const original = link.href;
  const icon = (file: string, size: number, purpose = 'any') => ({ src: base + 'icons/' + file, sizes: `${size}x${size}`, type: 'image/png', purpose });
  const manifest = {
    id: location.href,
    name,
    short_name: name.length > 12 ? 'SnapWall' : name,
    start_url: location.href,
    scope: base,
    display: 'standalone',
    background_color: '#faf9f7',
    theme_color: '#faf9f7',
    icons: [icon('icon-192.png', 192), icon('icon-512.png', 512), icon('maskable-512.png', 512, 'maskable')],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
  link.href = url;
  return () => {
    link.href = original;
    URL.revokeObjectURL(url);
  };
}
