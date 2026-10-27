import { decrypt, encrypt } from './crypto';
import { HttpError, now, type Env, type OwnerRow } from './util';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// drive.file only grants access to files SnapWall itself created, never the rest of the Drive.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = ['openid', 'email', 'profile', DRIVE_SCOPE];

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

export function authUrl(env: Env, redirectUri: string, state: string, consent: boolean): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
  });
  if (consent) params.set('prompt', 'consent');
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as TokenResponse & { error?: string };
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new HttpError(409, 'drive_disconnected', 'Google access was revoked');
    throw new HttpError(502, 'google_token_error', data.error);
  }
  return data;
}

export function exchangeCode(env: Env, code: string, redirectUri: string) {
  return tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

/** The id_token comes straight from Google's token endpoint over TLS, so decoding without verifying is safe here. */
export function decodeIdToken(idToken: string): { sub: string; email: string; name: string | null } {
  const payload = idToken.split('.')[1];
  const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  return { sub: json.sub, email: json.email, name: json.name ?? null };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/** Returns a valid access token for the owner, refreshing and caching it when needed. */
export async function accessTokenFor(env: Env, owner: OwnerRow): Promise<string> {
  if (owner.access_enc && owner.access_exp > now() + 60) {
    return decrypt(owner.access_enc, env.TOKEN_KEY);
  }
  if (!owner.refresh_enc) throw new HttpError(409, 'drive_disconnected', 'Google Drive is not connected');
  let tok: TokenResponse;
  try {
    tok = await tokenRequest({
      refresh_token: await decrypt(owner.refresh_enc, env.TOKEN_KEY),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'drive_disconnected') {
      await env.DB.prepare('UPDATE owners SET refresh_enc = NULL, access_enc = NULL, access_exp = 0 WHERE id = ?').bind(owner.id).run();
    }
    throw err;
  }
  const accessEnc = await encrypt(tok.access_token, env.TOKEN_KEY);
  const exp = now() + tok.expires_in;
  await env.DB.prepare('UPDATE owners SET access_enc = ?, access_exp = ? WHERE id = ?').bind(accessEnc, exp, owner.id).run();
  owner.access_enc = accessEnc;
  owner.access_exp = exp;
  return tok.access_token;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
  thumbnailLink?: string;
}

export class Drive {
  constructor(private token: string) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.ok || res.status === 206) return res;
    let reason = '';
    try {
      const body = (await res.json()) as { error?: { errors?: { reason?: string }[]; message?: string } };
      reason = body.error?.errors?.[0]?.reason ?? body.error?.message ?? '';
    } catch {
      /* not JSON */
    }
    if (res.status === 404) throw new HttpError(404, 'drive_not_found', 'File no longer exists in Drive');
    if (res.status === 401) throw new HttpError(409, 'drive_disconnected', 'Google Drive access expired');
    if (reason === 'storageQuotaExceeded') throw new HttpError(507, 'storage_full', "The host's Drive is full");
    if (res.status === 403 && /rate/i.test(reason)) throw new HttpError(429, 'drive_rate_limited', 'Drive is busy, try again shortly');
    throw new HttpError(502, 'drive_error', reason || `Drive returned ${res.status}`);
  }

  async createFolder(name: string, parent?: string): Promise<string> {
    const res = await this.call(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }),
    });
    return ((await res.json()) as DriveFile).id;
  }

  async getFile(id: string, fields: string): Promise<DriveFile> {
    const res = await this.call(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
    return (await res.json()) as DriveFile;
  }

  async trash(id: string): Promise<void> {
    await this.call(`${DRIVE}/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /**
   * Opens a resumable upload session and returns its URL. That URL lets the holder upload the
   * bytes of exactly this one file, so the guest's browser can send media straight to Google.
   * Passing the web app's Origin makes Google answer the browser's PUT with CORS headers.
   */
  async startUpload(opts: {
    name: string;
    mimeType: string;
    size: number;
    parent: string;
    origin: string;
    description: string;
    appProperties: Record<string, string>;
  }): Promise<string> {
    const res = await this.call(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': opts.mimeType,
        'X-Upload-Content-Length': String(opts.size),
        Origin: opts.origin,
      },
      body: JSON.stringify({
        name: opts.name,
        parents: [opts.parent],
        mimeType: opts.mimeType,
        description: opts.description,
        appProperties: opts.appProperties,
      }),
    });
    const location = res.headers.get('Location');
    if (!location) throw new HttpError(502, 'drive_error', 'Drive did not return an upload URL');
    return location;
  }

  media(id: string, range?: string | null): Promise<Response> {
    return this.call(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, {
      headers: range ? { Range: range } : {},
    });
  }

  thumbnail(link: string, size: number): Promise<Response> {
    return this.call(link.replace(/=s\d+$/, '') + `=s${size}`);
  }
}

export async function driveFor(env: Env, owner: OwnerRow): Promise<Drive> {
  return new Drive(await accessTokenFor(env, owner));
}

export async function ensureRootFolder(env: Env, owner: OwnerRow, drive: Drive): Promise<string> {
  if (owner.root_folder_id) {
    try {
      const f = await drive.getFile(owner.root_folder_id, 'id,trashed');
      if (!f.trashed) return f.id;
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'drive_not_found')) throw err;
    }
  }
  const id = await drive.createFolder('SnapWall');
  await env.DB.prepare('UPDATE owners SET root_folder_id = ? WHERE id = ?').bind(id, owner.id).run();
  owner.root_folder_id = id;
  return id;
}
