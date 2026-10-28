-- Per-guest upload limits. guest_hash is a salted, per-event hash of the guest's device ID (or IP for older clients).
ALTER TABLE uploads ADD COLUMN guest_hash TEXT;
CREATE INDEX uploads_guest ON uploads(event_id, guest_hash, created_at);
