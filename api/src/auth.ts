import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DriveStorage, EventSummary, Me } from '../../shared/types';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { DRIVE_SCOPE, authUrl, decodeIdToken, driveFor, exchangeCode, revokeToken } from './google';
import { HttpError, now, parseSettings, uploadsAccepting, type AppEnv, type Ctx, type EventRow, type OwnerRow } from './util';

const SESSION_TTL = 30 * 86400;
const STATE_COOKIE = 'sw_oauth_state';

const redirectUri = (c: Ctx) => new URL('/auth/google/callback', c.req.url).toString();
const toWeb = (c: Ctx, route: string) => c.redirect(`${c.env.WEB_BASE_URL}#/${route}`);

function bearer(c: Ctx): string | null {
  const header = c.req.header('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function findOwner(c: Ctx): Promise<OwnerRow | null> {
  const token = bearer(c);
  if (!token) return null;
  return c.env.DB.prepare(
    'SELECT o.* FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token_hash = ? AND s.expires_at > ?',
  )
    .bind(await sha256(token), now())
    .first<OwnerRow>();
}

export async function requireOwner(c: Ctx): Promise<OwnerRow> {
  const owner = await findOwner(c);
  if (!owner) throw new HttpError(401, 'signin_required', 'Please sign in again');
  return owner;
}

export const auth = new Hono<AppEnv>();

auth.get('/google/start', (c) => {
  const state = randomToken(16);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600 });
  return c.redirect(authUrl(c.env, redirectUri(c), state, c.req.query('consent') === '1'));
});

auth.get('/google/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  if (error) return toWeb(c, `signin-error/${encodeURIComponent(error)}`);
  if (!code || !state || state !== expected) return toWeb(c, 'signin-error/state');

  const tok = await exchangeCode(c.env, code, redirectUri(c));
  if (!tok.scope.split(' ').includes(DRIVE_SCOPE)) {
    // The user unticked the Drive permission on Google's consent screen.
    await revokeToken(tok.access_token);
    return toWeb(c, 'signin-error/drive_scope');
  }
  if (!tok.id_token) return toWeb(c, 'signin-error/profile');
  const profile = decodeIdToken(tok.id_token);

  const db = c.env.DB;
  const existing = await db.prepare('SELECT * FROM owners WHERE google_sub = ?').bind(profile.sub).first<OwnerRow>();
  if (!tok.refresh_token && !existing?.refresh_enc) {
    // Google only issues a refresh token on explicit consent; ask once more with prompt=consent.
    return c.redirect('/auth/google/start?consent=1');
  }

  const accessEnc = await encrypt(tok.access_token, c.env.TOKEN_KEY);
  const refreshEnc = tok.refresh_token ? await encrypt(tok.refresh_token, c.env.TOKEN_KEY) : existing!.refresh_enc;
  const ownerId = existing?.id ?? randomToken(12);
  if (existing) {
    await db
      .prepare('UPDATE owners SET email = ?, name = ?, refresh_enc = ?, access_enc = ?, access_exp = ? WHERE id = ?')
      .bind(profile.email, profile.name, refreshEnc, accessEnc, now() + tok.expires_in, ownerId)
      .run();
  } else {
    await db
      .prepare(
        'INSERT INTO owners (id, google_sub, email, name, refresh_enc, access_enc, access_exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(ownerId, profile.sub, profile.email, profile.name, refreshEnc, accessEnc, now() + tok.expires_in, now())
      .run();
  }

  const session = randomToken(32);
  await db
    .prepare('INSERT INTO sessions (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(session), ownerId, now(), now() + SESSION_TTL)
    .run();
  // The session travels in the URL fragment, which browsers never send to any server.
  return toWeb(c, `auth/${session}`);
});

auth.post('/logout', async (c) => {
  const token = bearer(c);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return c.json({ ok: true });
});

export const me = new Hono<AppEnv>();

export function toSummary(e: EventRow & { count: number }): EventSummary {
  return {
    id: e.id,
    name: e.name,
    date: e.date,
    status: e.status,
    accepting: uploadsAccepting(parseSettings(e.settings)),
    count: e.count,
    createdAt: e.created_at,
  };
}

me.get('/', async (c) => {
  const owner = await requireOwner(c);
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id AND u.status = 'done') AS count
     FROM events e WHERE e.owner_id = ? ORDER BY e.created_at DESC`,
  )
    .bind(owner.id)
    .all<EventRow & { count: number }>();
  const body: Me = { email: owner.email, name: owner.name, events: results.map(toSummary) };
  return c.json(body);
});

/** How full the host's Drive is, for the dashboard warning. Asked separately so a slow Drive never delays the dashboard. */
me.get('/storage', async (c) => {
  const owner = await requireOwner(c);
  const body: DriveStorage = await (await driveFor(c.env, owner)).storage();
  return c.json(body);
});

/** Disconnects Google and erases everything SnapWall knows about this admin. Drive files are left untouched. */
me.delete('/', async (c) => {
  const owner = await requireOwner(c);
  if (owner.refresh_enc) await revokeToken(await decrypt(owner.refresh_enc, c.env.TOKEN_KEY));
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM uploads WHERE event_id IN (SELECT id FROM events WHERE owner_id = ?)').bind(owner.id),
    db.prepare('DELETE FROM events WHERE owner_id = ?').bind(owner.id),
    db.prepare('DELETE FROM sessions WHERE owner_id = ?').bind(owner.id),
    db.prepare('DELETE FROM owners WHERE id = ?').bind(owner.id),
  ]);
  return c.json({ ok: true });
});
