import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.dispose());
beforeEach(() => h.reset());

/** A guest's signed full-size link for the event's only upload. */
async function guestLink() {
  const e = await h.seedEvent();
  const u = await h.seedUpload(e.id);
  const [item] = (await h.call(`/g/${e.guestToken}/media`)).body.items;
  return { e, u, url: new URL(item.full as string) };
}

const fetchMedia = (url: URL) => h.call(url.pathname + url.search);

test('a valid signed link reaches Drive', async () => {
  const { url } = await guestLink();
  expect((await fetchMedia(url)).body.error).toBe('drive_disconnected');
});

test('a tampered signature is refused', async () => {
  const { url } = await guestLink();
  url.searchParams.set('s', `${url.searchParams.get('s')!.slice(0, -2)}xx`);
  expect((await fetchMedia(url)).body.error).toBe('bad_signature');
});

test('a guest link cannot be turned into an admin link', async () => {
  const { url } = await guestLink();
  url.searchParams.set('a', 'a');
  expect((await fetchMedia(url)).body.error).toBe('bad_signature');
});

test('an expired link is refused', async () => {
  const { url } = await guestLink();
  url.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 1));
  expect((await fetchMedia(url)).body.error).toBe('link_expired');
});

test('hiding an upload stops its guest links at once', async () => {
  const { e, u, url } = await guestLink();
  await h.call(`/events/${e.id}/media/${u.id}`, { method: 'PATCH', headers: e.admin, json: { hidden: true } });
  expect((await fetchMedia(url)).status).toBe(404);
});

test('disabling the event stops guest links at once', async () => {
  const { e, url } = await guestLink();
  await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { status: 'disabled' } });
  expect((await fetchMedia(url)).status).toBe(404);
});

test('guest download links stop when downloads are turned off', async () => {
  const e = await h.seedEvent();
  await h.seedUpload(e.id);
  const [item] = (await h.call(`/g/${e.guestToken}/media`)).body.items;
  await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { settings: { guestDownload: false } } });
  const url = new URL(item.download);
  expect((await fetchMedia(url)).body.error).toBe('download_disabled');
});

test('admin links still work for hidden uploads', async () => {
  const e = await h.seedEvent();
  await h.seedUpload(e.id, { hidden: 1, review: 1 });
  const [item] = (await h.call(`/events/${e.id}/media`, { headers: e.admin })).body.items;
  expect((await fetchMedia(new URL(item.full))).body.error).toBe('drive_disconnected');
});
