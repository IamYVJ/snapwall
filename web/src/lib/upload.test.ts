import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MediaItem } from '../../../shared/types';
import { ApiError, type GuestApi } from './api';
import { BUSY_DELAYS_MS, canRetry, uploadFile } from './upload';

interface Reply {
  status: number;
  body?: unknown;
  range?: string;
}

/** Stands in for the browser's XMLHttpRequest: each PUT to Drive gets the next reply in turn, and is recorded. */
let replies: Reply[] = [];
let puts: { headers: Record<string, string>; size: number }[] = [];

class FakeXhr {
  status = 0;
  responseText = '';
  upload: { onprogress?: (e: { loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  private headers: Record<string, string> = {};
  private range: string | null = null;
  open() {}
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(name: string) {
    return name === 'Range' ? this.range : null;
  }
  send(body: Blob) {
    puts.push({ headers: this.headers, size: body.size });
    const r = replies.shift() ?? { status: 0 };
    queueMicrotask(() => {
      if (r.status === 0) return this.onerror?.();
      this.status = r.status;
      this.responseText = r.body === undefined ? '' : JSON.stringify(r.body);
      this.range = r.range ?? null;
      this.onload?.();
    });
  }
}

const ITEM = { id: 'u1' } as MediaItem;
const file = new File([new Uint8Array(1000)], 'a.jpg', { type: 'image/jpeg' });
const busy = () => new ApiError(429, 'drive_rate_limited', 'Google Drive is busy. Trying again shortly.');
const full = () => new ApiError(507, 'storage_full', 'The host’s Google Drive is full');

/** A guest API whose start and complete calls fail with the given errors first, then succeed. */
function fakeApi(startErrors: ApiError[] = [], completeErrors: ApiError[] = []) {
  const api = {
    startUpload: vi.fn(async () => {
      const err = startErrors.shift();
      if (err) throw err;
      return { uploadId: 'u1', uploadUrl: 'https://www.googleapis.com/upload/session' };
    }),
    completeUpload: vi.fn(async () => {
      const err = completeErrors.shift();
      if (err) throw err;
      return ITEM;
    }),
  };
  return api as typeof api & GuestApi;
}

/** Runs an upload to the end, letting fake time pass through every retry pause. */
async function run(api: GuestApi, onWait?: (waiting: boolean) => void) {
  const p = uploadFile(api, file, { uploader: null, stripLocation: false, onWait }, () => undefined).then(
    (item) => ({ item, err: null }),
    (err: unknown) => ({ item: null, err }),
  );
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  replies = [];
  puts = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('waits out a busy Drive when starting and finishing an upload', async () => {
  const api = fakeApi([busy(), busy()], [busy()]);
  replies = [{ status: 200, body: { id: 'drive-file' } }];
  const waits: boolean[] = [];
  const { item } = await run(api, (w) => waits.push(w));
  expect(item).toBe(ITEM);
  expect(api.startUpload).toHaveBeenCalledTimes(3);
  expect(api.completeUpload).toHaveBeenCalledTimes(2);
  expect(api.completeUpload).toHaveBeenLastCalledWith('u1', 'drive-file');
  expect(waits).toEqual([true, false, true, false, true, false]);
});

test('stops waiting after the last pause and lets the guest retry', async () => {
  const api = fakeApi(Array.from({ length: 10 }, busy));
  const { err } = await run(api);
  expect((err as ApiError).code).toBe('drive_rate_limited');
  expect(api.startUpload).toHaveBeenCalledTimes(BUSY_DELAYS_MS.length + 1);
  expect(canRetry(err)).toBe(true);
});

test('a full Drive fails at once, retryable once the host frees space', async () => {
  const api = fakeApi([full()]);
  const { err } = await run(api);
  expect((err as ApiError).code).toBe('storage_full');
  expect(api.startUpload).toHaveBeenCalledTimes(1);
  expect(canRetry(err)).toBe(true);
});

test('Drive refusing the bytes for space says the host’s Drive is full', async () => {
  replies = [{ status: 403, body: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } }];
  const { err } = await run(fakeApi());
  expect((err as ApiError).code).toBe('storage_full');
  expect((err as ApiError).message).toContain('Drive is full');
  expect(puts).toHaveLength(1);
});

test('Drive throttling the bytes resumes from what it already has', async () => {
  replies = [
    { status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
    // Status check: Google has the first 400 bytes.
    { status: 308, range: 'bytes=0-399' },
    { status: 200, body: { id: 'drive-file' } },
  ];
  const { item } = await run(fakeApi());
  expect(item).toBe(ITEM);
  expect(puts.map((p) => p.headers['Content-Range'] ?? null)).toEqual([null, 'bytes */1000', 'bytes 400-999/1000']);
  expect(puts[2].size).toBe(600);
});

test('other refusals fail without retrying', async () => {
  replies = [{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }];
  const { err } = await run(fakeApi());
  expect((err as ApiError).code).toBe('drive_rejected');
  expect(puts).toHaveLength(1);
  expect(canRetry(new ApiError(403, 'guest_limit', ''))).toBe(false);
  expect(canRetry(new TypeError('network'))).toBe(true);
});
