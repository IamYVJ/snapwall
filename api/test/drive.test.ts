import { afterEach, expect, test, vi } from 'vitest';
import { Drive, RETRY_DELAYS_MS } from '../src/google';
import { HttpError } from '../src/util';
import { driveError, driveJson, fakeDrive } from './harness';

afterEach(() => vi.unstubAllGlobals());

const QUOTA = { storageQuota: { limit: '1000', usage: '400' } };

/** A Drive whose waits are recorded instead of slept, and whose requests are answered in turn by `replies`. */
function driveWith(...replies: (Response | Error)[]) {
  const waits: number[] = [];
  const calls = fakeDrive(() => {
    const next = replies.length > 1 ? replies.shift()! : replies[0];
    if (next instanceof Error) throw next;
    return next.clone();
  });
  const drive = new Drive('token', async (ms) => void waits.push(ms));
  return { drive, calls, waits };
}

async function failure(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err;
}

test('retries when Drive says to slow down, then succeeds', async () => {
  const { drive, calls, waits } = driveWith(driveError(429, 'rateLimitExceeded'), driveError(403, 'userRateLimitExceeded'), driveJson(QUOTA));
  expect(await drive.storage()).toEqual({ limit: 1000, usage: 400 });
  expect(calls).toHaveLength(3);
  expect(waits).toHaveLength(2);
  // Jittered between half and one and a half times each step.
  waits.forEach((ms, i) => expect(ms).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[i] / 2));
  waits.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(RETRY_DELAYS_MS[i] * 1.5));
});

test('gives up after the last retry and reports Drive as busy', async () => {
  const { drive, calls } = driveWith(driveError(403, 'userRateLimitExceeded'));
  const err = await failure(drive.storage());
  expect(err.status).toBe(429);
  expect(err.code).toBe('drive_rate_limited');
  expect(calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
});

test('honours Retry-After, capped at 5 seconds', async () => {
  const { drive, waits } = driveWith(
    driveJson({}, 429, { 'Retry-After': '2' }),
    driveJson({}, 429, { 'Retry-After': '120' }),
    driveJson(QUOTA),
  );
  await drive.storage();
  expect(waits).toEqual([2000, 5000]);
});

test('a full Drive is not retried', async () => {
  const { drive, calls } = driveWith(driveError(403, 'storageQuotaExceeded'));
  const err = await failure(drive.storage());
  expect(err.status).toBe(507);
  expect(err.code).toBe('storage_full');
  expect(calls).toHaveLength(1);
});

test('other refusals are not retried', async () => {
  const { drive, calls } = driveWith(driveError(403, 'insufficientFilePermissions'));
  expect((await failure(drive.getFile('f', 'id'))).code).toBe('drive_error');
  expect(calls).toHaveLength(1);
});

test('server errors and dropped connections retry reads', async () => {
  const { drive, calls } = driveWith(driveJson({}, 503), new TypeError('network'), driveJson({ id: 'f' }));
  expect(await drive.getFile('f', 'id')).toEqual({ id: 'f' });
  expect(calls).toHaveLength(3);
});

test('a POST is not repeated after a server error, which may have created it', async () => {
  const { drive, calls } = driveWith(driveJson({}, 503));
  expect((await failure(drive.createFolder('SnapWall'))).code).toBe('drive_error');
  expect(calls).toHaveLength(1);
});

test('a POST is repeated after a rate limit, which means it never ran', async () => {
  const { drive, calls } = driveWith(driveError(429, 'rateLimitExceeded'), driveJson({ id: 'folder' }));
  expect(await drive.createFolder('SnapWall')).toBe('folder');
  expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
});

test('storage reports no limit for unlimited Drives', async () => {
  const { drive } = driveWith(driveJson({ storageQuota: { usage: '5' } }));
  expect(await drive.storage()).toEqual({ limit: null, usage: 5 });
});
