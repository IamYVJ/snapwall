import { describe, expect, test } from 'vitest';
import { MATCH_DISTANCE, closest, distance, matching, scanFaces, type Descriptor } from './faces';

// Two-number stand-ins for the model's 128-number descriptors; the maths is the same.
const me: Descriptor = [0, 0];
const nearMe: Descriptor = [MATCH_DISTANCE * 0.6, 0];
const stranger: Descriptor = [MATCH_DISTANCE * 2, 0];

describe('matching faces', () => {
  test('measures straight-line distance', () => {
    expect(distance([0, 0], [3, 4])).toBe(5);
    expect(closest(me, [stranger, nearMe])).toBeCloseTo(MATCH_DISTANCE * 0.6);
    expect(closest(me, [])).toBe(Infinity);
  });

  test('keeps photos with a close face, in wall order, and leaves out ones not scanned', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    const faces = new Map<string, Descriptor[]>([
      ['a', [stranger, nearMe]],
      ['b', [stranger]],
      ['c', []],
      ['e', [me]],
    ]);
    expect(matching(me, items, faces).map((i) => i.id)).toEqual(['a', 'e']);
  });

  test('a face right at the limit does not count', () => {
    expect(matching(me, [{ id: 'a' }], new Map([['a', [[MATCH_DISTANCE, 0]]]]))).toEqual([]);
  });
});

describe('scanning photos', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));

  test('reads each photo once, one at a time, while a few downloads run ahead', async () => {
    let loading = 0;
    let maxLoading = 0;
    let detecting = 0;
    const progress: [number, number][] = [];
    const cache = new Map<string, Descriptor[]>([['b', [me]]]);
    const res = await scanFaces({
      items,
      cache,
      load: async (item) => {
        maxLoading = Math.max(maxLoading, ++loading);
        await new Promise((r) => setTimeout(r, 1));
        loading--;
        return item.id;
      },
      detect: async (id) => {
        expect(++detecting).toBe(1);
        await new Promise((r) => setTimeout(r, 2));
        detecting--;
        return [[id.charCodeAt(0), 0]];
      },
      signal: new AbortController().signal,
      onProgress: (d, t) => progress.push([d, t]),
      prefetch: 2,
    });
    expect(res.failed).toBe(0);
    expect(maxLoading).toBeLessThanOrEqual(2);
    expect([...cache.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // Already-scanned photos are skipped and keep what was found before.
    expect(cache.get('b')).toEqual([me]);
    expect(progress[0]).toEqual([0, 5]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  test('skips photos that fail, so the next search tries them again', async () => {
    const cache = new Map<string, Descriptor[]>();
    const res = await scanFaces({
      items,
      cache,
      load: async (item) => {
        if (item.id === 'b') throw new Error('thumbnail 404');
        return item.id;
      },
      detect: async (id) => {
        if (id === 'd') throw new Error('unreadable');
        return [];
      },
      signal: new AbortController().signal,
    });
    expect(res.failed).toBe(2);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('d')).toBe(false);
    expect(cache.size).toBe(4);
  });

  test('stops when cancelled and keeps what it found', async () => {
    const abort = new AbortController();
    const cache = new Map<string, Descriptor[]>();
    const run = scanFaces({
      items,
      cache,
      load: async (item) => item.id,
      detect: async (id) => {
        if (id === 'b') abort.abort();
        return [];
      },
      signal: abort.signal,
    });
    await expect(run).rejects.toThrow();
    expect([...cache.keys()]).toEqual(['a', 'b']);
  });
});
