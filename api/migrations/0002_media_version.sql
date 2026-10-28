-- Bumped whenever an event's visible media changes, so open slideshows can update live with a one-row read.
ALTER TABLE events ADD COLUMN media_version INTEGER NOT NULL DEFAULT 0;
