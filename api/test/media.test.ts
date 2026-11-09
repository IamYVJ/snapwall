import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { driveJson, fakeDrive, startHarness, type Harness } from './harness';

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

describe('before Drive has made a thumbnail', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Drive with no thumbnail for the file yet; the file itself streams as "PHOTO". */
  function driveWithoutThumbnail() {
    // Node has no Workers cache; on workers.dev it is a no-op too.
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    return fakeDrive((url) =>
      url.searchParams.get('alt') === 'media'
        ? new Response('PHOTO', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' } })
        : driveJson({}),
    );
  }

  async function links(mime: string) {
    const e = await h.seedEvent({ drive: true });
    await h.seedUpload(e.id, { mime });
    const [item] = (await h.call(`/g/${e.guestToken}/media`)).body.items;
    return { thumb: new URL(item.thumb), full: new URL(item.full) };
  }


  test('a photo browsers can show is sent as it is, kept only briefly', async () => {
    driveWithoutThumbnail();
    const { thumb, full } = await links('image/jpeg');
    for (const url of [thumb, full]) {
      const r = await fetchMedia(url);
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
      expect(r.headers.get('Cache-Control')).toBe('private, max-age=60');
    }
  });

  test('an iPhone HEIC photo waits for the thumbnail rather than sending a file browsers can’t show', async () => {
    driveWithoutThumbnail();
    const { thumb, full } = await links('image/heic');
    expect((await fetchMedia(thumb)).body.error).toBe('no_thumbnail');
    expect((await fetchMedia(full)).body.error).toBe('no_thumbnail');
  });

  test('a video’s preview waits too', async () => {
    driveWithoutThumbnail();
    const { thumb } = await links('video/mp4');
    expect((await fetchMedia(thumb)).body.error).toBe('no_thumbnail');
  });

  test('extra parameters, as the page adds when asking again, keep the link valid', async () => {
    driveWithoutThumbnail();
    const { thumb } = await links('image/jpeg');
    thumb.searchParams.set('retry', '3');
    expect((await fetchMedia(thumb)).status).toBe(200);
  });
});
