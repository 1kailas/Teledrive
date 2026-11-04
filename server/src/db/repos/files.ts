import { prep, type Db } from '../index.js';
import type { BlobRow, FileRow, PartRow } from '../../types.js';

export function getFile(db: Db, id: string): FileRow | undefined {
  return prep(db, 'SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

export function getBlob(db: Db, id: string): BlobRow | undefined {
  return prep(db, 'SELECT * FROM blobs WHERE id = ?').get(id) as BlobRow | undefined;
}

export function partsByBlob(db: Db, blobId: string): PartRow[] {
  return prep(db, 'SELECT * FROM parts WHERE blob_id = ? ORDER BY idx').all(blobId) as PartRow[];
}

export function getPart(db: Db, blobId: string, idx: number): PartRow | undefined {
  return prep(db, 'SELECT * FROM parts WHERE blob_id = ? AND idx = ?').get(blobId, idx) as
    | PartRow
    | undefined;
}

export function findChildFile(
  db: Db,
  folderId: string | null,
  name: string,
): FileRow | undefined {
  return db
    .prepare(
      `SELECT * FROM files WHERE folder_id IS ? AND name = ? COLLATE NOCASE
       AND trashed_at IS NULL AND status <> 'failed'`,
    )
    .get(folderId, name) as FileRow | undefined;
}

export function childFileNames(db: Db, folderId: string | null): Set<string> {
  const rows = db
    .prepare(
      `SELECT name FROM files WHERE folder_id IS ? AND trashed_at IS NULL AND status <> 'failed'`,
    )
    .all(folderId) as { name: string }[];
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

const SORT_COLS: Record<string, string> = {
  name: 'name COLLATE NOCASE',
  size: 'size',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  type: 'extension COLLATE NOCASE',
};

export function filesByFolder(
  db: Db,
  folderId: string | null,
  opts: { sort?: string; order?: string; limit?: number; offset?: number; statuses?: string[] } = {},
): { files: FileRow[]; total: number } {
  const statuses = opts.statuses ?? ['ready', 'processing'];
  const ph = statuses.map(() => '?').join(',');
  const where = `folder_id IS ? AND trashed_at IS NULL AND status IN (${ph})`;
  const total = (
    db.prepare(`SELECT COUNT(*) c FROM files WHERE ${where}`).get(folderId, ...statuses) as {
      c: number;
    }
  ).c;
  const col = SORT_COLS[opts.sort ?? 'name'] ?? 'name COLLATE NOCASE';
  const dir = opts.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const files = db
    .prepare(
      `SELECT * FROM files WHERE ${where} ORDER BY ${col} ${dir}, name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
    )
    .all(folderId, ...statuses, limit, offset) as FileRow[];
  return { files, total };
}

export function blobRefCount(db: Db, blobId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM files WHERE blob_id = ?').get(blobId) as { c: number })
    .c;
}

export function dueFailedParts(db: Db, now: number, limit = 50): PartRow[] {
  return db
    .prepare(
      `SELECT * FROM parts WHERE status = 'failed' AND next_attempt_at IS NOT NULL
       AND next_attempt_at <= ? AND attempts < 10 ORDER BY next_attempt_at LIMIT ?`,
    )
    .all(now, limit) as PartRow[];
}

export function partStatusCounts(db: Db): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM parts GROUP BY status').all() as {
    status: string;
    c: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.c]));
}
