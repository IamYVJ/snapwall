// Runs the real Worker in Node against an in-memory local D1 with every migration applied. Google is never called:
// tests stop at checks that run before Drive, and owners have no Drive tokens (Drive calls answer drive_disconnected).
import { readFileSync, readdirSync } from 'node:fs';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import type { EventSettings } from '../../shared/types';
import { encrypt, randomToken, sha256 } from '../src/crypto';
import { pinHash } from '../src/events';
import worker from '../src/index';
import { DEFAULT_SETTINGS, now, type Env, type UploadRow } from '../src/util';

export const ORIGIN = 'https://guests.example';

export async function startHarness() {
  const proxy = await getPlatformProxy<Env>({ configPath: 'wrangler.toml', persist: false, remoteBindings: false, envFiles: [] });
  const env: Env = {
    ...proxy.env,
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    SIGNING_KEY: 'test-signing-key',
    ALLOWED_ORIGINS: ORIGIN,
    WEB_BASE_URL: `${ORIGIN}/snapwall/`,
  };
  for (const file of readdirSync('migrations').sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(`migrations/${file}`, 'utf8'))) await env.DB.prepare(sql).run();
  }

  /** Calls the Worker. `json` becomes the body; the response body is parsed when it is JSON. */
  async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set('Content-Type', 'application/json');
    const res = await worker.fetch(
      new Request(path.startsWith('http') ? path : `https://api.test${path}`, {
        ...init,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      }),
      env,
      proxy.ctx as ExecutionContext,
    );
    const body = res.headers.get('Content-Type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, headers: res.headers, body: body as any };
  }

  async function reset() {
    await env.DB.batch(['uploads', 'sessions', 'events', 'owners'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  }

  /** An owner (without Drive access) and one event. Returns the tokens a guest and an admin would hold. */
  async function seedEvent(opts: { settings?: Partial<EventSettings>; pin?: string; status?: 'active' | 'disabled' } = {}) {
    const ownerId = randomToken(6);
    const id = randomToken(9);
    const guestToken = randomToken(24);
    const adminToken = randomToken(32);
    await env.DB.prepare(`INSERT INTO owners (id, google_sub, email, name, created_at) VALUES (?, ?, 'host@example.com', 'Host', ?)`)
      .bind(ownerId, ownerId, now())
      .run();
    await env.DB.prepare(
      `INSERT INTO events (id, owner_id, name, date, folder_id, status, guest_hash, guest_enc, admin_hash, pin_hash, settings, created_at)
       VALUES (?, ?, 'Test Event', NULL, 'folder', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        ownerId,
        opts.status ?? 'active',
        await sha256(guestToken),
        await encrypt(guestToken, env.TOKEN_KEY),
        await sha256(adminToken),
        opts.pin ? await pinHash(id, opts.pin) : null,
        JSON.stringify({ ...DEFAULT_SETTINGS, ...opts.settings }),
        now(),
      )
      .run();
    return { id, guestToken, adminToken, admin: { 'X-Admin-Token': adminToken } };
  }

  let seq = 0;
  /** A finished upload. Later calls get later timestamps so list order is predictable (newest first). */
  async function seedUpload(eventId: string, fields: Partial<UploadRow> = {}) {
    const u: UploadRow = {
      id: `u${++seq}`,
      event_id: eventId,
      file_id: `file${seq}`,
      name: `photo${seq}.jpg`,
      mime: 'image/jpeg',
      size: 1000,
      uploader: null,
      status: 'done',
      hidden: 0,
      review: 0,
      ip_hash: 'ip',
      guest_hash: null,
      created_at: now() - 1000 + seq,
      ...fields,
    };
    await env.DB.prepare(
      `INSERT INTO uploads (id, event_id, file_id, name, mime, size, uploader, status, hidden, review, ip_hash, guest_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(u.id, u.event_id, u.file_id, u.name, u.mime, u.size, u.uploader, u.status, u.hidden, u.review, u.ip_hash, u.guest_hash, u.created_at)
      .run();
    return u;
  }

  /** The hash the API stores for a guest who sends this X-Guest-Id. */
  const guestHash = (deviceId: string, eventId: string) => sha256(`guest:${deviceId}:${eventId}:${env.SIGNING_KEY}`);

  return { env, call, reset, seedEvent, seedUpload, guestHash, dispose: () => proxy.dispose() };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;
