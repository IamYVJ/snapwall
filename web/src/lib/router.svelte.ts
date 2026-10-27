// Hash routing: GitHub Pages has no server-side rewrites, and secrets in the fragment never reach any server.

function parse(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export const router = $state({ parts: parse() });

window.addEventListener('hashchange', () => {
  router.parts = parse();
  window.scrollTo(0, 0);
});

export function go(path: string, opts: { replace?: boolean } = {}) {
  const hash = `#/${path.replace(/^\//, '')}`;
  if (opts.replace) {
    history.replaceState(null, '', hash);
    router.parts = parse();
  } else {
    location.hash = hash;
  }
}

export const href = (path: string) => `#/${path.replace(/^\//, '')}`;

export function pageUrl(path: string): string {
  return `${location.origin}${location.pathname}#/${path.replace(/^\//, '')}`;
}
