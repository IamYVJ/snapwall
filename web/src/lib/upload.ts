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
      if (res.status < 500 && res.status !== 308 && res.status !== 0) throw new ApiError(res.status, 'drive_rejected', 'Google Drive rejected the file');
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
    await wait(1000 * 2 ** attempt);
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

export async function uploadFile(
  api: GuestApi,
  file: File,
  opts: { uploader: string | null; stripLocation: boolean },
  onProgress: (fraction: number) => void,
): Promise<MediaItem> {
  const mime = mimeOf(file);
  const prepared = opts.stripLocation ? await stripMetadata(file) : file;
  const slot = await api.startUpload({ name: file.name, size: prepared.size, mime, uploader: opts.uploader });
  const fileId = await sendToDrive(slot.uploadUrl, prepared, mime, onProgress);
  return api.completeUpload(slot.uploadId, fileId);
}
