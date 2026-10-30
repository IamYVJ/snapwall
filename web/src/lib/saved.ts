/** An event this device has opened through a guest or co-host link, kept so the home page can list it. */
export interface SavedEvent {
  id: string;
  name: string;
  date: string | null;
  /** The route that opens it, e.g. e/<token> or a/<id>/<token>. */
  path: string;
  role: 'guest' | 'admin';
  /** When this device last opened it, in ms. */
  seen: number;
}

/** What the installed app is started with on iOS, where it doesn't share storage with Safari. */
export interface Handoff {
  events: SavedEvent[];
  session: string | null;
  /** The page the app was installed from. */
  to: string;
}

/**
 * Adds or updates one event. An admin link outranks a guest link to the same event, since it opens more; a newer
 * link of the same kind replaces the old one, which a rotation may have broken.
 */
export function upsert(list: SavedEvent[], e: SavedEvent): SavedEvent[] {
  const old = list.find((x) => x.id === e.id);
  const keep = old && old.role === 'admin' && e.role === 'guest' ? { ...old, name: e.name, date: e.date, seen: e.seen } : e;
  return [keep, ...list.filter((x) => x.id !== e.id)].sort((a, b) => b.seen - a.seen);
}

export function merge(list: SavedEvent[], incoming: SavedEvent[]): SavedEvent[] {
  return incoming.reduce((acc, e) => {
    const old = acc.find((x) => x.id === e.id);
    return old && old.seen >= e.seen && !(old.role === 'guest' && e.role === 'admin') ? acc : upsert(acc, e);
  }, list);
}

const toBase64Url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64Url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

// Short keys keep the home-screen link compact.
export function encodeHandoff(h: Handoff): string {
  return toBase64Url(
    JSON.stringify({ e: h.events.map((e) => [e.id, e.name, e.date, e.path, e.role === 'admin' ? 1 : 0, e.seen]), s: h.session, t: h.to }),
  );
}

/** Returns null for anything that isn't a handoff, so a mangled link just opens the home page. */
export function decodeHandoff(code: string): Handoff | null {
  try {
    const raw = JSON.parse(fromBase64Url(code));
    if (!Array.isArray(raw.e)) return null;
    const events: SavedEvent[] = raw.e
      .filter((r: unknown) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[3] === 'string' && /^(e|a)\//.test(r[3]))
      .map((r: unknown[]) => ({
        id: r[0] as string,
        name: String(r[1] ?? ''),
        date: typeof r[2] === 'string' ? r[2] : null,
        path: r[3] as string,
        role: r[4] === 1 ? 'admin' : 'guest',
        seen: Number(r[5]) || 0,
      }));
    return {
      events,
      session: typeof raw.s === 'string' ? raw.s : null,
      to: typeof raw.t === 'string' && /^(e|a|manage)\//.test(raw.t) ? raw.t : '',
    };
  } catch {
    return null;
  }
}

/** The guest or admin route in a pasted SnapWall link, or null if the text doesn't contain one. */
export function linkRoute(text: string): string | null {
  const m = text.match(/#\/((?:e\/[\w-]+)|(?:a\/[\w-]+\/[\w-]+))/);
  return m ? m[1] : null;
}
