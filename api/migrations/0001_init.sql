-- SnapWall stores metadata only. Photos and videos live in each admin's own Google Drive.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  refresh_enc TEXT,            -- AES-GCM encrypted Google refresh token
  access_enc TEXT,             -- AES-GCM encrypted cached access token
  access_exp INTEGER NOT NULL DEFAULT 0,
  root_folder_id TEXT,         -- "SnapWall" folder in the owner's Drive
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, -- SHA-256 of the session token, never the token itself
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_owner ON sessions(owner_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT,
  folder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  guest_hash TEXT NOT NULL UNIQUE, -- lookup key for the guest link
  guest_enc TEXT NOT NULL,         -- encrypted guest token so the admin can re-show the QR
  admin_hash TEXT NOT NULL UNIQUE, -- admin link is shown once; only its hash is kept
  pin_hash TEXT,
  settings TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_owner ON events(owner_id);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done
  hidden INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT NOT NULL,                  -- salted hash, used only for rate limiting
  created_at INTEGER NOT NULL
);
CREATE INDEX uploads_event ON uploads(event_id, status, created_at);
CREATE INDEX uploads_rate ON uploads(event_id, ip_hash, created_at);
