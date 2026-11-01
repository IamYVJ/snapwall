/**
 * Work the page shouldn't lose, such as uploads. While any is held the screen stays on where the browser allows it (a
 * phone that locks pauses the uploads), leaving the page asks first, and a new version of SnapWall waits instead of
 * reloading the page.
 */
let holds = 0;
let lock: WakeLockSentinel | null = null;
let asking = false;

async function wake() {
  if (!holds || lock || asking || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  asking = true;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
    if (!holds) sleep();
  } catch {
    /* not allowed, such as in low-power mode */
  } finally {
    asking = false;
  }
}

function sleep() {
  lock?.release().catch(() => undefined);
  lock = null;
}

// Browsers drop the lock whenever the page is hidden, so it's asked for again on the way back.
document.addEventListener('visibilitychange', wake);

function leaving(e: BeforeUnloadEvent) {
  e.preventDefault();
}

/** Holds the page until the returned function is called. */
export function hold(): () => void {
  if (holds++ === 0) addEventListener('beforeunload', leaving);
  wake();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) {
      removeEventListener('beforeunload', leaving);
      sleep();
    }
  };
}

export const held = () => holds > 0;
