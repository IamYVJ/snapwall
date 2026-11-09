-- Wrong PINs, so guessing an event's PIN is slowed to a crawl. source is a salted, per-event hash of the guest's network.
CREATE TABLE pin_failures (
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pin_failures_lookup ON pin_failures(event_id, source, created_at);
