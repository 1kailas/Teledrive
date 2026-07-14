-- ============================================
-- TeleDrive 2.0 — Migration 0003
-- Fix FTS5 column mapping to prevent SQLite no such column T.file_id error
-- ============================================

-- Drop old triggers
DROP TRIGGER IF EXISTS files_fts_insert;
DROP TRIGGER IF EXISTS files_fts_update;
DROP TRIGGER IF EXISTS files_fts_delete;

-- Drop old virtual table
DROP TABLE IF EXISTS files_fts;

-- Recreate FTS5 virtual table using files.rowid directly (without text uuid in the virtual table columns)
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name,
  extension,
  tags,
  description,
  content='files',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Repopulate FTS index
INSERT INTO files_fts(rowid, name, extension, tags, description)
  SELECT rowid, name, COALESCE(extension, ''), COALESCE(tags, ''), COALESCE(description, '')
  FROM files
  WHERE upload_status = 'complete' AND is_trashed = 0;

-- Create correct triggers mapping to NEW.rowid and OLD.rowid using BEFORE/AFTER timing to avoid index corruption
DROP TRIGGER IF EXISTS files_fts_insert;
CREATE TRIGGER files_fts_insert AFTER INSERT ON files
WHEN NEW.upload_status = 'complete' AND NEW.is_trashed = 0
BEGIN
  INSERT INTO files_fts(rowid, name, extension, tags, description)
  VALUES (NEW.rowid, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, ''));
END;

DROP TRIGGER IF EXISTS files_fts_before_update;
CREATE TRIGGER files_fts_before_update BEFORE UPDATE ON files
BEGIN
  DELETE FROM files_fts WHERE rowid = OLD.rowid;
END;

DROP TRIGGER IF EXISTS files_fts_after_update;
CREATE TRIGGER files_fts_after_update AFTER UPDATE ON files
WHEN NEW.upload_status = 'complete' AND NEW.is_trashed = 0
BEGIN
  INSERT INTO files_fts(rowid, name, extension, tags, description)
  VALUES (NEW.rowid, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, ''));
END;

DROP TRIGGER IF EXISTS files_fts_before_delete;
CREATE TRIGGER files_fts_before_delete BEFORE DELETE ON files
BEGIN
  DELETE FROM files_fts WHERE rowid = OLD.rowid;
END;
