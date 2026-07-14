-- ============================================
-- TeleDrive 2.0 — Migration 0004
-- Correct FTS5 Triggers & Rebuild Index
-- ============================================

-- Drop old incorrect triggers
DROP TRIGGER IF EXISTS files_fts_insert;
DROP TRIGGER IF EXISTS files_fts_before_update;
DROP TRIGGER IF EXISTS files_fts_after_update;
DROP TRIGGER IF EXISTS files_fts_before_delete;
DROP TRIGGER IF EXISTS files_fts_update;
DROP TRIGGER IF EXISTS files_fts_delete;

-- 1. Create proper AFTER INSERT trigger
CREATE TRIGGER files_fts_insert AFTER INSERT ON files
BEGIN
  INSERT INTO files_fts(rowid, name, extension, tags, description)
  SELECT NEW.rowid, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, '')
  WHERE NEW.upload_status = 'complete' AND NEW.is_trashed = 0;
END;

-- 2. Create proper AFTER UPDATE trigger (handles delete + insert safely)
CREATE TRIGGER files_fts_update AFTER UPDATE ON files
BEGIN
  -- Remove old index entry using special FTS5 delete command
  INSERT INTO files_fts(files_fts, rowid, name, extension, tags, description)
  SELECT 'delete', OLD.rowid, OLD.name, COALESCE(OLD.extension, ''), COALESCE(OLD.tags, ''), COALESCE(OLD.description, '')
  WHERE OLD.upload_status = 'complete' AND OLD.is_trashed = 0;

  -- Add new index entry if complete
  INSERT INTO files_fts(rowid, name, extension, tags, description)
  SELECT NEW.rowid, NEW.name, COALESCE(NEW.extension, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.description, '')
  WHERE NEW.upload_status = 'complete' AND NEW.is_trashed = 0;
END;

-- 3. Create proper AFTER DELETE trigger
CREATE TRIGGER files_fts_delete AFTER DELETE ON files
BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, extension, tags, description)
  SELECT 'delete', OLD.rowid, OLD.name, COALESCE(OLD.extension, ''), COALESCE(OLD.tags, ''), COALESCE(OLD.description, '')
  WHERE OLD.upload_status = 'complete' AND OLD.is_trashed = 0;
END;

-- Rebuild FTS index to resolve any current SQLITE_CORRUPT_VTAB inconsistency
INSERT INTO files_fts(files_fts) VALUES('rebuild');
