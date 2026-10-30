-- Drive's MD5 checksum of each finished upload, so an exact copy of a file already in the event is skipped.
ALTER TABLE uploads ADD COLUMN md5 TEXT;
CREATE INDEX uploads_md5 ON uploads(event_id, md5);
