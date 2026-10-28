import { Hono } from 'hono';
import type { AdminEvent, CreatedEvent, MediaFilter } from '../../shared/types';
import { findOwner, requireOwner } from './auth';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { driveFor, ensureRootFolder } from './google';
import { listGuests, listMedia, toMediaItem } from './media';
import {
  DEFAULT_SETTINGS,
  HttpError,
  bumpMedia,
  cleanDate,
  cleanText,
  mergeSettings,
  now,
  parseSettings,
  readJson,
  type AppEnv,
  type Ctx,
  type EventRow,
  type OwnerRow,
  type UploadRow,
} from './util';

const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const pinHash = (eventId: string, pin: string) => sha256(`${eventId}:${pin}`);

async function countUploads(c: Ctx, eventId: string) {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(review) AS awaiting, SUM(hidden = 1 AND review = 0) AS hidden
     FROM uploads WHERE event_id = ? AND status = 'done'`,
  )
    .bind(eventId)
    .first<{ n: number; awaiting: number | null; hidden: number | null }>();
  return { count: row?.n ?? 0, awaiting: row?.awaiting ?? 0, hidden: row?.hidden ?? 0 };
}

async function toAdminEvent(c: Ctx, e: EventRow, owner: OwnerRow): Promise<AdminEvent> {
  return {
    id: e.id,
    name: e.name,
    date: e.date,
    status: e.status,
    ...(await countUploads(c, e.id)),
    createdAt: e.created_at,
    settings: parseSettings(e.settings),
    hasPin: !!e.pin_hash,
    guestToken: await decrypt(e.guest_enc, c.env.TOKEN_KEY),
    folderUrl: folderUrl(e.folder_id),
    ownerEmail: owner.email,
  };
}

/**
 * Admin access is granted by either the event's admin link (X-Admin-Token) or a signed-in session
 * of the owner. Unknown events and foreign events both answer 404 so IDs can't be probed.
 */
async function eventAccess(c: Ctx): Promise<{ event: EventRow; owner: OwnerRow }> {
  const db = c.env.DB;
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first<EventRow>();
  if (!event) throw new HttpError(404, 'event_not_found');
  const adminToken = c.req.header('X-Admin-Token');
  if (adminToken) {
    if ((await sha256(adminToken)) !== event.admin_hash) throw new HttpError(404, 'event_not_found');
    const owner = await db.prepare('SELECT * FROM owners WHERE id = ?').bind(event.owner_id).first<OwnerRow>();
    if (!owner) throw new HttpError(404, 'event_not_found');
    return { event, owner };
  }
  const owner = await findOwner(c);
  if (!owner) throw new HttpError(401, 'signin_required');
  if (owner.id !== event.owner_id) throw new HttpError(404, 'event_not_found');
  return { event, owner };
}

function cleanPin(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4,8}$/.test(value)) throw new HttpError(400, 'bad_pin', 'PIN must be 4–8 digits');
  return value;
}

export const events = new Hono<AppEnv>();

events.post('/', async (c) => {
  const owner = await requireOwner(c);
  const body = await readJson(c);
  const name = cleanText(body.name, 80);
  if (!name) throw new HttpError(400, 'name_required', 'Give your event a name');
  const date = cleanDate(body.date);
  const settings = mergeSettings(DEFAULT_SETTINGS, body.settings);

  const drive = await driveFor(c.env, owner);
  const root = await ensureRootFolder(c.env, owner, drive);
  const folderId = await drive.createFolder(date ? `${name} · ${date}` : name, root);

  const id = randomToken(9);
  const guestToken = randomToken(24);
  const adminToken = randomToken(32);
  const pin = body.pin ? await pinHash(id, cleanPin(body.pin)!) : null;
  await c.env.DB.prepare(
    `INSERT INTO events (id, owner_id, name, date, folder_id, status, guest_hash, guest_enc, admin_hash, pin_hash, settings, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      owner.id,
      name,
      date,
      folderId,
      await sha256(guestToken),
      await encrypt(guestToken, c.env.TOKEN_KEY),
      await sha256(adminToken),
      pin,
      JSON.stringify(settings),
      now(),
    )
    .run();

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  const res: CreatedEvent = { event: await toAdminEvent(c, event!, owner), adminToken };
  return c.json(res, 201);
});

events.get('/:id', async (c) => {
  const { event, owner } = await eventAccess(c);
  return c.json(await toAdminEvent(c, event, owner));
});

events.patch('/:id', async (c) => {
  const { event, owner } = await eventAccess(c);
  const body = await readJson(c);
  const sets: string[] = [];
  const args: (string | null)[] = [];

  if (body.name !== undefined) {
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, 'name_required');
    sets.push('name = ?');
    args.push(name);
  }
  if (body.date !== undefined) {
    sets.push('date = ?');
    args.push(cleanDate(body.date));
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') throw new HttpError(400, 'bad_status');
    sets.push('status = ?');
    args.push(body.status);
  }
  if (body.settings !== undefined) {
    sets.push('settings = ?');
    args.push(JSON.stringify(mergeSettings(parseSettings(event.settings), body.settings)));
  }
  if (body.pin !== undefined) {
    sets.push('pin_hash = ?');
    args.push(body.pin === null || body.pin === '' ? null : await pinHash(event.id, cleanPin(body.pin)!));
  }

  if (sets.length) {
    // Settings, status or PIN changes can change what the slideshow may show.
    sets.push('media_version = media_version + 1');
    await c.env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...args, event.id)
      .run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(event.id).first<EventRow>();
  return c.json(await toAdminEvent(c, updated!, owner));
});

/** Issues a new guest or admin link. The old one stops working immediately. */
events.post('/:id/rotate', async (c) => {
  const { event, owner } = await eventAccess(c);
  const { which } = await readJson<{ which?: string }>(c);
  const token = randomToken(which === 'admin' ? 32 : 24);
  if (which === 'guest') {
    await c.env.DB.prepare('UPDATE events SET guest_hash = ?, guest_enc = ? WHERE id = ?')
      .bind(await sha256(token), await encrypt(token, c.env.TOKEN_KEY), event.id)
      .run();
  } else if (which === 'admin') {
    await c.env.DB.prepare('UPDATE events SET admin_hash = ? WHERE id = ?').bind(await sha256(token), event.id).run();
  } else {
    throw new HttpError(400, 'bad_rotate');
  }
  const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(event.id).first<EventRow>();
  const res: CreatedEvent = { event: await toAdminEvent(c, updated!, owner), adminToken: which === 'admin' ? token : '' };
  return c.json(res);
});

/** Deletes the event from SnapWall. With ?trash=1 the Drive folder (and every file in it) goes to Drive's trash. */
events.delete('/:id', async (c) => {
  const { event, owner } = await eventAccess(c);
  if (c.req.query('trash') === '1') {
    const drive = await driveFor(c.env, owner);
    await drive.trash(event.folder_id).catch((err) => {
      if (!(err instanceof HttpError && err.code === 'drive_not_found')) throw err;
    });
  }
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM uploads WHERE event_id = ?').bind(event.id),
    db.prepare('DELETE FROM events WHERE id = ?').bind(event.id),
  ]);
  return c.json({ ok: true });
});

const FILTERS: MediaFilter[] = ['all', 'awaiting', 'hidden'];

events.get('/:id/media', async (c) => {
  const { event } = await eventAccess(c);
  const filter = FILTERS.find((f) => f === c.req.query('filter')) ?? 'all';
  return c.json(await listMedia(c, event, 'a', parseSettings(event.settings), filter));
});

events.get('/:id/guests', async (c) => {
  const { event } = await eventAccess(c);
  return c.json(await listGuests(c, event, 'a'));
});

/** Approves uploads awaiting review: the given ids, or all of them when none are given. */
events.post('/:id/media/approve', async (c) => {
  const { event } = await eventAccess(c);
  const { ids } = await readJson<{ ids?: unknown }>(c);
  const db = c.env.DB;
  let sql = 'UPDATE uploads SET hidden = 0, review = 0 WHERE event_id = ? AND review = 1';
  const args: string[] = [event.id];
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((i) => typeof i === 'string')) {
      throw new HttpError(400, 'bad_ids');
    }
    sql += ` AND id IN (${ids.map(() => '?').join(', ')})`;
    args.push(...ids);
  }
  const [res] = await db.batch([db.prepare(sql).bind(...args), bumpMedia(db, event.id)]);
  return c.json({ approved: res.meta.changes ?? 0 });
});

async function findUpload(c: Ctx, event: EventRow): Promise<UploadRow> {
  const u = await c.env.DB.prepare(`SELECT * FROM uploads WHERE id = ? AND event_id = ? AND status = 'done'`)
    .bind(c.req.param('mid'), event.id)
    .first<UploadRow>();
  if (!u) throw new HttpError(404, 'not_found');
  return u;
}

events.patch('/:id/media/:mid', async (c) => {
  const { event } = await eventAccess(c);
  const u = await findUpload(c, event);
  const { hidden } = await readJson<{ hidden?: boolean }>(c);
  if (typeof hidden !== 'boolean') throw new HttpError(400, 'bad_hidden');
  const db = c.env.DB;
  // Showing approves an upload; hiding one that awaits approval rejects it. Either way it's no longer awaiting.
  await db.batch([
    db.prepare('UPDATE uploads SET hidden = ?, review = 0 WHERE id = ?').bind(hidden ? 1 : 0, u.id),
    bumpMedia(db, event.id),
  ]);
  u.hidden = hidden ? 1 : 0;
  u.review = 0;
  return c.json(await toMediaItem(c, event, u, 'a', parseSettings(event.settings)));
});

/** Moves one file to Drive's trash and removes it from the wall. */
events.delete('/:id/media/:mid', async (c) => {
  const { event, owner } = await eventAccess(c);
  const u = await findUpload(c, event);
  const drive = await driveFor(c.env, owner);
  await drive.trash(u.file_id!).catch((err) => {
    if (!(err instanceof HttpError && err.code === 'drive_not_found')) throw err;
  });
  const db = c.env.DB;
  await db.batch([db.prepare('DELETE FROM uploads WHERE id = ?').bind(u.id), bumpMedia(db, event.id)]);
  return c.json({ ok: true });
});
