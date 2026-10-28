-- 1 while an upload waits for the host's approval (the "Approve uploads first" setting). Such uploads are also hidden.
ALTER TABLE uploads ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
