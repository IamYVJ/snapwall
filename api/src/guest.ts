import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { IMAGE_TYPES, VIDEO_TYPES, type EventSettings, type PublicEvent, type UploadSlot } from '../../shared/types';
import { randomToken, sha256 } from './crypto';
import { pinHash } from './events';
import { STORAGE_FULL, driveFor } from './google';
import { listGuests, listMedia, toMediaItem } from './media';
import {
  HttpError,
  bumpMedia,
  cleanText,
  now,
  parseSettings,
  readJson,
  uploadsAccepting,
  type AppEnv,
  type Ctx,
  type EventRow,
  type OwnerRow,
  type UploadRow,
} from './util';

const RATE_WINDOW = 600;
const RATE_MAX = 300;

/** Resolves the guest link. Disabled events and wrong PINs never reveal anything beyond the event name. */
async function guestEvent(c: Ctx): Promise<{ event: EventRow; settings: EventSettings }> {
  const hash = await sha256(c.req.param('token') ?? '');
  const event = await c.env.DB.prepare('SELECT * FROM events WHERE guest_hash = ?').bind(hash).first<EventRow>();
  if (!event) throw new HttpError(404, 'event_not_found', 'This link is not valid');
  if (event.status !== 'active') throw new HttpError(403, 'event_disabled', 'This event has been closed by the host');
  if (event.pin_hash) {
    const pin = c.req.header('X-Event-Pin');
    if (!pin) throw new HttpError(401, 'pin_required', event.name);
    if ((await pinHash(event.id, pin)) !== event.pin_hash) throw new HttpError(401, 'pin_wrong', event.name);
  }
  return { event, settings: parseSettings(event.settings) };
}

function requireUploads(settings: EventSettings) {
  if (!uploadsAccepting(settings)) throw new HttpError(403, 'uploads_closed', 'Uploads are closed for this event');
}

/**
 * Identifies a guest for per-guest limits: the random device ID the web app sends, or the IP for clients that
 * send none. Hashed with a secret, per event, so it can't be linked across events or back to the device.
 */
async function guestKey(c: Ctx, event: EventRow, ipHash: string): Promise<string> {
  const id = c.req.header('X-Guest-Id');
  if (!id || !/^[\w-]{16,64}$/.test(id)) return ipHash;
  return sha256(`guest:${id}:${event.id}:${c.env.SIGNING_KEY}`);
}

const ipHashOf = (c: Ctx, event: EventRow) => sha256(`${c.req.header('CF-Connecting-IP') ?? ''}:${event.id}:${c.env.SIGNING_KEY}`);

const hasLimits = (s: EventSettings) => s.guestMaxFiles !== null || s.guestMaxMB !== null;

/** Files and bytes a guest has used: finished uploads, plus ones started in the last day that may still finish. */
async function usageOf(db: D1Database, eventId: string, key: string) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM uploads
       WHERE event_id = ? AND guest_hash = ? AND (status = 'done' OR created_at > ?)`,
    )
    .bind(eventId, key, now() - 86400)
    .first<{ files: number; bytes: number }>();
  return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
}

function mbLabel(mb: number): string {
  return mb >= 1000 ? `${+(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

function driveName(name: string): string {
  return (cleanText(name, 150) ?? 'upload').replace(/[\\/:*?"<>|]/g, '_');
}

export const guest = new Hono<AppEnv>();

guest.get('/:token', async (c) => {
  const { event, settings } = await guestEvent(c);
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE event_id = ? AND status = 'done' AND hidden = 0`)
    .bind(event.id)
    .first<{ n: number }>();
  const usage = hasLimits(settings) ? await usageOf(c.env.DB, event.id, await guestKey(c, event, await ipHashOf(c, event))) : null;
  const body: PublicEvent = {
    id: event.id,
    name: event.name,
    date: event.date,
    count: row?.n ?? 0,
    settings: {
      guestView: settings.guestView,
      guestDownload: settings.guestDownload,
      allowVideo: settings.allowVideo,
      uploadsOpen: uploadsAccepting(settings),
      maxFileMB: settings.maxFileMB,
      requireName: settings.requireName,
      stripLocation: settings.stripLocation,
      moderation: settings.moderation,
      guestMaxFiles: settings.guestMaxFiles,
      guestMaxMB: settings.guestMaxMB,
    },
    usage,
  };
  return c.json(body);
});

guest.get('/:token/media', async (c) => {
  const { event, settings } = await guestEvent(c);
  if (!settings.guestView) throw new HttpError(403, 'view_disabled', 'The host has made this an upload-only event');
  return c.json(await listMedia(c, event, 'g', settings));
});

guest.get('/:token/guests', async (c) => {
  const { event, settings } = await guestEvent(c);
  if (!settings.guestView) throw new HttpError(403, 'view_disabled', 'The host has made this an upload-only event');
  return c.json(await listGuests(c, event, 'g'));
});

// A free Worker request may run 50 D1 queries, so each stream checks for a minute and the client reconnects.
const LIVE_EVERY_MS = 1500;
const LIVE_CHECKS = 40;

/**
 * Server-sent events for the slideshow: sends the event's media version on connect and whenever it changes,
 * and "closed" if the event is disabled or deleted. The client then refetches the media list itself.
 */
guest.get('/:token/live', async (c) => {
  const { event, settings } = await guestEvent(c);
  if (!settings.guestView) throw new HttpError(403, 'view_disabled', 'The host has made this an upload-only event');
  c.header('Cache-Control', 'no-store');
  return streamSSE(c, async (s) => {
    let version = event.media_version;
    await s.writeSSE({ data: String(version) });
    for (let i = 0; i < LIVE_CHECKS && !s.aborted; i++) {
      await s.sleep(LIVE_EVERY_MS);
      const row = await c.env.DB.prepare('SELECT status, media_version FROM events WHERE id = ?')
        .bind(event.id)
        .first<Pick<EventRow, 'status' | 'media_version'>>();
      if (!row || row.status !== 'active') {
        await s.writeSSE({ data: 'closed' });
        return;
      }
      if (row.media_version !== version) {
        version = row.media_version;
        await s.writeSSE({ data: String(version) });
      }
    }
  });
});

guest.post('/:token/uploads', async (c) => {
  const { event, settings } = await guestEvent(c);
  requireUploads(settings);
  const body = await readJson(c);
  const mime = typeof body.mime === 'string' ? body.mime.toLowerCase() : '';
  const size = typeof body.size === 'number' ? body.size : 0;
  const uploader = cleanText(body.uploader, 40);
  const name = driveName(String(body.name ?? ''));

  const allowed = settings.allowVideo ? [...IMAGE_TYPES, ...VIDEO_TYPES] : IMAGE_TYPES;
  if (!allowed.includes(mime)) throw new HttpError(415, 'type_not_allowed', 'This file type is not accepted');
  if (!(size > 0) || size > settings.maxFileMB * 1024 * 1024) {
    throw new HttpError(413, 'too_large', `Files must be under ${settings.maxFileMB} MB`);
  }
  if (settings.requireName && !uploader) throw new HttpError(400, 'name_required', 'Please add your name');

  const db = c.env.DB;
  // IPs are only kept as a salted, per-event hash for rate limiting.
  const ipHash = await ipHashOf(c, event);
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM uploads WHERE event_id = ? AND ip_hash = ? AND created_at > ?')
    .bind(event.id, ipHash, now() - RATE_WINDOW)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= RATE_MAX) throw new HttpError(429, 'rate_limited', 'Too many uploads, please wait a few minutes');

  const guestHash = await guestKey(c, event, ipHash);
  if (hasLimits(settings)) {
    const used = await usageOf(db, event.id, guestHash);
    if (settings.guestMaxFiles !== null && used.files >= settings.guestMaxFiles) {
      throw new HttpError(403, 'guest_limit', `You’ve reached the limit of ${settings.guestMaxFiles} files per guest`);
    }
    if (settings.guestMaxMB !== null && used.bytes + size > settings.guestMaxMB * 1024 * 1024) {
      throw new HttpError(403, 'guest_limit', `This would go over the ${mbLabel(settings.guestMaxMB)} limit per guest`);
    }
  }

  const owner = await db.prepare('SELECT * FROM owners WHERE id = ?').bind(event.owner_id).first<OwnerRow>();
  if (!owner) throw new HttpError(404, 'event_not_found');
  const drive = await driveFor(c.env, owner);

  const uploadId = randomToken(12);
  const allowedOrigins = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const origin = c.req.header('Origin');
  // Drive may only refuse a too-big file after the guest has sent all of it, so check the space up front.
  // The check runs alongside opening the session; if it fails, the upload goes ahead and Drive decides.
  const [uploadUrl, space] = await Promise.all([
    drive.startUpload({
      name,
      mimeType: mime,
      size,
      parent: event.folder_id,
      origin: origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
      description: uploader ? `Uploaded by ${uploader} via SnapWall` : 'Uploaded via SnapWall',
      appProperties: { snapwallEvent: event.id, snapwallUpload: uploadId },
    }),
    drive.storage().catch(() => null),
  ]);
  if (space && space.limit !== null && space.usage + size > space.limit) throw new HttpError(507, 'storage_full', STORAGE_FULL);

  await db
    .prepare(
      `INSERT INTO uploads (id, event_id, name, mime, size, uploader, status, hidden, ip_hash, guest_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(uploadId, event.id, name, mime, size, uploader, ipHash, guestHash, now())
    .run();

  const slot: UploadSlot = { uploadId, uploadUrl };
  return c.json(slot, 201);
});

/** Confirms an upload. The file is checked against Drive so a guest can't attach arbitrary files. */
guest.post('/:token/uploads/:uid/complete', async (c) => {
  const { event, settings } = await guestEvent(c);
  const db = c.env.DB;
  const u = await db
    .prepare(`SELECT * FROM uploads WHERE id = ? AND event_id = ? AND status = 'pending'`)
    .bind(c.req.param('uid'), event.id)
    .first<UploadRow>();
  if (!u) throw new HttpError(404, 'upload_not_found');
  const { fileId } = await readJson<{ fileId?: string }>(c);
  if (typeof fileId !== 'string' || !/^[\w-]{10,200}$/.test(fileId)) throw new HttpError(400, 'bad_file_id');

  const owner = await db.prepare('SELECT * FROM owners WHERE id = ?').bind(event.owner_id).first<OwnerRow>();
  const drive = await driveFor(c.env, owner!);
  const file = await drive.getFile(fileId, 'id,parents,appProperties,mimeType,size');
  if (!file.parents?.includes(event.folder_id) || file.appProperties?.snapwallUpload !== u.id) {
    throw new HttpError(400, 'upload_mismatch');
  }

  const review = settings.moderation ? 1 : 0;
  await db.batch([
    db
      .prepare(`UPDATE uploads SET file_id = ?, status = 'done', hidden = ?, review = ?, size = ?, created_at = ? WHERE id = ?`)
      .bind(file.id, review, review, Number(file.size ?? u.size), now(), u.id),
    bumpMedia(db, event.id),
  ]);
  const done = { ...u, file_id: file.id, status: 'done' as const, hidden: review, review, created_at: now() };
  return c.json(await toMediaItem(c, event, done, 'g', settings));
});
