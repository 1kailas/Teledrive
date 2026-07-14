-- ============================================
-- TeleDrive 2.0 — Migration 0002
-- Search Indexing, Sharing, and Improvements
-- ============================================

-- Add description column to files
ALTER TABLE files ADD COLUMN description TEXT;

-- ============================================
-- Full-Text Search (FTS5)
-- ============================================

-- Create FTS5 virtual table for file search
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  file_id UNINDEXED,
  name,
  extension,
  tags,
  description,
  content='files',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Populate FTS index from existing data
INSERT INTO files_fts(file_id, name, extension, tags, description)
  SELECT id, name, COALESCE(extension, ''), COALESCE(tags, ''), COALESCE(description, '')
  FROM files
  WHERE upload_status = 'complete' AND is_trashed = 0;

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS files_fts_insert AFTER INSERT ON files
WHEN NEW.upload_status = 'complete' AND NEW.is_trashed = 0
BEGIN
  INSERT INTO files_fts(file_id, name, extension, tags, description)
  VALUES (NEW.id, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS files_fts_update AFTER UPDATE ON files
BEGIN
  -- Remove old entry
  DELETE FROM files_fts WHERE file_id = OLD.id;
  -- Re-insert if still visible
  INSERT INTO files_fts(file_id, name, extension, tags, description)
  SELECT NEW.id, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, '')
  WHERE NEW.upload_status = 'complete' AND NEW.is_trashed = 0;
END;

CREATE TRIGGER IF NOT EXISTS files_fts_delete AFTER DELETE ON files
BEGIN
  DELETE FROM files_fts WHERE file_id = OLD.id;
END;

-- ============================================
-- Shared Links
-- ============================================

CREATE TABLE IF NOT EXISTS shared_links (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  expires_at TEXT,
  max_downloads INTEGER,
  download_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);
CREATE INDEX IF NOT EXISTS idx_shared_links_file ON shared_links(file_id);
CREATE INDEX IF NOT EXISTS idx_shared_links_user ON shared_links(user_id);

-- ============================================
-- Activity Log
-- ============================================

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_file ON activity_log(file_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

-- ============================================
-- Additional Composite Indexes for Performance
-- ============================================

-- Files: common filter combinations
CREATE INDEX IF NOT EXISTS idx_files_user_folder_status ON files(user_id, folder_id, is_trashed, upload_status);
CREATE INDEX IF NOT EXISTS idx_files_user_mime ON files(user_id, mime_type);
CREATE INDEX IF NOT EXISTS idx_files_user_size ON files(user_id, size);
CREATE INDEX IF NOT EXISTS idx_files_updated ON files(updated_at);

-- Folders: breadcrumb traversal
CREATE INDEX IF NOT EXISTS idx_folders_parent_user ON folders(parent_id, user_id, is_trashed);

-- Download sessions
CREATE INDEX IF NOT EXISTS idx_download_sessions_user ON download_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_download_sessions_status ON download_sessions(status);
