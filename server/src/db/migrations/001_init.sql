CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  trash_root INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_folders_name ON folders(COALESCE(parent_id,''), name COLLATE NOCASE) WHERE trashed_at IS NULL;
CREATE INDEX ix_folders_parent ON folders(parent_id, trashed_at);
CREATE INDEX ix_folders_trash ON folders(trash_root, trashed_at);

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading','processing','ready','failed')),
  created_at INTEGER NOT NULL
);

CREATE TABLE parts (
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','received','uploading','stored','failed')),
  bot_id TEXT,
  message_id INTEGER,
  tg_file_id TEXT,
  tg_file_unique_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER,
  PRIMARY KEY (blob_id, idx)
);
CREATE INDEX ix_parts_status ON parts(status, next_attempt_at);
CREATE INDEX ix_parts_message ON parts(message_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  blob_id TEXT REFERENCES blobs(id),
  name TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  category TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading','processing','ready','failed')),
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  duration REAL,
  metadata TEXT,
  taken_at INTEGER,
  trashed_at INTEGER,
  trash_root INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_files_name ON files(COALESCE(folder_id,''), name COLLATE NOCASE) WHERE trashed_at IS NULL AND status <> 'failed';
CREATE INDEX ix_files_folder ON files(folder_id, trashed_at, status);
CREATE INDEX ix_files_blob ON files(blob_id);
CREATE INDEX ix_files_starred ON files(starred) WHERE starred = 1;
CREATE INDEX ix_files_accessed ON files(last_accessed_at);
CREATE INDEX ix_files_category ON files(category);
CREATE INDEX ix_files_trash ON files(trash_root, trashed_at);
CREATE INDEX ix_files_created ON files(created_at);

CREATE VIRTUAL TABLE files_fts USING fts5(
  name, description, tags,
  content='files', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TRIGGER files_fts_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name, description, tags) VALUES (new.rowid, new.name, new.description, new.tags);
END;
CREATE TRIGGER files_fts_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, description, tags) VALUES ('delete', old.rowid, old.name, old.description, old.tags);
END;
CREATE TRIGGER files_fts_au AFTER UPDATE OF name, description, tags ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, description, tags) VALUES ('delete', old.rowid, old.name, old.description, old.tags);
  INSERT INTO files_fts(rowid, name, description, tags) VALUES (new.rowid, new.name, new.description, new.tags);
END;

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  slice_size INTEGER NOT NULL,
  client_key TEXT,
  on_conflict TEXT NOT NULL DEFAULT 'rename',
  target_name TEXT,
  part_basename TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','processing','complete','failed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ix_uploads_status ON uploads(status, expires_at);

CREATE TABLE upload_slices (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_idx INTEGER NOT NULL,
  slice_idx INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_idx, slice_idx)
) WITHOUT ROWID;

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  password_hash TEXT,
  expires_at INTEGER,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((file_id IS NULL) <> (folder_id IS NULL))
);
CREATE INDEX ix_shares_folder ON shares(folder_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX ix_sessions_expires ON sessions(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  item_type TEXT,
  item_id TEXT,
  item_name TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_activity_created ON activity(created_at);

CREATE TABLE bots (
  bot_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  healthy INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_checked_at INTEGER,
  parts_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tg_deletions (
  message_id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_tg_deletions_due ON tg_deletions(next_attempt_at);

CREATE TABLE part_cache (
  local_path TEXT PRIMARY KEY,
  blob_id TEXT,
  idx INTEGER,
  size INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL
);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  bot_id TEXT,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
