// Hash routing: GitHub Pages has no server-side rewrites, and secrets in the fragment never reach any server.

function parse(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export const router = $state({ parts: parse() });

/** Pages without a title of their own would otherwise keep the last page's, such as an event name. */
function navigate() {
  document.title = 'SnapWall';
  router.parts = parse();
}

window.addEventListener('hashchange', () => {
  navigate();
  window.scrollTo(0, 0);
});

export function go(path: string, opts: { replace?: boolean } = {}) {
  const hash = `#/${path.replace(/^\//, '')}`;
  if (opts.replace) {
    history.replaceState(null, '', hash);
    navigate();
  } else {
    location.hash = hash;
  }
}

export const href = (path: string) => `#/${path.replace(/^\//, '')}`;

export function pageUrl(path: string): string {
  return `${location.origin}${location.pathname}#/${path.replace(/^\//, '')}`;
}
