import type {
  AdminEvent,
  CreatedEvent,
  DriveStorage,
  EventSettings,
  GuestCount,
  MediaFilter,
  MediaItem,
  MediaPage,
  Me,
  PublicEvent,
  UploadSlot,
} from '../../../shared/types';

export const API_URL = __API_URL__;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_KEY = 'snapwall.session';

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const session = {
  get: () => store()?.getItem(SESSION_KEY) ?? null,
  set: (token: string) => store()?.setItem(SESSION_KEY, token),
  clear: () => store()?.removeItem(SESSION_KEY),
};

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach SnapWall. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === 'signin_required') session.clear();
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong');
  }
  return data as T;
}

const authed = (): HeadersInit => {
  const s = session.get();
  return s ? { Authorization: `Bearer ${s}` } : {};
};

export const signInUrl = () => `${API_URL}/auth/google/start`;

export const owner = {
  me: () => request<Me>('/me', { headers: authed() }),
  storage: () => request<DriveStorage>('/me/storage', { headers: authed() }),
  logout: () => request('/auth/logout', { method: 'POST', headers: authed() }).finally(session.clear),
  disconnect: () => request('/me', { method: 'DELETE', headers: authed() }).finally(session.clear),
  create: (body: { name: string; date: string | null; settings: Partial<EventSettings>; pin?: string }) =>
    request<CreatedEvent>('/events', { method: 'POST', headers: authed(), json: body }),
};

export type EventPatch = Partial<{
  name: string;
  date: string | null;
  status: 'active' | 'disabled';
  settings: Partial<EventSettings>;
  pin: string | null;
}>;

/** Admin calls use the admin link token when present, otherwise the signed-in session. */
export function adminApi(eventId: string, adminToken: string | null) {
  const headers = (): HeadersInit => (adminToken ? { 'X-Admin-Token': adminToken } : authed());
  const base = `/events/${encodeURIComponent(eventId)}`;
  return {
    get: () => request<AdminEvent>(base, { headers: headers() }),
    update: (patch: EventPatch) => request<AdminEvent>(base, { method: 'PATCH', headers: headers(), json: patch }),
    rotate: (which: 'guest' | 'admin') => request<CreatedEvent>(`${base}/rotate`, { method: 'POST', headers: headers(), json: { which } }),
    remove: (trashFolder: boolean) => request(`${base}${trashFolder ? '?trash=1' : ''}`, { method: 'DELETE', headers: headers() }),
    media: (cursor?: string | null, filter: MediaFilter = 'all', by?: string | null) => {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (filter !== 'all') q.set('filter', filter);
      if (by) q.set('by', by);
      const qs = q.toString();
      return request<MediaPage>(`${base}/media${qs ? `?${qs}` : ''}`, { headers: headers() });
    },
    guests: () => request<GuestCount[]>(`${base}/guests`, { headers: headers() }),
    storage: () => request<DriveStorage>(`${base}/storage`, { headers: headers() }),
    /** Approves the given uploads, or everything awaiting approval when no ids are given. */
    approve: (ids?: string[]) =>
      request<{ approved: number }>(`${base}/media/approve`, { method: 'POST', headers: headers(), json: ids ? { ids } : {} }),
    setHidden: (id: string, hidden: boolean) =>
      request<MediaItem>(`${base}/media/${id}`, { method: 'PATCH', headers: headers(), json: { hidden } }),
    removeMedia: (id: string) => request(`${base}/media/${id}`, { method: 'DELETE', headers: headers() }),
  };
}

const GUEST_KEY = 'snapwall.guest';

/** A random ID for this browser, so per-guest upload limits don't lump together everyone on the venue's Wi-Fi. */
function guestId(): string | null {
  const s = store();
  let id = s?.getItem(GUEST_KEY) ?? null;
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    s?.setItem(GUEST_KEY, id);
  }
  return id;
}

export function guestApi(token: string, pin: () => string | null) {
  const headers = (): HeadersInit => {
    const h: Record<string, string> = {};
    const p = pin();
    if (p) h['X-Event-Pin'] = p;
    const id = guestId();
    if (id) h['X-Guest-Id'] = id;
    return h;
  };
  const base = `/g/${encodeURIComponent(token)}`;
  return {
    event: () => request<PublicEvent>(base, { headers: headers() }),
    media: (cursor?: string | null, by?: string | null) => {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (by) q.set('by', by);
      const qs = q.toString();
      return request<MediaPage>(`${base}/media${qs ? `?${qs}` : ''}`, { headers: headers() });
    },
    guests: () => request<GuestCount[]>(`${base}/guests`, { headers: headers() }),
    startUpload: (body: { name: string; size: number; mime: string; uploader: string | null }) =>
      request<UploadSlot>(`${base}/uploads`, { method: 'POST', headers: headers(), json: body }),
    completeUpload: (uploadId: string, fileId: string) =>
      request<MediaItem>(`${base}/uploads/${uploadId}/complete`, { method: 'POST', headers: headers(), json: { fileId } }),
    /**
     * Reads one server-sent event stream until the server ends it (about a minute), passing each message on:
     * the event's media version, or "closed". Uses fetch rather than EventSource so the PIN header can be sent.
     */
    live: async (onMessage: (data: string) => void, signal: AbortSignal) => {
      const res = await fetch(`${API_URL}${base}/live`, { headers: headers(), signal, referrerPolicy: 'no-referrer' });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong');
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';
        for (const m of messages) for (const line of m.split('\n')) if (line.startsWith('data:')) onMessage(line.slice(5).trim());
      }
    },
  };
}

export type GuestApi = ReturnType<typeof guestApi>;
