import { makeZip } from 'client-zip';
import type { MediaItem } from '../../../shared/types';
import { saveBlob } from './format';

export interface ZipProgress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

export interface ZipResult {
  saved: number;
  failed: number;
}

interface SaveFilePicker {
  showSaveFilePicker(opts: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

/** Chrome and Edge on desktop can write the ZIP straight to disk; elsewhere it is built in memory first. */
export const streamsToDisk = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

/**
 * Downloads media into one ZIP. The save dialog opens first (it needs the click that started this),
 * then `list` supplies the items. `refresh` re-issues signed links if they expire during a long download.
 * `folder` optionally groups files into folders inside the ZIP. Returns null if the user cancels the dialog.
 */
export async function zipMedia(opts: {
  filename: string;
  list: () => Promise<MediaItem[]>;
  refresh?: () => Promise<MediaItem[]>;
  folder?: (item: MediaItem) => string | null;
  signal: AbortSignal;
  onProgress: (p: ZipProgress) => void;
}): Promise<ZipResult | null> {
  const filename = safeFileName(opts.filename);
  let target: WritableStream<Uint8Array> | null = null;
  if (streamsToDisk) {
    try {
      const handle = await (window as unknown as SaveFilePicker).showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      target = await handle.createWritable();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      throw err;
    }
  }

  let items: MediaItem[];
  try {
    items = await opts.list();
  } catch (err) {
    await target?.abort();
    throw err;
  }
  const progress: ZipProgress = { done: 0, total: items.length, bytes: 0, totalBytes: items.reduce((s, i) => s + i.size, 0) };
  opts.onProgress({ ...progress });
  let failed = 0;

  const used = new Map<string, number>();
  const unique = (path: string) => {
    const key = path.toLowerCase();
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return n ? path.replace(/(\.[^./]*)?$/, ` (${n})$1`) : path;
  };

  let fresh: Map<string, MediaItem> | null = null;
  async function get(item: MediaItem): Promise<Response | null> {
    const url = fresh?.get(item.id)?.download ?? item.download;
    if (!url) return null;
    const res = await fetch(url, { referrerPolicy: 'no-referrer', signal: opts.signal });
    // Signed links last 30–60 minutes. On expiry, fetch new ones once and retry.
    if (res.status === 403 && opts.refresh && !fresh) {
      fresh = new Map((await opts.refresh()).map((i) => [i.id, i]));
      return get(item);
    }
    return res.ok && res.body ? res : null;
  }

  async function* files() {
    for (const item of items) {
      opts.signal.throwIfAborted();
      let res: Response | null = null;
      try {
        res = await get(item);
      } catch (err) {
        if (opts.signal.aborted) throw err;
      }
      if (!res) {
        failed++;
        progress.done++;
        progress.bytes += item.size;
        opts.onProgress({ ...progress });
        continue;
      }
      const counted = res.body!.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl) {
            progress.bytes += chunk.byteLength;
            opts.onProgress({ ...progress });
            ctl.enqueue(chunk);
          },
        }),
      );
      const dir = opts.folder?.(item);
      yield { name: unique(dir ? `${safeFileName(dir)}/${item.name}` : item.name), input: counted, lastModified: new Date(item.createdAt * 1000) };
      progress.done++;
    }
  }

  const zip = makeZip(files());
  if (target) {
    await zip.pipeTo(target, { signal: opts.signal });
  } else {
    const blob = await new Response(zip).blob();
    opts.signal.throwIfAborted();
    saveBlob(blob, filename);
  }
  progress.done = progress.total;
  opts.onProgress({ ...progress });
  return { saved: items.length - failed, failed };
}
