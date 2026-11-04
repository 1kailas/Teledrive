import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

export type Db = Database.Database;

const stmtCache = new WeakMap<Db, Map<string, Database.Statement>>();

/** Prepared-statement cache for hot paths (better-sqlite3 recompiles on every prepare()). */
export function prep(db: Db, sql: string): Database.Statement {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'teledrive.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    })();
  }
}

/** Directory holding temporary slices for an upload. */
export function uploadTmpDir(dataDir: string, uploadId: string): string {
  return path.join(dataDir, 'tmp', 'uploads', uploadId);
}

/** Temp file name sent to Telegram: original name for single part, `<name>.partNNN` for multi-part. */
export function partTempFileName(fileName: string, partCount: number, idx: number): string {
  if (partCount === 1) return fileName;
  return `${fileName}.part${String(idx + 1).padStart(3, '0')}`;
}

export function thumbnailPath(dataDir: string, fileId: string): string {
  return path.join(dataDir, 'thumbnails', fileId.slice(0, 2), `${fileId}.webp`);
}
