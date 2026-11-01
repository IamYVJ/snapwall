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

/** How much may download ahead of the file being taken, so the wait before each file starts overlaps the others. */
const AHEAD_BYTES = 100 * 1024 * 1024;

/**
 * Fetches the files in order, several at once: more are started while the ones not yet taken add up to 100 MB, and
 * what arrives early waits in memory. A file bigger than that downloads on its own. `body` is null for a file that
 * couldn't be fetched. `refresh` re-issues signed links if they expire during a long download.
 */
async function* fetchAll(
  items: MediaItem[],
  opts: { refresh?: () => Promise<MediaItem[]>; signal: AbortSignal; onBytes: (n: number) => void },
): AsyncGenerator<{ item: MediaItem; body: ReadableStream<Uint8Array> | null }> {
  // Also stops the downloads still going when the caller gives up early or fails.
  const stop = new AbortController();
  const abort = () => stop.abort(opts.signal.reason);
  opts.signal.addEventListener('abort', abort, { once: true });

  let fresh: Promise<Map<string, MediaItem>> | null = null;
  async function get(item: MediaItem, retry = true): Promise<Response | null> {
    const url = (fresh && (await fresh).get(item.id)?.download) || item.download;
    if (!url) return null;
    const res = await fetch(url, { referrerPolicy: 'no-referrer', signal: stop.signal });
    // Signed links last 30–60 minutes. On expiry, new ones are fetched once and the file is tried again.
    if (res.status === 403 && opts.refresh && retry) {
      fresh ??= opts.refresh().then((all) => new Map(all.map((i) => [i.id, i])));
      return get(item, false);
    }
    return res.ok && res.body ? res : null;
  }

  async function open(item: MediaItem): Promise<ReadableStream<Uint8Array> | null> {
    let res: Response | null = null;
    try {
      res = await get(item);
    } catch (err) {
      if (stop.signal.aborted) throw err;
    }
    if (!res) return null;
    // A queue as big as the file lets it download in full while earlier files are still being taken.
    return res.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>(
        {
          transform(chunk, ctl) {
            opts.onBytes(chunk.byteLength);
            ctl.enqueue(chunk);
          },
        },
        undefined,
        { highWaterMark: Math.max(item.size, 1), size: (chunk) => chunk.byteLength },
      ),
    );
  }

  const started: Promise<ReadableStream<Uint8Array> | null>[] = [];
  let ahead = 0;
  function fill() {
    while (started.length < items.length) {
      const item = items[started.length];
      if (ahead && ahead + item.size > AHEAD_BYTES) return;
      ahead += item.size;
      const body = open(item);
      body.catch(() => undefined); // awaited in turn below; this keeps an early failure from going unhandled
      started.push(body);
    }
  }

  try {
    for (let i = 0; i < items.length; i++) {
      opts.signal.throwIfAborted();
      fill();
      yield { item: items[i], body: await started[i] };
      ahead -= items[i].size;
    }
  } finally {
    opts.signal.removeEventListener('abort', abort);
    stop.abort();
  }
}

/** Gives repeated names a number, "IMG (1).jpg", ignoring case. */
function namer() {
  const used = new Map<string, number>();
  return (path: string) => {
    const key = path.toLowerCase();
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return n ? path.replace(/(\.[^./]*)?$/, ` (${n})$1`) : path;
  };
}

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
  const unique = namer();

  async function* files() {
    const fetched = fetchAll(items, {
      refresh: opts.refresh,
      signal: opts.signal,
      onBytes: (n) => {
        progress.bytes += n;
        opts.onProgress({ ...progress });
      },
    });
    for await (const { item, body } of fetched) {
      if (!body) {
        failed++;
        progress.done++;
        progress.bytes += item.size;
        opts.onProgress({ ...progress });
        continue;
      }
      const dir = opts.folder?.(item);
      yield { name: unique(dir ? `${safeFileName(dir)}/${item.name}` : item.name), input: body, lastModified: new Date(item.createdAt * 1000) };
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

/** Downloads media as separate files, for the iPhone share sheet, which saves them straight to Photos. */
export async function collectMedia(opts: {
  items: MediaItem[];
  signal: AbortSignal;
  onProgress: (p: ZipProgress) => void;
}): Promise<{ files: File[]; failed: number }> {
  const { items } = opts;
  const progress: ZipProgress = { done: 0, total: items.length, bytes: 0, totalBytes: items.reduce((s, i) => s + i.size, 0) };
  opts.onProgress({ ...progress });
  const files: File[] = [];
  const unique = namer();
  const fetched = fetchAll(items, {
    signal: opts.signal,
    onBytes: (n) => {
      progress.bytes += n;
      opts.onProgress({ ...progress });
    },
  });
  for await (const { item, body } of fetched) {
    if (body) {
      const blob = await new Response(body).blob();
      files.push(new File([blob], unique(item.name), { type: item.mime, lastModified: item.createdAt * 1000 }));
    } else progress.bytes += item.size;
    progress.done++;
    opts.onProgress({ ...progress });
  }
  return { files, failed: items.length - files.length };
}

/** Files already downloaded, as one ZIP. */
export const zipFiles = (files: File[]): Promise<Blob> => new Response(makeZip(files)).blob();
