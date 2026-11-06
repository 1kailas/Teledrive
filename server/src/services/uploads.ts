import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { AppContext } from '../context.js';
import { partTempFileName, uploadTmpDir } from '../db/index.js';
import {
  childFileNames,
  findChildFile,
  getBlob,
  getFile,
  getPart,
  partsByBlob,
} from '../db/repos/files.js';
import { childFolderNames, findChildFolder, getFolder, insertFolder } from '../db/repos/folders.js';
import { getUpload, listUploads, receivedSlices, sliceCountForPart } from '../db/repos/uploads.js';
import { logActivity, enqueueDeletions } from '../db/repos/misc.js';
import type { FileRow, PartRow, UploadDTO, UploadPartDTO, UploadRow } from '../types.js';
import { categorize, fileExtension, sanitizeFileName, uniqueName } from '../util.js';
import { badRequest, conflict, insufficientStorage, notFound, serviceUnavailable } from '../http/errors.js';
import { updateContentHash } from './blobs.js';
import { syncTeleDriveToCatalog } from './mediaEngine.js';
import { REPO_ROOT } from '../config.js';

export interface PartPlan {
  idx: number;
  offset: number;
  size: number;
}

export function planParts(size: number, partSize: number): PartPlan[] {
  if (size <= 0) return [];
  const out: PartPlan[] = [];
  let offset = 0;
  let idx = 0;
  while (offset < size) {
    const s = Math.min(partSize, size - offset);
    out.push({ idx: idx++, offset, size: s });
    offset += s;
  }
  return out;
}

export function sliceCount(partSize: number, sliceSize: number): number {
  return Math.max(1, Math.ceil(partSize / sliceSize));
}

export function sliceLength(partSize: number, sliceSize: number, sliceIdx: number): number {
  const count = sliceCount(partSize, sliceSize);
  if (sliceIdx >= count) return 0;
  return sliceIdx === count - 1 ? partSize - sliceIdx * sliceSize : sliceSize;
}

/** Temp file path for a part. Basename doubles as the Telegram document file_name. */
export function partTempPath(
  dataDir: string,
  upload: UploadRow,
  partCount: number,
  idx: number,
): string {
  // basename is what Telegram stores as the document file_name; it is recorded
  // on the upload row so a later file rename can't break temp path lookups.
  return path.join(
    uploadTmpDir(dataDir, upload.id),
    partTempFileName(upload.part_basename, partCount, idx),
  );
}

function freeDiskBytes(dir: string): number {
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
}

export interface CreateUploadInput {
  name: string;
  size: number;
  mimeType?: string;
  folderId?: string | null;
  lastModified?: number;
  relativePath?: string;
  onConflict?: 'rename' | 'replace' | 'error';
  clientKey?: string;
}

export function createUpload(ctx: AppContext, input: CreateUploadInput): UploadDTO {
  const { config, db } = ctx;
  const name = input.name?.trim();
  if (!name) throw badRequest('name is required');
  if (!Number.isFinite(input.size) || input.size < 0) throw badRequest('size must be >= 0');
  if (config.maxFileSize > 0 && input.size > config.maxFileSize) {
    throw badRequest(`file exceeds MAX_FILE_SIZE_GB (${config.maxFileSize} bytes)`);
  }
  if (input.size > 0 && ctx.pool.healthyCount() === 0) {
    throw serviceUnavailable('no healthy Telegram bots available');
  }

  let folderId = input.folderId ?? null;
  if (folderId) {
    const folder = getFolder(db, folderId);
    if (!folder || folder.trashed_at) throw notFound('folder not found');
  }

  const diskFree = freeDiskBytes(config.dataDir);
  const need = Math.min(input.size, config.partSize) + config.minFreeDisk;
  if (input.size > 0 && diskFree < need) {
    throw insufficientStorage(`insufficient disk space: ${diskFree} bytes free, need ${need}`);
  }

  const now = Date.now();
  const onConflict = input.onConflict ?? 'rename';
  const uploadId = crypto.randomUUID();

  return db.transaction(() => {
    // Resolve relativePath folders first so an interrupted upload into a
    // nested folder can find its existing session on retry.
    if (input.relativePath) {
      const segments = input.relativePath.split('/').filter(Boolean);
      segments.pop(); // last segment is the file name
      for (const seg of segments) {
        const existing = findChildFolder(db, folderId, seg);
        if (existing) {
          folderId = existing.id;
        } else {
          const names = childFolderNames(db, folderId);
          const folder = insertFolder(db, {
            id: crypto.randomUUID(),
            parentId: folderId,
            name: uniqueName(sanitizeFileName(seg) || seg, names),
          });
          folderId = folder.id;
        }
      }
    }

    // A retried create (network blip, refresh) should resume the existing
    // session instead of creating a second file/part set for the same bytes.
    const effectiveClientKey = input.clientKey ?? (input.lastModified ? clientKey(name, input.size, input.lastModified) : null);
    if (effectiveClientKey) {
      const existing = db
        .prepare(
          `SELECT * FROM uploads WHERE client_key = ? AND status IN ('active','processing') AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(effectiveClientKey, now) as UploadRow | undefined;
      if (existing) {
        const existingFile = getFile(db, existing.file_id);
        if (existingFile && existingFile.folder_id === folderId) {
          return toUploadDTO(db, existing, existingFile.name, existingFile.size);
        }
      }
    }

    // name conflict handling
    let finalName = name;
    let targetName: string | null = null;
    const existing = findChildFile(db, folderId, name);
    if (existing) {
      if (onConflict === 'error') throw conflict(`a file named "${name}" already exists`);
      if (onConflict === 'replace') {
        targetName = name;
        finalName = uniqueName(name, childFileNames(db, folderId));
      } else {
        finalName = uniqueName(name, childFileNames(db, folderId));
      }
    }

    const fileId = crypto.randomUUID();
    const blobId = crypto.randomUUID();
    const ext = fileExtension(finalName);
    const mimeType = input.mimeType || mime.lookup(finalName) || 'application/octet-stream';
    const parts = planParts(input.size, config.partSize);
    const zeroByte = input.size === 0;

    db.prepare(
      `INSERT INTO blobs (id, size, part_size, part_count, status, created_at) VALUES (?,?,?,?,?,?)`,
    ).run(blobId, input.size, config.partSize, parts.length, zeroByte ? 'ready' : 'uploading', now);

    db.prepare(
      `INSERT INTO files (id, folder_id, blob_id, name, extension, mime_type, category, size, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      fileId,
      folderId,
      blobId,
      finalName,
      ext,
      mimeType,
      categorize(mimeType, ext),
      input.size,
      zeroByte ? 'ready' : 'uploading',
      now,
      now,
    );

    const insertPart = db.prepare(
      'INSERT INTO parts (blob_id, idx, offset, size, status) VALUES (?,?,?,?,?)',
    );
    for (const p of parts) insertPart.run(blobId, p.idx, p.offset, p.size, 'pending');

    db.prepare(
      `INSERT INTO uploads (id, file_id, blob_id, slice_size, client_key, on_conflict, target_name, part_basename, status, created_at, updated_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uploadId,
      fileId,
      blobId,
      config.sliceSize,
      input.clientKey ?? clientKey(name, input.size, input.lastModified),
      onConflict,
      targetName,
      sanitizeFileName(targetName ?? finalName),
      zeroByte ? 'complete' : 'active',
      now,
      now,
      now + config.uploadSessionTtlMs,
    );

    if (!zeroByte) {
      fs.mkdirSync(uploadTmpDir(config.dataDir, uploadId), { recursive: true });
    }

    const upload = getUpload(db, uploadId)!;
    return toUploadDTO(db, upload, finalName, input.size);
  })();
}

export function clientKey(name: string, size: number, lastModified?: number): string {
  return `${name}|${size}|${lastModified ?? ''}`;
}

export function toUploadDTO(db: import('../db/index.js').Db, upload: UploadRow, name?: string, size?: number): UploadDTO {
  const file = getFile(db, upload.file_id);
  const blob = getBlob(db, upload.blob_id);
  const parts = partsByBlob(db, upload.blob_id);
  const partDTOs: UploadPartDTO[] = parts.map((p) => ({
    idx: p.idx,
    offset: p.offset,
    size: p.size,
    sliceCount: sliceCount(p.size, upload.slice_size),
    status: p.status,
    receivedSlices: receivedSlices(db, upload.id, p.idx),
  }));
  return {
    id: upload.id,
    fileId: upload.file_id,
    name: name ?? file?.name ?? '',
    size: size ?? file?.size ?? blob?.size ?? 0,
    partSize: blob?.part_size ?? 0,
    sliceSize: upload.slice_size,
    status: upload.status,
    parts: partDTOs,
  };
}

export function uploadListDTO(
  db: import('../db/index.js').Db,
  upload: UploadRow,
): Record<string, unknown> {
  const file = getFile(db, upload.file_id);
  const parts = partsByBlob(db, upload.blob_id);
  const received = parts.filter((p) => p.status !== 'pending').length;
  const slicesReceived =
    (db
      .prepare('SELECT COUNT(*) c FROM upload_slices WHERE upload_id = ?')
      .get(upload.id) as { c: number }).c;
  const slicesTotal = parts.reduce((a, p) => a + sliceCount(p.size, upload.slice_size), 0);
  return {
    id: upload.id,
    fileId: upload.file_id,
    name: file?.name ?? '',
    size: file?.size ?? 0,
    status: upload.status,
    clientKey: upload.client_key,
    progress: {
      partsReceived: received,
      partsTotal: parts.length,
      slicesReceived,
      slicesTotal,
    },
    createdAt: upload.created_at,
    expiresAt: upload.expires_at,
  };
}

/** Absolute byte-range validation for a slice PUT. */
export function expectedSliceLength(part: PartRow, sliceSize: number, sliceIdx: number): number {
  if (sliceIdx < 0 || sliceIdx >= sliceCount(part.size, sliceSize)) return -1;
  return sliceLength(part.size, sliceSize, sliceIdx);
}

export interface MissingSlices {
  partIdx: number;
  missing: number[];
}

export function missingSlices(db: import('../db/index.js').Db, upload: UploadRow): MissingSlices[] {
  const parts = partsByBlob(db, upload.blob_id).filter((p) => p.status === 'pending');
  const out: MissingSlices[] = [];
  for (const p of parts) {
    const got = new Set(receivedSlices(db, upload.id, p.idx));
    const total = sliceCount(p.size, upload.slice_size);
    const missing: number[] = [];
    for (let s = 0; s < total; s++) if (!got.has(s)) missing.push(s);
    if (missing.length > 0) out.push({ partIdx: p.idx, missing });
  }
  return out;
}

/** Called by POST /complete and after every part finishes uploading. */
export function maybeFinalizeBlob(ctx: AppContext, blobId: string): boolean {
  const { db, config, bus, logger } = ctx;
  const blob = getBlob(db, blobId);
  if (!blob || blob.status === 'ready') return false;
  const parts = partsByBlob(db, blobId);
  if (!parts.every((p) => p.status === 'stored')) return false;

  const upload = db
    .prepare(`SELECT * FROM uploads WHERE blob_id = ? AND status IN ('active','processing')`)
    .get(blobId) as UploadRow | undefined;
  const file = db.prepare('SELECT * FROM files WHERE blob_id = ?').get(blobId) as FileRow | undefined;

  db.transaction(() => {
    db.prepare(`UPDATE blobs SET status = 'ready' WHERE id = ?`).run(blobId);
    updateContentHash(db, blobId);
    if (file) {
      let name = file.name;
      let replaced = 0;
      if (upload?.target_name) {
        name = upload.target_name;
        // move existing same-name files to trash (replace policy)
        const rivals = db
          .prepare(
            `SELECT id FROM files WHERE folder_id IS ? AND name = ? COLLATE NOCASE
             AND id <> ? AND trashed_at IS NULL AND status <> 'failed'`,
          )
          .all(file.folder_id, name, file.id) as { id: string }[];
        const now = Date.now();
        for (const r of rivals) {
          db.prepare(`UPDATE files SET trashed_at = ?, trash_root = 1, updated_at = ? WHERE id = ?`).run(
            now,
            now,
            r.id,
          );
        }
        replaced = rivals.length;
        const ext = fileExtension(name);
        db.prepare(`UPDATE files SET extension = ?, category = ? WHERE id = ?`).run(
          ext,
          categorize(file.mime_type, ext),
          file.id,
        );
      }
      db.prepare(`UPDATE files SET name = ?, status = 'ready', updated_at = ? WHERE id = ?`).run(
        name,
        Date.now(),
        file.id,
      );
      logActivity(db, {
        action: 'upload',
        itemType: 'file',
        itemId: file.id,
        itemName: name,
        details: JSON.stringify({ size: file.size, parts: parts.length, replaced }),
      });
    }
    if (upload) {
      db.prepare(`UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?`).run(
        Date.now(),
        upload.id,
      );
      fs.rmSync(uploadTmpDir(config.dataDir, upload.id), { recursive: true, force: true });
    }
  })();
  logger.info({ blobId, fileId: file?.id }, 'upload finalized');
  if (file) {
    bus.emit('file.updated', { fileId: file.id, status: 'ready' });
    if (config.nodeEnv !== 'test' && ['video', 'audio'].includes(file.category)) {
      try {
        const catPath = path.resolve(REPO_ROOT, 'stream-platform/public/catalog.json');
        syncTeleDriveToCatalog(db, catPath);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'catalog sync bypassed');
      }
    }
  }
  bus.emit('storage.changed', {});
  return true;
}

export function completeUpload(ctx: AppContext, uploadId: string): { file: FileRow; ready: boolean } {
  const { db, config } = ctx;
  const upload = getUpload(db, uploadId);
  if (!upload) throw notFound('upload not found');
  if (upload.status === 'complete') {
    const file = getFile(db, upload.file_id)!;
    return { file, ready: true };
  }
  if (upload.status !== 'active' && upload.status !== 'processing') {
    throw conflict(`upload is ${upload.status}`);
  }
  const missing = missingSlices(db, upload);
  if (missing.length > 0) {
    throw conflict('upload has missing slices', { missing });
  }
  db.prepare(`UPDATE uploads SET status = 'processing', updated_at = ? WHERE id = ?`).run(
    Date.now(),
    uploadId,
  );
  db.prepare(`UPDATE files SET status = 'processing', updated_at = ? WHERE id = ?`).run(
    Date.now(),
    upload.file_id,
  );

  // All slices are on disk, but some parts may still be waiting to go to
  // Telegram (or failed after all slices arrived). Kick them immediately
  // instead of waiting for the next scheduler tick.
  const blob = getBlob(db, upload.blob_id);
  if (blob) {
    for (const p of partsByBlob(db, upload.blob_id)) {
      // Only parts that are still waiting for Telegram. Parts already being
      // processed ('uploading') are left alone so media extraction cannot race
      // with a duplicate send.
      if (p.status !== 'pending' && p.status !== 'failed') continue;
      const tmp = partTempPath(config.dataDir, upload, blob.part_count, p.idx);
      if (!fs.existsSync(tmp)) continue;
      db.prepare(
        `UPDATE parts SET status = 'received', next_attempt_at = NULL
         WHERE blob_id = ? AND idx = ? AND status IN ('pending','failed')`,
      ).run(p.blob_id, p.idx);
      ctx.queue.enqueue(p.blob_id, p.idx);
    }
  }

  const ready = maybeFinalizeBlob(ctx, upload.blob_id);
  return { file: getFile(db, upload.file_id)!, ready };
}

export function cancelUpload(ctx: AppContext, uploadId: string): void {
  const { db, config } = ctx;
  const upload = getUpload(db, uploadId);
  if (!upload) throw notFound('upload not found');
  if (upload.status === 'complete') throw conflict('upload already complete');

  ctx.queue.cancelBlob(upload.blob_id);
  const storedMessageIds = partsByBlob(db, upload.blob_id)
    .filter((p) => p.message_id != null)
    .map((p) => p.message_id!);

  db.transaction(() => {
    db.prepare(`UPDATE uploads SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
      Date.now(),
      uploadId,
    );
    enqueueDeletions(db, storedMessageIds);
    db.prepare('DELETE FROM files WHERE id = ?').run(upload.file_id);
    db.prepare('DELETE FROM blobs WHERE id = ?').run(upload.blob_id);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(uploadId);
  })();
  fs.rmSync(uploadTmpDir(config.dataDir, uploadId), { recursive: true, force: true });
  ctx.bus.emit('storage.changed', {});
}

/**
 * Startup recovery:
 *  - parts 'uploading' -> 'received' if temp exists else 'failed'
 *  - re-enqueue every 'received' part
 *  - resume completion check for 'processing' uploads
 */
export function recoverUploads(ctx: AppContext): { requeued: number } {
  const { db, config } = ctx;
  const uploading = db.prepare(`SELECT * FROM parts WHERE status = 'uploading'`).all() as PartRow[];
  for (const p of uploading) {
    const upload = db
      .prepare(`SELECT * FROM uploads WHERE blob_id = ? AND status IN ('active','processing')`)
      .get(p.blob_id) as UploadRow | undefined;
    const blob = getBlob(db, p.blob_id);
    const tmp =
      upload && blob ? partTempPath(config.dataDir, upload, blob.part_count, p.idx) : null;
    if (tmp && fs.existsSync(tmp)) {
      db.prepare(`UPDATE parts SET status = 'received' WHERE blob_id = ? AND idx = ?`).run(p.blob_id, p.idx);
    } else {
      db.prepare(
        `UPDATE parts SET status = 'failed', last_error = 'temp file lost', next_attempt_at = ? WHERE blob_id = ? AND idx = ?`,
      ).run(Date.now(), p.blob_id, p.idx);
    }
  }
  const received = db.prepare(`SELECT blob_id, idx FROM parts WHERE status = 'received'`).all() as {
    blob_id: string;
    idx: number;
  }[];
  for (const p of received) ctx.queue.enqueue(p.blob_id, p.idx);

  const processing = db
    .prepare(`SELECT blob_id FROM uploads WHERE status = 'processing'`)
    .all() as { blob_id: string }[];
  for (const u of processing) maybeFinalizeBlob(ctx, u.blob_id);
  return { requeued: received.length };
}

/**
 * Re-drive a failed upload: every non-stored part must still have its temp
 * file. Resets those parts to 'received' (attempts 0) and re-enqueues them.
 */
export function retryUpload(ctx: AppContext, uploadId: string): { retried: number } {
  const { db, config } = ctx;
  const upload = getUpload(db, uploadId);
  if (!upload) throw notFound('upload not found');
  if (upload.status !== 'failed') throw conflict(`upload is ${upload.status}`);
  const blob = getBlob(db, upload.blob_id);
  if (!blob) throw notFound('blob not found');
  const parts = partsByBlob(db, upload.blob_id);
  const missing = parts.filter(
    (p) => p.status !== 'stored' && !fs.existsSync(partTempPath(config.dataDir, upload, blob.part_count, p.idx)),
  );
  if (missing.length > 0) {
    throw conflict('temp files for some parts are gone; re-upload required', {
      missingParts: missing.map((p) => p.idx),
    });
  }
  db.transaction(() => {
    for (const p of parts) {
      if (p.status !== 'stored') {
        db.prepare(
          `UPDATE parts SET status = 'received', attempts = 0, last_error = NULL, next_attempt_at = NULL
           WHERE blob_id = ? AND idx = ?`,
        ).run(p.blob_id, p.idx);
      }
    }
    db.prepare(`UPDATE blobs SET status = 'processing' WHERE id = ?`).run(upload.blob_id);
    db.prepare(`UPDATE files SET status = 'processing', updated_at = ? WHERE id = ?`).run(Date.now(), upload.file_id);
    db.prepare(`UPDATE uploads SET status = 'processing', updated_at = ?, expires_at = ? WHERE id = ?`).run(
      Date.now(), Date.now() + config.uploadSessionTtlMs, upload.id,
    );
  })();
  let retried = 0;
  for (const p of parts) {
    if (p.status !== 'stored') {
      ctx.queue.enqueue(p.blob_id, p.idx);
      retried++;
    }
  }
  maybeFinalizeBlob(ctx, upload.blob_id);
  return { retried };
}

/** Cancel semantics for an expired FAILED upload (temp is gone or TTL passed). */
export function cancelFailedUploads(ctx: AppContext, olderThan: number): number {
  const { db, config } = ctx;
  const stale = db
    .prepare(`SELECT * FROM uploads WHERE status = 'failed' AND updated_at < ?`)
    .all(olderThan) as UploadRow[];
  for (const u of stale) {
    const messageIds = partsByBlob(db, u.blob_id)
      .filter((p) => p.message_id != null)
      .map((p) => p.message_id!);
    db.transaction(() => {
      enqueueDeletions(db, messageIds);
      db.prepare('DELETE FROM files WHERE id = ?').run(u.file_id);
      db.prepare('DELETE FROM blobs WHERE id = ?').run(u.blob_id);
      db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
    })();
    fs.rmSync(uploadTmpDir(config.dataDir, u.id), { recursive: true, force: true });
  }
  if (stale.length) ctx.bus.emit('storage.changed', {});
  return stale.length;
}
