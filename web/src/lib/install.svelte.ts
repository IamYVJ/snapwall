import { session } from './api';
import { router } from './router.svelte';
import { encodeHandoff } from './saved';
import { saved } from './saved.svelte';

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

// iOS can't tell a page whether SnapWall is on the home screen, so this remembers that the person went through the steps.
const ADDED_KEY = 'snapwall.app';
let added = $state(read());
function read() {
  try {
    return localStorage.getItem(ADDED_KEY) === '1';
  } catch {
    return false;
  }
}

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
  /** True inside the installed app. */
  standalone,
  /**
   * True once the person on iOS has been shown how to add SnapWall. Links on iOS always open in Safari, and an event
   * opened there isn't in the app's storage, so these pages offer to carry the link over by copy and paste.
   */
  get added() {
    return added;
  },
  markAdded() {
    added = true;
    try {
      localStorage.setItem(ADDED_KEY, '1');
    } catch {
      /* storage unavailable */
    }
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
 * Points the page's manifest at one that opens SnapWall's home page, where every event this device has opened is listed.
 * On iOS the installed app doesn't share storage with Safari, so its start link also carries that list, the sign-in
 * and the page it was installed from (see the open route). Other browsers share storage with the installed app, and
 * Chrome syncs installed apps' links to the person's Google account, so they get a plain link with no secrets in it.
 * The manifest is built in the browser as a blob, so none of this leaves the device.
 */
function appManifest(start: string): () => void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return () => undefined;
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  const original = link.href;
  const icon = (file: string, size: number, purpose = 'any') => ({ src: base + 'icons/' + file, sizes: `${size}x${size}`, type: 'image/png', purpose });
  const manifest = {
    id: base,
    name: 'SnapWall',
    short_name: 'SnapWall',
    start_url: base + start,
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

if (ios && !standalone) {
  $effect.root(() => {
    $effect(() => {
      const to = router.parts.join('/');
      const handoff = { events: saved.list, session: session.get(), to };
      return appManifest(handoff.events.length || handoff.session || to ? '#/open/' + encodeHandoff(handoff) : '');
    });
  });
}
