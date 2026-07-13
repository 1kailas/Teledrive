-- ============================================
-- TeleDrive 2.0 — Initial Database Schema
-- Cloudflare D1 (SQLite-based)
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  telegram_chat_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Folders table (nested via parent_id)
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id),
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Files table
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER DEFAULT 1,
  sha256_hash TEXT,
  thumbnail_msg_id TEXT,
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT,
  is_favorite INTEGER DEFAULT 0,
  tags TEXT,
  upload_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  size INTEGER NOT NULL,
  sha256_hash TEXT,
  upload_status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Upload sessions (for resume support)
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Download sessions (for resume support)
CREATE TABLE IF NOT EXISTS download_sessions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Favorites
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Recent files
CREATE TABLE IF NOT EXISTS recent_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  accessed_at TEXT DEFAULT (datetime('now'))
);

-- Settings
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT,
  UNIQUE(user_id, key)
);

-- ============================================
-- Indexes for query performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_trashed ON files(is_trashed);
CREATE INDEX IF NOT EXISTS idx_files_favorite ON files(is_favorite);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(upload_status);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(upload_status);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_trashed ON folders(is_trashed);
CREATE INDEX IF NOT EXISTS idx_recent_user ON recent_files(user_id);
CREATE INDEX IF NOT EXISTS idx_recent_accessed ON recent_files(accessed_at);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
