import type { MediaItem } from '../../../shared/types';
import { ApiError, type GuestApi } from './api';
import { stripMetadata } from './metadata';

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
};

/** Some browsers leave File.type empty for HEIC or MOV; fall back to the extension. */
export function mimeOf(file: File): string {
  if (file.type) return file.type.toLowerCase();
  return EXT_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

interface PutResult {
  status: number;
  body: string;
  range: string | null;
}

/** A send with no progress for this long counts as a dropped connection, which phone networks can leave hanging. */
export const STALL_MS = 60_000;

function put(url: string, body: Blob, headers: Record<string, string>, onProgress?: (loaded: number) => void): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), STALL_MS);
    };
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      watch();
      onProgress?.(e.loaded);
    };
    xhr.onload = () => {
      clearTimeout(timer);
      resolve({ status: xhr.status, body: xhr.responseText, range: xhr.getResponseHeader('Range') });
    };
    xhr.onerror = xhr.onabort = () => {
      clearTimeout(timer);
      reject(new Error('network'));
    };
    watch();
    xhr.send(body);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms / 2 + Math.random() * ms;
/** Only a definite "offline" counts; where the browser can't tell, it's treated as online. */
const offline = () => navigator.onLine === false;
/** Resolves once the device has a connection again, so tries aren't used up while it has none. */
const online = () => new Promise<void>((r) => addEventListener('online', () => r(), { once: true }));

export const STORAGE_FULL = 'The host’s Google Drive is full, so uploads can’t be saved right now. Let the host know.';

/** Google's reason for refusing a PUT, such as storageQuotaExceeded or userRateLimitExceeded. */
function reasonOf(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: { errors?: { reason?: string }[] } };
    return data.error?.errors?.[0]?.reason ?? '';
  } catch {
    return '';
  }
}

const expired = (status: number) => new ApiError(status, 'upload_expired', 'Upload session expired');

/** Asks Google how much of the file it already has: the Drive file ID once all of it arrived, else the next byte to send. */
async function received(url: string, size: number): Promise<string | number> {
  try {
    const status = await put(url, new Blob([]), { 'Content-Range': `bytes */${size}` });
    if (status.status === 200 || status.status === 201) return (JSON.parse(status.body) as { id: string }).id;
    if (status.status === 404 || status.status === 410) throw expired(status.status);
    const m = status.range?.match(/bytes=0-(\d+)/);
    return m ? Number(m[1]) + 1 : 0;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return 0;
  }
}

/**
 * Sends the bytes straight to Google Drive's resumable session. If the connection drops, asks
 * Google how much arrived and continues from there. A session kept from an earlier try starts with that question.
 */
async function sendToDrive(url: string, file: File, mime: string, onProgress: (fraction: number) => void, resume = false): Promise<string> {
  let offset = 0;
  if (resume) {
    const got = await received(url, file.size);
    if (typeof got === 'string') return got;
    offset = got;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const chunk = offset ? file.slice(offset) : file;
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (offset) headers['Content-Range'] = `bytes ${offset}-${file.size - 1}/${file.size}`;
      const res = await put(url, chunk, headers, (loaded) => onProgress((offset + loaded) / file.size));
      if (res.status === 200 || res.status === 201) return (JSON.parse(res.body) as { id: string }).id;
      if (res.status === 404 || res.status === 410) throw expired(res.status);
      const reason = reasonOf(res.body);
      if (reason === 'storageQuotaExceeded') throw new ApiError(res.status, 'storage_full', STORAGE_FULL);
      // Drive asking us to slow down is retried below, like a dropped connection.
      const slowDown = res.status === 429 || (res.status === 403 && /rate/i.test(reason));
      if (res.status < 500 && res.status !== 308 && res.status !== 0 && !slowDown) {
        throw new ApiError(res.status, 'drive_rejected', 'Google Drive rejected the file');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
    if (offline()) {
      await online();
      attempt--;
    } else {
      await wait(jitter(1000 * 2 ** attempt));
    }
    const got = await received(url, file.size);
    if (typeof got === 'string') return got;
    offset = got;
  }
  throw new ApiError(0, 'upload_failed', 'Upload failed. Check your connection and try again.');
}

/** Pauses between tries when Drive stays busy after the API's own quick retries, as when a whole room uploads at once. */
export const BUSY_DELAYS_MS = [2000, 5000, 12000];

/** Codes the API returns when Drive was throttling or briefly failing. Both are thrown before anything is saved. */
const isBusy = (err: unknown) => err instanceof ApiError && (err.code === 'drive_rate_limited' || err.code === 'drive_error');

async function whileBusy<T>(fn: () => Promise<T>, onWait?: (waiting: boolean) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusy(err) || attempt === BUSY_DELAYS_MS.length) throw err;
      onWait?.(true);
      await wait(jitter(BUSY_DELAYS_MS[attempt]));
      onWait?.(false);
    }
  }
}

/** How far a try got. The caller keeps it so a retry carries on from there instead of sending everything again. */
export interface UploadState {
  prepared?: File;
  slot?: { uploadId: string; uploadUrl: string };
  fileId?: string;
}

export async function uploadFile(
  api: GuestApi,
  file: File,
  opts: { uploader: string | null; stripLocation: boolean; onWait?: (waiting: boolean) => void },
  onProgress: (fraction: number) => void,
  state: UploadState = {},
): Promise<MediaItem> {
  const mime = mimeOf(file);
  const prepared = (state.prepared ??= opts.stripLocation ? await stripMetadata(file, mime) : file);
  const resume = !!state.slot;
  const slot = (state.slot ??= await whileBusy(
    () => api.startUpload({ name: file.name, size: prepared.size, mime, uploader: opts.uploader }),
    opts.onWait,
  ));
  try {
    state.fileId ??= await sendToDrive(slot.uploadUrl, prepared, mime, onProgress, resume);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'upload_expired')) throw err;
    state.slot = undefined;
    // Google keeps a session for a week. One kept from an earlier try that ran out is swapped for a new one.
    if (resume) return uploadFile(api, file, opts, onProgress, state);
    throw err;
  }
  const fileId = state.fileId;
  return whileBusy(() => api.completeUpload(slot.uploadId, fileId), opts.onWait);
}

/** Connection trouble or a busy Drive, which clear up by themselves, so the upload tries again without being asked. */
export const retriesItself = (err: unknown) =>
  err instanceof ApiError && ['offline', 'upload_failed', 'upload_expired', 'drive_rate_limited', 'drive_error'].includes(err.code);

/** Errors worth a Retry button: connection trouble, a busy Drive, or a full one the host may clear. Not a refusal. */
export const canRetry = (err: unknown) =>
  !(err instanceof ApiError) ||
  ['offline', 'upload_failed', 'upload_expired', 'drive_rate_limited', 'drive_error', 'storage_full'].includes(err.code);
