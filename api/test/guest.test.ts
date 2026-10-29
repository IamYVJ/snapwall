import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ORIGIN, driveError, driveJson, fakeDrive, startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const upload = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.call(`/g/${token}/uploads`, { method: 'POST', headers, json: { name: 'a.jpg', mime: 'image/jpeg', size: 1000, uploader: null, ...body } });

describe('guest link', () => {
  test('unknown link is 404', async () => {
    const r = await h.call('/g/not-a-real-token');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('event_not_found');
  });

  test('disabled event reveals nothing', async () => {
    const e = await h.seedEvent({ status: 'disabled' });
    for (const path of ['', '/media', '/guests']) {
      const r = await h.call(`/g/${e.guestToken}${path}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('event_disabled');
    }
  });

  test('PIN is required and checked', async () => {
    const e = await h.seedEvent({ pin: '4321' });
    expect((await h.call(`/g/${e.guestToken}`)).body.error).toBe('pin_required');
    expect((await h.call(`/g/${e.guestToken}`, { headers: { 'X-Event-Pin': '0000' } })).body.error).toBe('pin_wrong');
    const ok = await h.call(`/g/${e.guestToken}/media`, { headers: { 'X-Event-Pin': '4321' } });
    expect(ok.status).toBe(200);
  });

  test('upload-only events hide the wall, the guest list and the live stream', async () => {
    const e = await h.seedEvent({ settings: { guestView: false } });
    for (const path of ['/media', '/guests', '/live']) {
      expect((await h.call(`/g/${e.guestToken}${path}`)).body.error).toBe('view_disabled');
    }
  });
});

describe('guest wall', () => {
  test('lists only visible uploads, newest first, and counts only those', async () => {
    const e = await h.seedEvent();
    const a = await h.seedUpload(e.id);
    await h.seedUpload(e.id, { hidden: 1 });
    await h.seedUpload(e.id, { hidden: 1, review: 1 });
    await h.seedUpload(e.id, { status: 'pending' });
    const b = await h.seedUpload(e.id);
    const r = await h.call(`/g/${e.guestToken}/media`);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([b.id, a.id]);
    expect((await h.call(`/g/${e.guestToken}`)).body.count).toBe(2);
  });

  test('download links follow the guest download setting', async () => {
    const e = await h.seedEvent({ settings: { guestDownload: false } });
    await h.seedUpload(e.id);
    const [item] = (await h.call(`/g/${e.guestToken}/media`)).body.items;
    expect(item.download).toBeNull();
    expect(item.awaiting).toBe(false);
  });

  test('filters by guest name, and the name list ignores hidden uploads', async () => {
    const e = await h.seedEvent();
    await h.seedUpload(e.id, { uploader: 'Rohan' });
    await h.seedUpload(e.id, { uploader: 'Rohan' });
    await h.seedUpload(e.id, { uploader: 'Asha' });
    await h.seedUpload(e.id, { uploader: 'Asha', hidden: 1 });
    await h.seedUpload(e.id, { uploader: 'Hidden Only', hidden: 1, review: 1 });
    await h.seedUpload(e.id);

    const guests = (await h.call(`/g/${e.guestToken}/guests`)).body;
    expect(guests).toEqual([
      { name: 'Rohan', count: 2 },
      { name: 'Asha', count: 1 },
    ]);
    const asha = (await h.call(`/g/${e.guestToken}/media?by=Asha`)).body.items;
    expect(asha).toHaveLength(1);
    expect(asha[0].uploader).toBe('Asha');
  });
});

describe('starting an upload', () => {
  test('rejects types the event does not accept', async () => {
    const e = await h.seedEvent({ settings: { allowVideo: false } });
    expect((await upload(e.guestToken, { mime: 'video/mp4' })).status).toBe(415);
    expect((await upload(e.guestToken, { mime: 'text/html' })).status).toBe(415);
  });

  test('rejects files over the size limit', async () => {
    const e = await h.seedEvent({ settings: { maxFileMB: 1 } });
    expect((await upload(e.guestToken, { size: 2 * 1024 * 1024 })).body.error).toBe('too_large');
  });

  test('requires a name when the host asks for one', async () => {
    const e = await h.seedEvent({ settings: { requireName: true } });
    expect((await upload(e.guestToken, { uploader: '  ' })).body.error).toBe('name_required');
  });

  test('refuses when uploads are paused or past their closing time', async () => {
    const paused = await h.seedEvent({ settings: { uploadsOpen: false } });
    expect((await upload(paused.guestToken, {})).body.error).toBe('uploads_closed');
    const expired = await h.seedEvent({ settings: { expiresAt: Math.floor(Date.now() / 1000) - 60 } });
    expect((await upload(expired.guestToken, {})).body.error).toBe('uploads_closed');
  });

  test('a valid upload gets as far as Drive', async () => {
    const e = await h.seedEvent();
    // The test owner has no Drive tokens, so passing every check ends here.
    expect((await upload(e.guestToken, {})).body.error).toBe('drive_disconnected');
  });
});

describe('per-guest limits', () => {
  const device = 'device_aaaaaaaaaaaaaaaa';
  const other = 'device_bbbbbbbbbbbbbbbb';

  test('reports usage only when the event has limits', async () => {
    const plain = await h.seedEvent();
    expect((await h.call(`/g/${plain.guestToken}`, { headers: { 'X-Guest-Id': device } })).body.usage).toBeNull();

    const e = await h.seedEvent({ settings: { guestMaxFiles: 5 } });
    await h.seedUpload(e.id, { guest_hash: await h.guestHash(device, e.id), size: 300 });
    const r = await h.call(`/g/${e.guestToken}`, { headers: { 'X-Guest-Id': device } });
    expect(r.body.usage).toEqual({ files: 1, bytes: 300 });
    expect(r.body.settings.guestMaxFiles).toBe(5);
  });

  test('caps files per device without affecting other devices', async () => {
    const e = await h.seedEvent({ settings: { guestMaxFiles: 2 } });
    const mine = await h.guestHash(device, e.id);
    await h.seedUpload(e.id, { guest_hash: mine });
    // An unfinished upload from the last day still counts, so parallel uploads can't slip past.
    await h.seedUpload(e.id, { guest_hash: mine, status: 'pending', created_at: Math.floor(Date.now() / 1000) - 60 });

    const blocked = await upload(e.guestToken, {}, { 'X-Guest-Id': device });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('guest_limit');
    expect((await upload(e.guestToken, {}, { 'X-Guest-Id': other })).body.error).toBe('drive_disconnected');
  });

  test('abandoned uploads older than a day stop counting', async () => {
    const e = await h.seedEvent({ settings: { guestMaxFiles: 1 } });
    await h.seedUpload(e.id, { guest_hash: await h.guestHash(device, e.id), status: 'pending', created_at: 1 });
    expect((await upload(e.guestToken, {}, { 'X-Guest-Id': device })).body.error).toBe('drive_disconnected');
  });

  test('caps total size per device', async () => {
    const e = await h.seedEvent({ settings: { guestMaxMB: 1 } });
    await h.seedUpload(e.id, { guest_hash: await h.guestHash(device, e.id), size: 600_000 });
    expect((await upload(e.guestToken, { size: 500_000 }, { 'X-Guest-Id': device })).body.error).toBe('guest_limit');
    expect((await upload(e.guestToken, { size: 400_000 }, { 'X-Guest-Id': device })).body.error).toBe('drive_disconnected');
  });

  test('falls back to the IP when no valid device ID is sent', async () => {
    const e = await h.seedEvent({ settings: { guestMaxFiles: 1 } });
    const { sha256 } = await import('../src/crypto');
    await h.seedUpload(e.id, { guest_hash: await sha256(`203.0.113.9:${e.id}:${h.env.SIGNING_KEY}`) });
    const r = await upload(e.guestToken, {}, { 'CF-Connecting-IP': '203.0.113.9', 'X-Guest-Id': 'bad id!' });
    expect(r.body.error).toBe('guest_limit');
    const elsewhere = await upload(e.guestToken, {}, { 'CF-Connecting-IP': '198.51.100.1' });
    expect(elsewhere.body.error).toBe('drive_disconnected');
  });
});

describe('CORS', () => {
  test('allows the guest and PIN headers from the web app only', async () => {
    const ok = await h.call('/g/x', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-guest-id' },
    });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-guest-id');
    expect(ok.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-event-pin');

    const evil = await h.call('/g/x', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('host Drive space', () => {
  afterEach(() => vi.unstubAllGlobals());

  const GB = 2 ** 30;
  /** Drive with this much used of `limit`, opening upload sessions as asked unless `start` says otherwise. */
  const driveWith = (quota: { limit?: number; usage: number }, start?: () => Response) =>
    fakeDrive((url) => {
      if (url.pathname.endsWith('/about')) return driveJson({ storageQuota: { limit: quota.limit && String(quota.limit), usage: String(quota.usage) } });
      return start?.() ?? new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x' } });
    });
  const pendingRows = async (eventId: string) =>
    (await h.env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE event_id = ?').bind(eventId).first<{ n: number }>())!.n;

  test('an upload starts when there is room', async () => {
    const e = await h.seedEvent({ drive: true });
    const calls = driveWith({ limit: 15 * GB, usage: GB });
    const r = await upload(e.guestToken, { size: 5_000_000 });
    expect(r.status).toBe(201);
    expect(r.body.uploadUrl).toContain('upload_id=x');
    expect(calls.map((c) => c.url.pathname).sort()).toEqual(['/drive/v3/about', '/upload/drive/v3/files']);
  });

  test('a file that would not fit is refused before the guest sends it', async () => {
    const e = await h.seedEvent({ drive: true });
    driveWith({ limit: 15 * GB, usage: 15 * GB - 1_000_000 });
    const r = await upload(e.guestToken, { size: 5_000_000 });
    expect(r.status).toBe(507);
    expect(r.body.error).toBe('storage_full');
    expect(r.body.message).toContain('Drive is full');
    expect(await pendingRows(e.id)).toBe(0);
  });

  test('a Drive without a limit always has room', async () => {
    const e = await h.seedEvent({ drive: true });
    driveWith({ usage: 100 * GB });
    expect((await upload(e.guestToken, {})).status).toBe(201);
  });

  test('when the space check fails, the upload goes ahead', async () => {
    const e = await h.seedEvent({ drive: true });
    fakeDrive((url) =>
      url.pathname.endsWith('/about')
        ? driveError(403, 'insufficientPermissions')
        : new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x' } }),
    );
    expect((await upload(e.guestToken, {})).status).toBe(201);
  });

  test('Drive refusing the session for space is reported as full', async () => {
    const e = await h.seedEvent({ drive: true });
    driveWith({ limit: 15 * GB, usage: 0 }, () => driveError(403, 'storageQuotaExceeded'));
    const r = await upload(e.guestToken, {});
    expect(r.status).toBe(507);
    expect(r.body.error).toBe('storage_full');
    expect(await pendingRows(e.id)).toBe(0);
  });
});
