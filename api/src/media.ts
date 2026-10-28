import { Hono } from 'hono';
import type { EventSettings, GuestCount, MediaFilter, MediaItem, MediaPage } from '../../shared/types';
import { sign, verify } from './crypto';
import { driveFor } from './google';
import { HttpError, now, parseSettings, type AppEnv, type Ctx, type EventRow, type OwnerRow, type UploadRow } from './util';

type Kind = 'thumb' | 'full' | 'dl';
/** g = guest wall, a = admin console. Guest URLs never resolve hidden items. */
type Audience = 'g' | 'a';

const PAGE = 60;
const THUMB_PX = 640;
const FULL_PX = 2048;

// Expiry is rounded to 30-minute buckets so URLs stay stable between polls and the browser can cache them.
const expiry = () => (Math.floor(now() / 1800) + 2) * 1800;

async function mediaUrl(c: Ctx, eventId: string, uploadId: string, kind: Kind, aud: Audience): Promise<string> {
  const exp = expiry();
  const sig = await sign(`${eventId}.${uploadId}.${kind}.${aud}.${exp}`, c.env.SIGNING_KEY);
  return `${new URL(c.req.url).origin}/m/${eventId}/${uploadId}/${kind}?a=${aud}&e=${exp}&s=${sig}`;
}

export async function toMediaItem(c: Ctx, event: EventRow, u: UploadRow, aud: Audience, settings: EventSettings): Promise<MediaItem> {
  const canDownload = aud === 'a' || settings.guestDownload;
  return {
    id: u.id,
    name: u.name,
    mime: u.mime,
    size: u.size,
    uploader: u.uploader,
    createdAt: u.created_at,
    hidden: !!u.hidden,
    awaiting: !!u.review,
    thumb: await mediaUrl(c, event.id, u.id, 'thumb', aud),
    full: await mediaUrl(c, event.id, u.id, 'full', aud),
    download: canDownload ? await mediaUrl(c, event.id, u.id, 'dl', aud) : null,
  };
}

export async function listMedia(
  c: Ctx,
  event: EventRow,
  aud: Audience,
  settings: EventSettings,
  filter: MediaFilter = 'all',
): Promise<MediaPage> {
  const cursor = c.req.query('cursor');
  let sql = `SELECT * FROM uploads WHERE event_id = ? AND status = 'done'`;
  const args: (string | number)[] = [event.id];
  if (aud === 'g') sql += ' AND hidden = 0';
  else if (filter === 'awaiting') sql += ' AND review = 1';
  else if (filter === 'hidden') sql += ' AND hidden = 1 AND review = 0';
  const by = c.req.query('by');
  if (by) {
    sql += ' AND uploader = ?';
    args.push(by);
  }
  if (cursor) {
    const [ts, id] = cursor.split('_');
    sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    args.push(Number(ts), Number(ts), id);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`;
  const { results } = await c.env.DB.prepare(sql).bind(...args).all<UploadRow>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    items: await Promise.all(page.map((u) => toMediaItem(c, event, u, aud, settings))),
    next: results.length > PAGE && last ? `${last.created_at}_${last.id}` : null,
  };
}

/** Guest names with upload counts, most active first. Guests only see names on visible uploads. */
export async function listGuests(c: Ctx, event: EventRow, aud: Audience): Promise<GuestCount[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT uploader AS name, COUNT(*) AS count FROM uploads
     WHERE event_id = ? AND status = 'done' AND uploader IS NOT NULL${aud === 'g' ? ' AND hidden = 0' : ''}
     GROUP BY uploader ORDER BY count DESC, uploader LIMIT 200`,
  )
    .bind(event.id)
    .all<GuestCount>();
  return results;
}

function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function mediaHeaders(headers: Headers): Headers {
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return headers;
}

export const media = new Hono<AppEnv>();

/** Streams a thumbnail or file from the owner's Drive. Nothing is stored by SnapWall. */
media.get('/:event/:upload/:kind', async (c) => {
  const { event: eventId, upload: uploadId } = c.req.param();
  const kind = c.req.param('kind') as Kind;
  const aud = c.req.query('a') as Audience;
  const exp = Number(c.req.query('e'));
  const sig = c.req.query('s') ?? '';
  if (!['thumb', 'full', 'dl'].includes(kind) || !['g', 'a'].includes(aud) || !(exp > now())) {
    throw new HttpError(403, 'link_expired');
  }
  if (!(await verify(`${eventId}.${uploadId}.${kind}.${aud}.${exp}`, sig, c.env.SIGNING_KEY))) {
    throw new HttpError(403, 'bad_signature');
  }

  const db = c.env.DB;
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first<EventRow>();
  const upload = await db
    .prepare(`SELECT * FROM uploads WHERE id = ? AND event_id = ? AND status = 'done'`)
    .bind(uploadId, eventId)
    .first<UploadRow>();
  if (!event || !upload?.file_id) throw new HttpError(404, 'not_found');
  if (aud === 'g') {
    // Re-check live settings so disabling the event or hiding an item takes effect immediately.
    const settings = parseSettings(event.settings);
    if (event.status !== 'active' || upload.hidden || !settings.guestView) throw new HttpError(404, 'not_found');
    if (kind === 'dl' && !settings.guestDownload) throw new HttpError(403, 'download_disabled');
  }

  const owner = await db.prepare('SELECT * FROM owners WHERE id = ?').bind(event.owner_id).first<OwnerRow>();
  if (!owner) throw new HttpError(404, 'not_found');
  const drive = await driveFor(c.env, owner);
  const isImage = upload.mime.startsWith('image/');

  if (kind === 'thumb' || (kind === 'full' && isImage)) {
    const px = kind === 'thumb' ? THUMB_PX : FULL_PX;
    // Cache API is a no-op on *.workers.dev; it starts working once the Worker has a custom domain.
    const cache = (caches as unknown as { default: Cache }).default;
    const key = new Request(`https://snapwall-cache.internal/${upload.file_id}/${px}`);
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: mediaHeaders(new Headers(hit.headers)) });

    const file = await drive.getFile(upload.file_id, 'thumbnailLink');
    if (file.thumbnailLink) {
      const res = await drive.thumbnail(file.thumbnailLink, px);
      const body = await res.arrayBuffer();
      const headers = new Headers({ 'Content-Type': res.headers.get('Content-Type') ?? 'image/jpeg' });
      c.executionCtx.waitUntil(
        cache.put(key, new Response(body, { headers: { ...Object.fromEntries(headers), 'Cache-Control': 'max-age=86400' } })),
      );
      return new Response(body, { headers: mediaHeaders(headers) });
    }
    // Drive has not generated a thumbnail yet (common for fresh videos).
    if (kind === 'thumb') throw new HttpError(404, 'no_thumbnail');
  }

  const res = await drive.media(upload.file_id, c.req.header('Range'));
  const headers = new Headers({ 'Content-Type': upload.mime, 'Accept-Ranges': 'bytes' });
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Content-Disposition', contentDisposition(kind === 'dl' ? 'attachment' : 'inline', upload.name));
  return new Response(res.body, { status: res.status, headers: mediaHeaders(headers) });
});
