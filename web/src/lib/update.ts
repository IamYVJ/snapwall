import { held } from './activity';

/**
 * Keeps people on the latest SnapWall. Opening the page always fetches it fresh (see sw.js). This covers a page that
 * stays open, like the home-screen app brought back from the background, which keeps running the version it started with.
 */

/** Away at least this long, coming back is like opening the app again, so a reload doesn't cut into anything. */
const AWAY_MS = 10 * 60_000;
let hiddenAt = 0;

async function outdated(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
    const { build } = (await res.json()) as { build: string };
    return build !== __BUILD_ID__;
  } catch {
    return false;
  }
}

/** Not while uploads run, or while the person is typing or has a dialog open. */
const busy = () => held() || !!document.querySelector('dialog[open]') || document.activeElement?.matches('input, textarea');

if (import.meta.env.PROD) {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => undefined);
    if (Date.now() - hiddenAt < AWAY_MS || busy()) return;
    if ((await outdated()) && !busy()) location.reload();
  });

  // A page from before a deploy can ask for code files the deploy replaced, such as the image maker. Reloading gets the new ones.
  addEventListener('vite:preloadError', (e) => {
    if (busy()) return;
    e.preventDefault();
    location.reload();
  });
}
