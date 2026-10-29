import type { DriveStorage } from '../../../shared/types';

export function formatDate(date: string | null): string {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function timeAgo(seconds: number): string {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "250 MB", "1.5 GB" from megabytes. */
export function sizeLabel(mb: number): string {
  return mb >= 1000 ? `${+(mb / 1000).toFixed(1)} GB` : `${Math.max(0, Math.floor(mb))} MB`;
}

export const isVideo = (mime: string) => mime.startsWith('video/');

/** Drive's own units: "15 GB" is 15 GiB, so use powers of 1024 to match what Google shows the host. */
export function bytesLabel(bytes: number): string {
  const gb = bytes / 2 ** 30;
  return gb >= 1 ? `${+gb.toFixed(1)} GB` : `${Math.max(0, Math.floor(bytes / 2 ** 20))} MB`;
}

/** Under this much free space, a phone video or two can no longer be saved. */
const FULL_BYTES = 100 * 2 ** 20;
const LOW_BYTES = 2 * 2 ** 30;

/** Whether the host should be warned about Drive space: "full", "low", or null when there's room (or no limit). */
export function driveSpace(s: DriveStorage): { level: 'full' | 'low'; free: string; total: string } | null {
  if (s.limit === null || s.limit <= 0) return null;
  const free = s.limit - s.usage;
  if (free >= LOW_BYTES && s.usage / s.limit < 0.9) return null;
  return { level: free < FULL_BYTES ? 'full' : 'low', free: bytesLabel(free), total: bytesLabel(s.limit) };
}
