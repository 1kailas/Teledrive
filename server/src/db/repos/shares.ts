import type { Db } from '../index.js';
import type { ShareRow } from '../../types.js';

export function getShareByToken(db: Db, token: string): ShareRow | undefined {
  return db.prepare('SELECT * FROM shares WHERE token = ?').get(token) as ShareRow | undefined;
}

export function getShare(db: Db, id: string): ShareRow | undefined {
  return db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
}

export function listShares(db: Db): ShareRow[] {
  return db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all() as ShareRow[];
}

/**
 * Atomically increment download_count if below max_downloads.
 * Returns true when the increment was applied.
 */
export function tryCountDownload(db: Db, shareId: string): boolean {
  const res = db
    .prepare(
      `UPDATE shares SET download_count = download_count + 1
       WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
    )
    .run(shareId);
  return res.changes === 1;
}
