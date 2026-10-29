import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { driveJson, fakeDrive, startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.dispose());
beforeEach(() => h.reset());

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('admin access', () => {
  test('a wrong admin token looks like a missing event', async () => {
    const e = await h.seedEvent();
    const r = await h.call(`/events/${e.id}`, { headers: { 'X-Admin-Token': 'nope' } });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('event_not_found');
  });

  test('another owner cannot open the event', async () => {
    const e = await h.seedEvent();
    const other = await h.seedEvent();
    const r = await h.call(`/events/${e.id}`, { headers: { 'X-Admin-Token': other.adminToken } });
    expect(r.status).toBe(404);
  });

  test('without a token or session it asks for sign-in', async () => {
    const e = await h.seedEvent();
    expect((await h.call(`/events/${e.id}`)).body.error).toBe('signin_required');
  });

  test('a signed-in owner gets in with their session', async () => {
    const e = await h.seedEvent();
    const { sha256 } = await import('../src/crypto');
    const owner = await h.env.DB.prepare('SELECT owner_id FROM events WHERE id = ?').bind(e.id).first<{ owner_id: string }>();
    await h.env.DB.prepare('INSERT INTO sessions (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, 0, ?)')
      .bind(await sha256('session-token'), owner!.owner_id, Math.floor(Date.now() / 1000) + 3600)
      .run();
    const r = await h.call(`/events/${e.id}`, { headers: { Authorization: 'Bearer session-token' } });
    expect(r.status).toBe(200);
    expect(r.body.guestToken).toBe(e.guestToken);
  });
});

describe('settings', () => {
  test('keeps only well-typed values and clamps numbers', async () => {
    const e = await h.seedEvent();
    const r = await h.call(`/events/${e.id}`, {
      method: 'PATCH',
      headers: e.admin,
      json: { settings: { maxFileMB: 999_999, guestMaxFiles: 0, guestMaxMB: 'lots', allowVideo: 'no', moderation: true } },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ maxFileMB: 5000, guestMaxFiles: 1, guestMaxMB: null, allowVideo: true, moderation: true });
  });

  test('null removes a per-guest limit', async () => {
    const e = await h.seedEvent({ settings: { guestMaxFiles: 50, guestMaxMB: 500 } });
    const r = await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { settings: { guestMaxFiles: null } } });
    expect(r.body.settings).toMatchObject({ guestMaxFiles: null, guestMaxMB: 500 });
  });

  test('the host can turn Find me on and off', async () => {
    const e = await h.seedEvent();
    const patch = (faceSearch: unknown) => h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { settings: { faceSearch } } });
    expect((await patch(true)).body.settings.faceSearch).toBe(true);
    expect((await patch('yes')).body.settings.faceSearch).toBe(true);
    expect((await patch(false)).body.settings.faceSearch).toBe(false);
  });

  test('turning off the wall also turns off guest downloads', async () => {
    const e = await h.seedEvent();
    const r = await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { settings: { guestView: false } } });
    expect(r.body.settings).toMatchObject({ guestView: false, guestDownload: false });
  });

  test('any change bumps the media version that live slideshows watch', async () => {
    const e = await h.seedEvent();
    const version = async () =>
      (await h.env.DB.prepare('SELECT media_version FROM events WHERE id = ?').bind(e.id).first<{ media_version: number }>())!.media_version;
    const before = await version();
    await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { status: 'disabled' } });
    expect(await version()).toBe(before + 1);
  });

  test('disabling the event closes the guest link', async () => {
    const e = await h.seedEvent();
    await h.call(`/events/${e.id}`, { method: 'PATCH', headers: e.admin, json: { status: 'disabled' } });
    expect((await h.call(`/g/${e.guestToken}`)).body.error).toBe('event_disabled');
  });

  test('replacing the guest link stops the old one', async () => {
    const e = await h.seedEvent();
    const r = await h.call(`/events/${e.id}/rotate`, { method: 'POST', headers: e.admin, json: { which: 'guest' } });
    expect((await h.call(`/g/${e.guestToken}`)).status).toBe(404);
    expect((await h.call(`/g/${r.body.event.guestToken}`)).status).toBe(200);
  });
});

describe('approval', () => {
  async function seeded() {
    const e = await h.seedEvent({ settings: { moderation: true } });
    const shown = await h.seedUpload(e.id, { uploader: 'Priya' });
    const hidden = await h.seedUpload(e.id, { hidden: 1, uploader: 'Priya' });
    const waitA = await h.seedUpload(e.id, { hidden: 1, review: 1, uploader: 'Rohan' });
    const waitB = await h.seedUpload(e.id, { hidden: 1, review: 1 });
    return { e, shown, hidden, waitA, waitB };
  }

  test('counts and filters uploads awaiting approval apart from hidden ones', async () => {
    const { e, shown, hidden, waitA, waitB } = await seeded();
    const ev = (await h.call(`/events/${e.id}`, { headers: e.admin })).body;
    expect(ev).toMatchObject({ count: 4, awaiting: 2, hidden: 1 });

    const list = (filter: string) => h.call(`/events/${e.id}/media?filter=${filter}`, { headers: e.admin }).then((r) => ids(r.body.items));
    expect(await list('awaiting')).toEqual([waitB.id, waitA.id]);
    expect(await list('hidden')).toEqual([hidden.id]);
    expect(await list('all')).toEqual([waitB.id, waitA.id, hidden.id, shown.id]);

    const awaiting = (await h.call(`/events/${e.id}/media?filter=awaiting`, { headers: e.admin })).body.items;
    expect(awaiting.every((i: { awaiting: boolean; hidden: boolean }) => i.awaiting && i.hidden)).toBe(true);
  });

  test('admin filters combine with the guest filter', async () => {
    const { e, waitA } = await seeded();
    const r = await h.call(`/events/${e.id}/media?filter=awaiting&by=Rohan`, { headers: e.admin });
    expect(ids(r.body.items)).toEqual([waitA.id]);
    const names = (await h.call(`/events/${e.id}/guests`, { headers: e.admin })).body;
    expect(names).toEqual([
      { name: 'Priya', count: 2 },
      { name: 'Rohan', count: 1 },
    ]);
  });

  test('approving one shows it to guests and leaves the rest waiting', async () => {
    const { e, waitA, waitB } = await seeded();
    const r = await h.call(`/events/${e.id}/media/approve`, { method: 'POST', headers: e.admin, json: { ids: [waitA.id] } });
    expect(r.body.approved).toBe(1);
    expect(ids((await h.call(`/g/${e.guestToken}/media`)).body.items)).toContain(waitA.id);
    expect(ids((await h.call(`/g/${e.guestToken}/media`)).body.items)).not.toContain(waitB.id);
    expect((await h.call(`/events/${e.id}`, { headers: e.admin })).body.awaiting).toBe(1);
  });

  test('approve all only touches uploads awaiting approval', async () => {
    const { e, hidden } = await seeded();
    const r = await h.call(`/events/${e.id}/media/approve`, { method: 'POST', headers: e.admin, json: {} });
    expect(r.body.approved).toBe(2);
    const ev = (await h.call(`/events/${e.id}`, { headers: e.admin })).body;
    expect(ev).toMatchObject({ awaiting: 0, hidden: 1 });
    expect(ids((await h.call(`/g/${e.guestToken}/media`)).body.items)).not.toContain(hidden.id);
  });

  test('cannot approve uploads from another event', async () => {
    const { e } = await seeded();
    const other = await h.seedEvent();
    const foreign = await h.seedUpload(other.id, { hidden: 1, review: 1 });
    const r = await h.call(`/events/${e.id}/media/approve`, { method: 'POST', headers: e.admin, json: { ids: [foreign.id] } });
    expect(r.body.approved).toBe(0);
  });

  test('rejects bad id lists', async () => {
    const { e } = await seeded();
    for (const json of [{ ids: [] }, { ids: 'all' }, { ids: [1] }, { ids: Array(101).fill('x') }]) {
      expect((await h.call(`/events/${e.id}/media/approve`, { method: 'POST', headers: e.admin, json })).status).toBe(400);
    }
  });

  test('hiding an upload that awaits approval rejects it', async () => {
    const { e, waitA } = await seeded();
    const r = await h.call(`/events/${e.id}/media/${waitA.id}`, { method: 'PATCH', headers: e.admin, json: { hidden: true } });
    expect(r.body).toMatchObject({ hidden: true, awaiting: false });
    expect((await h.call(`/events/${e.id}`, { headers: e.admin })).body).toMatchObject({ awaiting: 1, hidden: 2 });
  });
});

describe('deleting', () => {
  test('removes the event and its uploads', async () => {
    const e = await h.seedEvent();
    await h.seedUpload(e.id);
    expect((await h.call(`/events/${e.id}`, { method: 'DELETE', headers: e.admin })).status).toBe(200);
    expect((await h.call(`/g/${e.guestToken}`)).status).toBe(404);
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first('n')).toBe(0);
  });
});

describe('Drive space', () => {
  test('the event page can ask how full the Drive is', async () => {
    const e = await h.seedEvent({ drive: true });
    fakeDrive(() => driveJson({ storageQuota: { limit: '16106127360', usage: '15000000000' } }));
    try {
      const r = await h.call(`/events/${e.id}/storage`, { headers: e.admin });
      expect(r.body).toEqual({ limit: 16106127360, usage: 15000000000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('needs admin access', async () => {
    const e = await h.seedEvent({ drive: true });
    expect((await h.call(`/events/${e.id}/storage`)).body.error).toBe('signin_required');
    expect((await h.call('/me/storage')).body.error).toBe('signin_required');
  });
});
