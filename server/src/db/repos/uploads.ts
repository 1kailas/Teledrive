import type { Db } from '../index.js';
import type { UploadRow } from '../../types.js';

export function getUpload(db: Db, id: string): UploadRow | undefined {
  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as UploadRow | undefined;
}

export function listUploads(db: Db, status?: string): UploadRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM uploads WHERE status = ? ORDER BY created_at DESC')
      .all(status) as UploadRow[];
  }
  return db.prepare('SELECT * FROM uploads ORDER BY created_at DESC').all() as UploadRow[];
}

export function receivedSlices(db: Db, uploadId: string, partIdx: number): number[] {
  const rows = db
    .prepare('SELECT slice_idx FROM upload_slices WHERE upload_id = ? AND part_idx = ? ORDER BY slice_idx')
    .all(uploadId, partIdx) as { slice_idx: number }[];
  return rows.map((r) => r.slice_idx);
}

export function sliceCountForPart(db: Db, uploadId: string, partIdx: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) c FROM upload_slices WHERE upload_id = ? AND part_idx = ?')
      .get(uploadId, partIdx) as { c: number }
  ).c;
}

export function staleActiveUploads(db: Db, now: number): UploadRow[] {
  return db
    .prepare(`SELECT * FROM uploads WHERE status = 'active' AND expires_at < ?`)
    .all(now) as UploadRow[];
}
