-- Content fingerprint for duplicate detection and integrity tracking.
-- content_hash = sha256("<size>|<part sha256>,<part sha256>,...") — stable for identical
-- content uploaded with the same PART_SIZE_MB.
ALTER TABLE blobs ADD COLUMN content_hash TEXT;
CREATE INDEX ix_blobs_content_hash ON blobs(content_hash) WHERE content_hash IS NOT NULL;

-- Last successful end-to-end integrity check (re-downloaded from Telegram and re-hashed).
ALTER TABLE blobs ADD COLUMN verified_at INTEGER;

CREATE INDEX ix_files_size ON files(size) WHERE trashed_at IS NULL AND status = 'ready';
