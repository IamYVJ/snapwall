import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MediaItem } from '../../../shared/types';

const saved: { blob: Blob; name: string }[] = [];
vi.mock('./format', () => ({ saveBlob: (blob: Blob, name: string) => saved.push({ blob, name }) }));

const { zipMedia } = await import('./zip');

const item = (id: string, name: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name,
  mime: 'image/jpeg',
  size: 4,
  uploader: null,
  createdAt: 1_700_000_000,
  hidden: false,
  awaiting: false,
  thumb: '',
  full: '',
  download: `https://api.test/m/${id}?v=1`,
  deletableUntil: null,
  ...extra,
});

/** Serves each item's id as its file contents; `status` overrides the response for given ids. */
function serve(status: Record<string, number | number[]> = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const id = new URL(url).pathname.split('/').pop()!;
    const s = status[id];
    const code = Array.isArray(s) ? (s.shift() ?? 200) : (s ?? 200);
    return code === 200 ? new Response(id) : new Response('', { status: code });
  });
  return calls;
}

async function unzip() {
  const files = unzipSync(new Uint8Array(await saved[0].blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextDecoder().decode(v)]));
}

const run = (items: MediaItem[], extra: Partial<Parameters<typeof zipMedia>[0]> = {}) =>
  zipMedia({ filename: 'Party: 2026/12.zip', list: async () => items, signal: new AbortController().signal, onProgress: () => {}, ...extra });

beforeEach(() => (saved.length = 0));
afterEach(() => vi.unstubAllGlobals());

describe('zipMedia', () => {
  test('zips every file under its own name and a safe ZIP name', async () => {
    serve();
    const res = await run([item('a', 'one.jpg'), item('b', 'two.jpg')]);
    expect(res).toEqual({ saved: 2, failed: 0 });
    expect(saved[0].name).toBe('Party_ 2026_12.zip');
    expect(await unzip()).toEqual({ 'one.jpg': 'a', 'two.jpg': 'b' });
  });

  test('numbers repeated names instead of overwriting', async () => {
    serve();
    await run([item('a', 'IMG.jpg'), item('b', 'img.jpg'), item('c', 'IMG.jpg')]);
    expect(Object.keys(await unzip())).toEqual(['IMG.jpg', 'img (1).jpg', 'IMG (2).jpg']);
  });

  test('puts files in a folder per guest', async () => {
    serve();
    await run([item('a', 'x.jpg', { uploader: 'Asha' }), item('b', 'x.jpg', { uploader: 'Ro/han' }), item('c', 'x.jpg')], {
      folder: (i) => i.uploader ?? 'No name',
    });
    expect(Object.keys(await unzip())).toEqual(['Asha/x.jpg', 'Ro_han/x.jpg', 'No name/x.jpg']);
  });

  test('skips and counts files that fail', async () => {
    serve({ b: 500 });
    const res = await run([item('a', 'a.jpg'), item('b', 'b.jpg'), item('c', 'c.jpg')]);
    expect(res).toEqual({ saved: 2, failed: 1 });
    expect(Object.keys(await unzip())).toEqual(['a.jpg', 'c.jpg']);
  });

  test('fetches fresh links once when one has expired', async () => {
    const calls = serve({ b: [403] });
    const refresh = vi.fn(async () => [item('b', 'b.jpg', { download: 'https://api.test/m/b?v=2' })]);
    const res = await run([item('a', 'a.jpg'), item('b', 'b.jpg')], { refresh });
    expect(res).toEqual({ saved: 2, failed: 0 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toContain('https://api.test/m/b?v=2');
  });

  test('reports progress through to the end', async () => {
    serve();
    const seen: number[] = [];
    await run([item('a', 'a.jpg'), item('b', 'b.jpg')], { onProgress: (p) => seen.push(p.done) });
    expect(seen.at(-1)).toBe(2);
  });

  test('stops when cancelled', async () => {
    serve();
    const ctl = new AbortController();
    ctl.abort();
    await expect(run([item('a', 'a.jpg')], { signal: ctl.signal })).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
});
