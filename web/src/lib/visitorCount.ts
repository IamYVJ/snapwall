// Decorative "N visitors" footnote (GoatCounter). Lives in a module because the CSP blocks inline scripts.
// Stays hidden on every failure: adblocker, offline, a brand-new path with no data yet, or the setting off.

// A fixed date before this project's first pageview. All-time is the default, so this doesn't
// change the count; it gives the response its own cache key.
const START = '2026-01-01';

let count: string | null = null;
let visible = false;

function render() {
  const box = document.querySelector<HTMLElement>('.visitor-counter');
  const out = document.getElementById('visitor-count');
  if (!box || !out) return;
  if (count !== null) out.textContent = count;
  box.hidden = !(visible && count !== null);
}

/** Shows the footnote only on public pages. Every page still counts towards the same total. */
export function setVisitorFootnote(show: boolean) {
  visible = show;
  render();
}

export function showVisitorCount() {
  // Read the endpoint off the beacon tag so the site URL lives in one place.
  const tag = document.querySelector<HTMLScriptElement>('script[data-goatcounter]');
  const endpoint = tag?.dataset.goatcounter;
  if (!endpoint) return;

  // This page's path only, never /counter/TOTAL.json (which sums every project), and without
  // location.search on purpose. Routes live in the hash, so this is always /snapwall/.
  const path = window.location.pathname;

  fetch(`${endpoint.replace(/\/count$/, '')}/counter/${encodeURIComponent(path)}.json?start=${START}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad status'))))
    .then((data) => {
      // `count` is already a formatted string: render it as-is.
      if (data && data.count != null) {
        count = String(data.count);
        render();
      }
    })
    .catch(() => {});
}
