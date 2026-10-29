// Find me: matching a guest's selfie against the faces in an event's photos. Everything here runs in the browser,
// and nothing it computes is sent anywhere or kept after the page closes.

/** The 128 numbers the recognition model gives each face. Faces of the same person are close together. */
export type Descriptor = ArrayLike<number>;

/**
 * Faces closer than this count as the same person. The model's authors suggest 0.6, but in group photos other
 * people of a similar look came as close as 0.53, so this is stricter, at the cost of missing a few photos at odd angles.
 */
export const MATCH_DISTANCE = 0.5;

export class FaceError extends Error {
  constructor(public code: 'no_face' | 'model_failed') {
    super(code === 'no_face' ? 'No face found in that photo' : 'Face matching isn’t available on this device');
  }
}

export function distance(a: Descriptor, b: Descriptor): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Distance from the target to the closest face, or Infinity when there are none. */
export function closest(target: Descriptor, faces: Descriptor[]): number {
  return faces.reduce((best, f) => Math.min(best, distance(target, f)), Infinity);
}

/** The items with a face matching the target, in their original order. Items not scanned yet are left out. */
export function matching<T extends { id: string }>(target: Descriptor, items: T[], faces: Map<string, Descriptor[]>): T[] {
  return items.filter((item) => closest(target, faces.get(item.id) ?? []) < MATCH_DISTANCE);
}

/**
 * Finds the faces in every item not already in the cache. Downloads run a few at a time, but faces are found one
 * photo at a time, since the model shares one GPU. A photo that fails to load is skipped and tried again next time.
 */
export async function scanFaces<T extends { id: string }, B>(opts: {
  items: T[];
  cache: Map<string, Descriptor[]>;
  load: (item: T, signal: AbortSignal) => Promise<B>;
  detect: (image: B) => Promise<Descriptor[]>;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  prefetch?: number;
}): Promise<{ failed: number }> {
  const todo = opts.items.filter((i) => !opts.cache.has(i.id));
  const prefetch = opts.prefetch ?? 4;
  let failed = 0;
  // Each load is caught at once, so a download that fails while an earlier photo is being read isn't left unhandled.
  const start = (item: T) => opts.load(item, opts.signal).then((image) => ({ image }), () => null);
  const pending = todo.slice(0, prefetch).map(start);
  opts.onProgress?.(0, todo.length);
  for (let i = 0; i < todo.length; i++) {
    if (opts.signal.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const loaded = await pending[i];
    pending[i] = Promise.resolve(null);
    if (i + prefetch < todo.length) pending.push(start(todo[i + prefetch]));
    try {
      if (!loaded) throw new Error('not loaded');
      opts.cache.set(todo[i].id, await opts.detect(loaded.image));
    } catch {
      failed++;
    }
    opts.onProgress?.(i + 1, todo.length);
  }
  return { failed };
}
