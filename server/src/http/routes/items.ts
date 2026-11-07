import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { childFileNames, getFile } from '../../db/repos/files.js';
import { childFolderNames, getFolder, subtreeFolderIds } from '../../db/repos/folders.js';
import { logActivity } from '../../db/repos/misc.js';
import { deletePermanent, restoreItems, trashItems } from '../../services/trash.js';
import { badRequest, notFound } from '../errors.js';
import { uniqueName } from '../../util.js';
import type { FileRow, FolderRow } from '../../types.js';
import { thumbnailPath } from '../../db/index.js';
import fs from 'node:fs';
import path from 'node:path';

const idsSchema = z.object({
  fileIds: z.array(z.string()).default([]),
  folderIds: z.array(z.string()).default([]),
});

export function registerItemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post('/api/items/move', async (req) => {
    const body = idsSchema.extend({ targetFolderId: z.string().nullable() }).safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds + targetFolderId required');
    const { fileIds, folderIds, targetFolderId } = body.data;
    if (targetFolderId) {
      const target = getFolder(db, targetFolderId);
      if (!target || target.trashed_at) throw notFound('target folder not found');
    }
    let affected = 0;
    db.transaction(() => {
      const fileNames = childFileNames(db, targetFolderId);
      const folderNames = childFolderNames(db, targetFolderId);
      for (const id of folderIds) {
        const folder = getFolder(db, id);
        if (!folder || folder.trashed_at) continue;
        if (id === targetFolderId || (targetFolderId && subtreeFolderIds(db, id).includes(targetFolderId))) {
          continue; // can't move into itself/descendant
        }
        if (folder.parent_id === targetFolderId) continue; // no-op move must not rename
        const name = folderNames.has(folder.name.toLowerCase())
          ? uniqueName(folder.name, folderNames)
          : folder.name;
        folderNames.add(name.toLowerCase());
        db.prepare('UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
          targetFolderId, name, Date.now(), id,
        );
        affected++;
      }
      for (const id of fileIds) {
        const file = getFile(db, id);
        if (!file || file.trashed_at) continue;
        if (file.folder_id === targetFolderId) continue; // no-op move must not rename
        const name = fileNames.has(file.name.toLowerCase()) ? uniqueName(file.name, fileNames) : file.name;
        fileNames.add(name.toLowerCase());
        db.prepare('UPDATE files SET folder_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
          targetFolderId, name, Date.now(), id,
        );
        affected++;
      }
      logActivity(db, { action: 'move', details: JSON.stringify({ fileIds, folderIds, targetFolderId }) });
    })();
    if (affected) ctx.bus.emit('storage.changed', {});
    return { ok: true, affected };
  });

  app.post('/api/items/copy', async (req) => {
    const body = idsSchema.extend({ targetFolderId: z.string().nullable() }).safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds + targetFolderId required');
    const { fileIds, folderIds, targetFolderId } = body.data;
    if (targetFolderId) {
      const target = getFolder(db, targetFolderId);
      if (!target || target.trashed_at) throw notFound('target folder not found');
    }
    let affected = 0;
    db.transaction(() => {
      for (const id of fileIds) {
        const src = getFile(db, id);
        if (!src || src.trashed_at || src.status !== 'ready') continue;
        copyFileInto(ctx, src, targetFolderId);
        affected++;
      }
      for (const id of folderIds) {
        const src = getFolder(db, id);
        if (!src || src.trashed_at) continue;
        if (id === targetFolderId || (targetFolderId && subtreeFolderIds(db, id).includes(targetFolderId))) {
          throw badRequest('cannot copy a folder into itself or a descendant');
        }
        copyFolderRecursive(ctx, src, targetFolderId);
        affected++;
      }
    })();
    if (affected) ctx.bus.emit('storage.changed', {});
    return { ok: true, affected };
  });

  app.post('/api/items/trash', async (req) => {
    const body = idsSchema.safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds required');
    return { ok: true, affected: trashItems(ctx, body.data) };
  });

  app.post('/api/items/restore', async (req) => {
    const body = idsSchema.safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds required');
    return { ok: true, affected: restoreItems(ctx, body.data) };
  });

  app.post('/api/items/delete', async (req) => {
    const body = idsSchema.safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds required');
    let affected = 0;
    for (const id of body.data.folderIds) {
      const f = getFolder(db, id);
      if (f) {
        deletePermanent(ctx, { folderId: id });
        affected++;
      }
    }
    for (const id of body.data.fileIds) {
      const f = getFile(db, id);
      if (f) {
        deletePermanent(ctx, { fileId: id });
        affected++;
      }
    }
    return { ok: true, affected };
  });

  app.post('/api/items/star', async (req) => {
    const body = idsSchema.extend({ starred: z.boolean() }).safeParse(req.body);
    if (!body.success) throw badRequest('fileIds/folderIds + starred required');
    const { fileIds, folderIds, starred } = body.data;
    const v = starred ? 1 : 0;
    const now = Date.now();
    let affected = 0;
    db.transaction(() => {
      for (const id of fileIds) {
        affected += db.prepare('UPDATE files SET starred = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL').run(v, now, id).changes;
      }
      for (const id of folderIds) {
        affected += db.prepare('UPDATE folders SET starred = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL').run(v, now, id).changes;
      }
    })();
    return { ok: true, affected };
  });
}

function copyFileInto(ctx: AppContext, src: FileRow, folderId: string | null): void {
  const { db } = ctx;
  const name = uniqueName(src.name, childFileNames(db, folderId));
  const newId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO files (id, folder_id, blob_id, name, extension, mime_type, category, size, status,
      description, tags, starred, has_thumbnail, width, height, duration, metadata, taken_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId, folderId, src.blob_id, name, src.extension, src.mime_type, src.category, src.size,
    'ready', src.description, src.tags, 0, src.has_thumbnail, src.width, src.height,
    src.duration, src.metadata, src.taken_at, now, now,
  );
  if (src.has_thumbnail) {
    try {
      const dst = thumbnailPath(ctx.config.dataDir, newId);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(thumbnailPath(ctx.config.dataDir, src.id), dst);
    } catch { /* best effort */ }
  }
}

function copyFolderRecursive(ctx: AppContext, src: FolderRow, parentId: string | null): string {
  const { db } = ctx;
  const name = uniqueName(src.name, childFolderNames(db, parentId));
  const newId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO folders (id, parent_id, name, color, starred, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(newId, parentId, name, src.color, src.starred, now, now);
  const files = db
    .prepare(`SELECT * FROM files WHERE folder_id = ? AND trashed_at IS NULL AND status = 'ready'`)
    .all(src.id) as FileRow[];
  for (const f of files) copyFileInto(ctx, f, newId);
  const subs = db
    .prepare('SELECT * FROM folders WHERE parent_id = ? AND trashed_at IS NULL')
    .all(src.id) as FolderRow[];
  for (const s of subs) copyFolderRecursive(ctx, s, newId);
  return newId;
}
