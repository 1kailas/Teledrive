import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { thumbnailPath, type Db } from '../db/index.js';
import { childFileNames, getFile } from '../db/repos/files.js';
import {
  childFolderNames,
  getFolder,
  subtreeFolderIds,
} from '../db/repos/folders.js';
import { logActivity } from '../db/repos/misc.js';
import type { FileRow, FolderRow } from '../types.js';
import { uniqueName } from '../util.js';
import { deleteFilePermanent, derefBlob } from './blobs.js';
import { notFound } from '../http/errors.js';

/** Mark a folder's whole non-trashed subtree trashed (root keeps trash_root=1). */
function trashFolderSubtree(db: Db, folderId: string, ts: number): void {
  const ids = subtreeFolderIds(db, folderId);
  db.prepare(`UPDATE folders SET trashed_at = ?, trash_root = 0, updated_at = ? WHERE trashed_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
    .run(ts, ts, JSON.stringify(ids));
  db.prepare(`UPDATE folders SET trash_root = 1 WHERE id = ?`).run(folderId);
  db.prepare(`UPDATE files SET trashed_at = ?, trash_root = 0, updated_at = ? WHERE trashed_at IS NULL AND folder_id IN (SELECT value FROM json_each(?))`)
    .run(ts, ts, JSON.stringify(ids));
}

export function trashItems(ctx: AppContext, itemIds: { fileIds?: string[]; folderIds?: string[] }): number {
  const { db } = ctx;
  const ts = Date.now();
  let affected = 0;
  db.transaction(() => {
    for (const id of itemIds.folderIds ?? []) {
      const folder = getFolder(db, id);
      if (!folder || folder.trashed_at) continue;
      trashFolderSubtree(db, id, ts);
      logActivity(db, { action: 'trash', itemType: 'folder', itemId: id, itemName: folder.name });
      affected++;
    }
    for (const id of itemIds.fileIds ?? []) {
      const file = getFile(db, id);
      if (!file || file.trashed_at) continue;
      db.prepare('UPDATE files SET trashed_at = ?, trash_root = 1, updated_at = ? WHERE id = ?').run(ts, ts, id);
      logActivity(db, { action: 'trash', itemType: 'file', itemId: id, itemName: file.name });
      affected++;
    }
  })();
  if (affected) ctx.bus.emit('storage.changed', {});
  return affected;
}

function restoreFile(db: Db, file: FileRow): void {
  // if the original parent is gone/trashed, restore to root
  let folderId = file.folder_id;
  if (folderId) {
    const parent = getFolder(db, folderId);
    if (!parent || parent.trashed_at) folderId = null;
  }
  const names = childFileNames(db, folderId);
  const name = names.has(file.name.toLowerCase()) ? uniqueName(file.name, names) : file.name;
  db.prepare(
    'UPDATE files SET trashed_at = NULL, trash_root = 0, folder_id = ?, name = ?, updated_at = ? WHERE id = ?',
  ).run(folderId, name, Date.now(), file.id);
}

function restoreFolderTree(db: Db, folder: FolderRow): number {
  const ts = folder.trashed_at!;
  const ids = subtreeFolderIds(db, folder.id);
  let count = 0;

  // restore parent chain first
  const restoreOne = (f: FolderRow): void => {
    let parentId = f.parent_id;
    if (parentId) {
      const parent = getFolder(db, parentId);
      if (!parent || parent.trashed_at) parentId = null;
    }
    const names = childFolderNames(db, parentId);
    const name = names.has(f.name.toLowerCase()) ? uniqueName(f.name, names) : f.name;
    db.prepare(
      'UPDATE folders SET trashed_at = NULL, trash_root = 0, parent_id = ?, name = ?, updated_at = ? WHERE id = ?',
    ).run(parentId, name, Date.now(), f.id);
    count++;
  };

  // BFS from root so parents exist before children reparent check
  const byParent = new Map<string | null, FolderRow[]>();
  const all = db
    .prepare(`SELECT * FROM folders WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at = ?`)
    .all(JSON.stringify(ids), ts) as FolderRow[];
  for (const f of all) {
    const k = ids.includes(f.parent_id ?? '') ? f.parent_id : '__root__';
    const arr = byParent.get(k ?? null) ?? [];
    arr.push(f);
    byParent.set(k ?? null, arr);
  }
  const queue: FolderRow[] = [folder];
  restoreOne(folder);
  while (queue.length) {
    const cur = queue.shift()!;
    const children = byParent.get(cur.id) ?? [];
    for (const c of children) {
      // parent was restored (still in same subtree): keep parent_id as-is
      const names = childFolderNames(db, c.parent_id);
      const name = names.has(c.name.toLowerCase()) ? uniqueName(c.name, names) : c.name;
      db.prepare('UPDATE folders SET trashed_at = NULL, trash_root = 0, name = ?, updated_at = ? WHERE id = ?').run(
        name,
        Date.now(),
        c.id,
      );
      count++;
      queue.push(c);
    }
  }
  // restore files trashed in the same sweep
  const files = db
    .prepare(`SELECT * FROM files WHERE trashed_at = ? AND folder_id IN (SELECT value FROM json_each(?))`)
    .all(ts, JSON.stringify(ids)) as FileRow[];
  for (const f of files) restoreFile(db, f);
  return count + files.length;
}

export function restoreItems(ctx: AppContext, itemIds: { fileIds?: string[]; folderIds?: string[] }): number {
  const { db } = ctx;
  let affected = 0;
  db.transaction(() => {
    for (const id of itemIds.folderIds ?? []) {
      const folder = getFolder(db, id);
      if (!folder || !folder.trashed_at) continue;
      if (!folder.trash_root) continue; // children are restored via their root
      affected += restoreFolderTree(db, folder);
      logActivity(db, { action: 'restore', itemType: 'folder', itemId: id, itemName: folder.name });
    }
    for (const id of itemIds.fileIds ?? []) {
      const file = getFile(db, id);
      if (!file || !file.trashed_at) continue;
      restoreFile(db, file);
      logActivity(db, { action: 'restore', itemType: 'file', itemId: id, itemName: file.name });
      affected++;
    }
  })();
  if (affected) ctx.bus.emit('storage.changed', {});
  return affected;
}

/** Permanently delete a file or an entire folder subtree. */
export function deletePermanent(ctx: AppContext, opts: { fileId?: string; folderId?: string }): void {
  const { db } = ctx;
  if (opts.fileId) {
    const file = getFile(db, opts.fileId);
    if (!file) throw notFound('file not found');
    deleteFilePermanent(ctx, file);
    return;
  }
  const folder = getFolder(db, opts.folderId!);
  if (!folder) throw notFound('folder not found');
  const ids = subtreeFolderIds(db, folder.id);
  const files = db
    .prepare(`SELECT * FROM files WHERE folder_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as FileRow[];
  const blobIds = new Set<string>();
  db.transaction(() => {
    for (const f of files) {
      if (f.blob_id) blobIds.add(f.blob_id);
      if (f.has_thumbnail) {
        fs.rmSync(thumbnailPath(ctx.config.dataDir, f.id), { force: true });
      }
    }
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id); // cascades subfolders+files
    for (const b of blobIds) derefBlob(ctx, b);
  })();
  logActivity(db, { action: 'delete', itemType: 'folder', itemId: folder.id, itemName: folder.name });
}

export function emptyTrash(ctx: AppContext): number {
  const { db } = ctx;
  const roots = db
    .prepare(
      `SELECT id, 'folder' t FROM folders WHERE trash_root = 1 AND trashed_at IS NOT NULL
       UNION ALL SELECT id, 'file' FROM files WHERE trash_root = 1 AND trashed_at IS NOT NULL`,
    )
    .all() as { id: string; t: string }[];
  for (const r of roots) {
    if (r.t === 'folder') deletePermanent(ctx, { folderId: r.id });
    else {
      const f = getFile(db, r.id);
      if (f) deleteFilePermanent(ctx, f);
    }
  }
  if (roots.length > 0) {
    void ctx.scheduler?.processDeletions().catch(() => {});
  }
  return roots.length;
}

export function purgeExpiredTrash(ctx: AppContext, olderThan: number): number {
  const { db } = ctx;
  const roots = db
    .prepare(
      `SELECT id, 'folder' t FROM folders WHERE trash_root = 1 AND trashed_at IS NOT NULL AND trashed_at < ?
       UNION ALL SELECT id, 'file' FROM files WHERE trash_root = 1 AND trashed_at IS NOT NULL AND trashed_at < ?`,
    )
    .all(olderThan, olderThan) as { id: string; t: string }[];
  for (const r of roots) {
    if (r.t === 'folder') deletePermanent(ctx, { folderId: r.id });
    else {
      const f = getFile(db, r.id);
      if (f) deleteFilePermanent(ctx, f);
    }
  }
  if (roots.length > 0) {
    void ctx.scheduler?.processDeletions().catch(() => {});
  }
  return roots.length;
}

export function listTrash(ctx: AppContext): { folders: FolderRow[]; files: FileRow[]; totalSize: number } {
  const { db } = ctx;
  const folders = db
    .prepare('SELECT * FROM folders WHERE trash_root = 1 AND trashed_at IS NOT NULL ORDER BY name COLLATE NOCASE')
    .all() as FolderRow[];
  const files = db
    .prepare('SELECT * FROM files WHERE trash_root = 1 AND trashed_at IS NOT NULL ORDER BY name COLLATE NOCASE')
    .all() as FileRow[];
  const totalSize =
    files.reduce((a, f) => a + f.size, 0) +
    folders.reduce((a, f) => {
      const ids = subtreeFolderIds(db, f.id);
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(size),0) s FROM files WHERE folder_id IN (SELECT value FROM json_each(?))`,
        )
        .get(JSON.stringify(ids)) as { s: number };
      return a + r.s;
    }, 0);
  return { folders, files, totalSize };
}
