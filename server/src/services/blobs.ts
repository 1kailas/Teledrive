import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { thumbnailPath, type Db } from '../db/index.js';
import { blobRefCount, getBlob, partsByBlob } from '../db/repos/files.js';
import { enqueueDeletions, logActivity } from '../db/repos/misc.js';
import type { FileRow } from '../types.js';

/**
 * Content fingerprint derived from the per-part sha256 values. Identical bytes
 * uploaded with the same part size yield the same hash. Null if any part hash
 * is missing (e.g. legacy rows).
 */
export function contentHashFor(size: number, partHashes: (string | null)[]): string | null {
  if (partHashes.some((h) => !h)) return null;
  return crypto.createHash('sha256').update(`${size}|${partHashes.join(',')}`).digest('hex');
}

/** Compute and persist a blob's content hash. Returns the hash (or null). */
export function updateContentHash(db: Db, blobId: string): string | null {
  const blob = getBlob(db, blobId);
  if (!blob) return null;
  const hash = blob.size === 0
    ? contentHashFor(0, [])
    : contentHashFor(blob.size, partsByBlob(db, blobId).map((p) => p.sha256));
  if (hash) db.prepare('UPDATE blobs SET content_hash = ? WHERE id = ?').run(hash, blobId);
  return hash;
}

/** Fill content_hash for ready blobs created before migration 002. */
export function backfillContentHashes(db: Db): number {
  const rows = db
    .prepare(`SELECT id FROM blobs WHERE status = 'ready' AND content_hash IS NULL`)
    .all() as { id: string }[];
  let n = 0;
  for (const r of rows) if (updateContentHash(db, r.id)) n++;
  return n;
}

/** Decrement a blob's refcount; when it hits 0, enqueue Telegram deletions and drop the row. */
export function derefBlob(ctx: AppContext, blobId: string | null): void {
  if (!blobId) return;
  const { db } = ctx;
  if (blobRefCount(db, blobId) > 0) return;
  const messageIds = partsByBlob(db, blobId)
    .filter((p) => p.message_id != null)
    .map((p) => p.message_id!);
  enqueueDeletions(db, messageIds);
  db.prepare('DELETE FROM blobs WHERE id = ?').run(blobId); // parts cascade
  ctx.bus.emit('storage.changed', {});
  if (messageIds.length > 0) {
    void ctx.scheduler?.processDeletions().catch(() => {});
  }
}

/** Permanently delete a file row, its thumbnail and (when unreferenced) its blob. */
export function deleteFilePermanent(ctx: AppContext, file: FileRow): void {
  const { db, config } = ctx;
  db.transaction(() => {
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    if (file.has_thumbnail) {
      fs.rmSync(thumbnailPath(config.dataDir, file.id), { force: true });
    }
    derefBlob(ctx, file.blob_id);
  })();
  logActivity(db, { action: 'delete', itemType: 'file', itemId: file.id, itemName: file.name });
}
