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

function put(url: string, body: Blob, headers: Record<string, string>, onProgress?: (loaded: number) => void): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText, range: xhr.getResponseHeader('Range') });
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(body);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms / 2 + Math.random() * ms;

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

/**
 * Sends the bytes straight to Google Drive's resumable session. If the connection drops, asks
 * Google how much arrived and continues from there.
 */
async function sendToDrive(url: string, file: File, mime: string, onProgress: (fraction: number) => void): Promise<string> {
  let offset = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const chunk = offset ? file.slice(offset) : file;
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (offset) headers['Content-Range'] = `bytes ${offset}-${file.size - 1}/${file.size}`;
      const res = await put(url, chunk, headers, (loaded) => onProgress((offset + loaded) / file.size));
      if (res.status === 200 || res.status === 201) return (JSON.parse(res.body) as { id: string }).id;
      if (res.status === 404 || res.status === 410) throw new ApiError(res.status, 'upload_expired', 'Upload session expired');
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
    await wait(jitter(1000 * 2 ** attempt));
    // Ask Google how many bytes it already has.
    try {
      const status = await put(url, new Blob([]), { 'Content-Range': `bytes */${file.size}` });
      if (status.status === 200 || status.status === 201) return (JSON.parse(status.body) as { id: string }).id;
      const m = status.range?.match(/bytes=0-(\d+)/);
      offset = m ? Number(m[1]) + 1 : 0;
    } catch {
      offset = 0;
    }
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

export async function uploadFile(
  api: GuestApi,
  file: File,
  opts: { uploader: string | null; stripLocation: boolean; onWait?: (waiting: boolean) => void },
  onProgress: (fraction: number) => void,
): Promise<MediaItem> {
  const mime = mimeOf(file);
  const prepared = opts.stripLocation ? await stripMetadata(file, mime) : file;
  const slot = await whileBusy(() => api.startUpload({ name: file.name, size: prepared.size, mime, uploader: opts.uploader }), opts.onWait);
  const fileId = await sendToDrive(slot.uploadUrl, prepared, mime, onProgress);
  return whileBusy(() => api.completeUpload(slot.uploadId, fileId), opts.onWait);
}

/** Errors worth a Retry button: connection trouble, a busy Drive, or a full one the host may clear. Not a refusal. */
export const canRetry = (err: unknown) =>
  !(err instanceof ApiError) ||
  ['offline', 'upload_failed', 'upload_expired', 'drive_rate_limited', 'drive_error', 'storage_full'].includes(err.code);
