// API contract shared by the Worker (api/) and the web app (web/).

export type EventStatus = 'active' | 'disabled';

export interface EventSettings {
  /** Guests can see the wall (otherwise upload-only). */
  guestView: boolean;
  /** Guests can download originals. Requires guestView. */
  guestDownload: boolean;
  /** Accept videos as well as photos. */
  allowVideo: boolean;
  /** New uploads stay hidden until the admin approves them. */
  moderation: boolean;
  /** Uploads can be paused while the wall stays visible. */
  uploadsOpen: boolean;
  /** Per-file size limit in megabytes. */
  maxFileMB: number;
  /** Guests must enter a name before uploading. */
  requireName: boolean;
  /** Remove GPS/EXIF metadata from photos in the browser before upload. */
  stripLocation: boolean;
  /** Unix seconds after which uploads close automatically. */
  expiresAt: number | null;
}

export interface Me {
  email: string;
  name: string | null;
  events: EventSummary[];
}

export interface EventSummary {
  id: string;
  name: string;
  date: string | null;
  status: EventStatus;
  count: number;
  createdAt: number;
}

export interface AdminEvent extends EventSummary {
  settings: EventSettings;
  hasPin: boolean;
  guestToken: string;
  folderUrl: string;
  ownerEmail: string;
}

/** Returned once on create and on admin-link rotation. */
export interface CreatedEvent {
  event: AdminEvent;
  adminToken: string;
}

export interface PublicEvent {
  id: string;
  name: string;
  date: string | null;
  count: number;
  settings: Pick<
    EventSettings,
    'guestView' | 'guestDownload' | 'allowVideo' | 'uploadsOpen' | 'maxFileMB' | 'requireName' | 'stripLocation' | 'moderation'
  >;
}

export interface MediaItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploader: string | null;
  createdAt: number;
  hidden: boolean;
  thumb: string;
  full: string;
  download: string | null;
}

export interface MediaPage {
  items: MediaItem[];
  next: string | null;
}

export interface UploadSlot {
  uploadId: string;
  uploadUrl: string;
}

export interface ApiError {
  error: string;
  message?: string;
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/x-m4v'];
