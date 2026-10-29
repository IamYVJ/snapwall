import type { Context } from 'hono';
import type { EventSettings, EventStatus } from '../../shared/types';

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 32 random bytes, base64. Encrypts Google tokens and guest tokens at rest. */
  TOKEN_KEY: string;
  /** Random string. Signs short-lived media URLs and salts IP hashes. */
  SIGNING_KEY: string;
  /** Comma-separated origins allowed to call the API, e.g. https://you.github.io */
  ALLOWED_ORIGINS: string;
  /** Where the web app lives, with trailing slash, e.g. https://you.github.io/snapwall/ */
  WEB_BASE_URL: string;
}

export type AppEnv = { Bindings: Env };
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const now = () => Math.floor(Date.now() / 1000);

/** Tells open slideshows that the event's media changed. */
export const bumpMedia = (db: D1Database, eventId: string) =>
  db.prepare('UPDATE events SET media_version = media_version + 1 WHERE id = ?').bind(eventId);

export interface OwnerRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  refresh_enc: string | null;
  access_enc: string | null;
  access_exp: number;
  root_folder_id: string | null;
  created_at: number;
}

export interface EventRow {
  id: string;
  owner_id: string;
  name: string;
  date: string | null;
  folder_id: string;
  status: EventStatus;
  guest_hash: string;
  guest_enc: string;
  admin_hash: string;
  pin_hash: string | null;
  settings: string;
  media_version: number;
  created_at: number;
}

export interface UploadRow {
  id: string;
  event_id: string;
  file_id: string | null;
  name: string;
  mime: string;
  size: number;
  uploader: string | null;
  status: 'pending' | 'done';
  hidden: number;
  /** 1 while awaiting the host's approval. */
  review: number;
  ip_hash: string;
  guest_hash: string | null;
  created_at: number;
}

export const DEFAULT_SETTINGS: EventSettings = {
  guestView: true,
  guestDownload: true,
  allowVideo: true,
  moderation: false,
  uploadsOpen: true,
  maxFileMB: 500,
  requireName: false,
  stripLocation: true,
  faceSearch: false,
  expiresAt: null,
  guestMaxFiles: null,
  guestMaxMB: null,
};

export const MAX_FILE_MB = 5000;

/** null, or a whole number clamped to [1, max]. Anything else leaves the current value. */
function cleanLimit(value: unknown, current: number | null, max: number): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(max, Math.max(1, Math.round(value)));
  return current;
}

export function parseSettings(json: string): EventSettings {
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(json) as Partial<EventSettings>) };
}

/** Merges untrusted input onto existing settings, keeping only well-typed fields. */
export function mergeSettings(base: EventSettings, input: unknown): EventSettings {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const key of ['guestView', 'guestDownload', 'allowVideo', 'moderation', 'uploadsOpen', 'requireName', 'stripLocation', 'faceSearch'] as const) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  if (typeof src.maxFileMB === 'number' && Number.isFinite(src.maxFileMB)) {
    out.maxFileMB = Math.min(MAX_FILE_MB, Math.max(1, Math.round(src.maxFileMB)));
  }
  if ('guestMaxFiles' in src) out.guestMaxFiles = cleanLimit(src.guestMaxFiles, out.guestMaxFiles, 10_000);
  if ('guestMaxMB' in src) out.guestMaxMB = cleanLimit(src.guestMaxMB, out.guestMaxMB, 1_000_000);
  if (src.expiresAt === null || (typeof src.expiresAt === 'number' && Number.isFinite(src.expiresAt))) {
    out.expiresAt = src.expiresAt as number | null;
  }
  if (!out.guestView) out.guestDownload = false;
  return out;
}

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || null;
}

export function cleanDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function uploadsAccepting(settings: EventSettings): boolean {
  return settings.uploadsOpen && (settings.expiresAt === null || settings.expiresAt > now());
}

export async function readJson<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}
