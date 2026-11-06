import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { REPO_ROOT } from '../../config.js';
import {
  breadcrumbs,
  childFolderNames,
  findChildFolder,
  folderTree,
  generateTemplateFolders,
  getFolder,
  insertFolder,
  isDescendant,
} from '../../db/repos/folders.js';
import { syncTeleDriveToCatalog } from '../../services/mediaEngine.js';
import { toFolderDTO } from '../dto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { sanitizeFileName, uniqueName } from '../../util.js';

export function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/folders/tree', async () => {
    return { folders: folderTree(db) };
  });

  app.get('/api/folders/dedicated/:kind', async (req) => {
    const { kind } = req.params as { kind: string };
    const folderName = kind === 'photos' || kind === 'pictures' || kind === 'images' || kind === 'image'
      ? 'Photos'
      : kind === 'videos' || kind === 'video'
        ? 'Videos'
        : kind === 'documents' || kind === 'document'
          ? 'Documents'
          : kind === 'audio' || kind === 'music'
            ? 'Audio'
            : kind;
    let folder = findChildFolder(db, null, folderName);
    if (!folder || folder.trashed_at) {
      folder = insertFolder(db, { id: crypto.randomUUID(), parentId: null, name: folderName });
      ctx.bus.emit('storage.changed', {});
    }
    return { folder: toFolderDTO(db, folder) };
  });

  app.post('/api/folders/templates', async () => {
    const result = generateTemplateFolders(db);
    ctx.bus.emit('storage.changed', {});
    try {
      const catPath = path.resolve(REPO_ROOT, 'stream-platform/public/catalog.json');
      syncTeleDriveToCatalog(db, catPath);
    } catch {}
    return { ok: true, ...result };
  });

  app.post('/api/folders', async (req) => {
    const body = z
      .object({ name: z.string().min(1), parentId: z.string().nullable().optional(), color: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest('name required');
    const { name, parentId, color } = body.data;
    if (parentId) {
      const parent = getFolder(db, parentId);
      if (!parent || parent.trashed_at) throw notFound('parent folder not found');
    }
    if (findChildFolder(db, parentId ?? null, name)) {
      throw conflict(`a folder named "${name}" already exists`);
    }
    const folder = insertFolder(db, { id: crypto.randomUUID(), parentId: parentId ?? null, name, color });
    ctx.bus.emit('storage.changed', {});
    return { folder: toFolderDTO(db, folder) };
  });

  app.post('/api/folders/ensure-path', async (req) => {
    const body = z
      .object({ parentId: z.string().nullable().optional(), path: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) throw badRequest('path required');
    let parentId = body.data.parentId ?? null;
    if (parentId) {
      const parent = getFolder(db, parentId);
      if (!parent || parent.trashed_at) throw notFound('parent folder not found');
    }
    const segments = body.data.path.split('/').filter(Boolean);
    if (segments.length === 0) throw badRequest('path required');
    const folder = db.transaction(() => {
      let current = parentId;
      let last: import('../../types.js').FolderRow | undefined;
      for (const seg of segments) {
        const existing = findChildFolder(db, current, seg);
        if (existing) {
          last = existing;
          current = existing.id;
        } else {
          const names = childFolderNames(db, current);
          last = insertFolder(db, {
            id: crypto.randomUUID(),
            parentId: current,
            name: uniqueName(sanitizeFileName(seg) || seg, names),
          });
          current = last.id;
        }
      }
      return last;
    })();
    ctx.bus.emit('storage.changed', {});
    return { folder: toFolderDTO(db, folder!) };
  });

  app.patch('/api/folders/:id', async (req) => {
    const { id } = req.params as { id: string };
    const folder = getFolder(db, id);
    if (!folder || folder.trashed_at) throw notFound('folder not found');
    const body = z
      .object({
        name: z.string().min(1).optional(),
        parentId: z.string().nullable().optional(),
        color: z.string().nullable().optional(),
        starred: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('invalid patch body');
    const p = body.data;
    const now = Date.now();

    if (p.parentId !== undefined && p.parentId !== folder.parent_id) {
      if (p.parentId) {
        if (p.parentId === id) throw badRequest('cannot move a folder into itself');
        const target = getFolder(db, p.parentId);
        if (!target || target.trashed_at) throw notFound('target folder not found');
        if (isDescendant(db, id, p.parentId)) {
          throw badRequest('cannot move a folder into its own descendant');
        }
      }
      const names = childFolderNames(db, p.parentId);
      const name = names.has(folder.name.toLowerCase()) ? uniqueName(folder.name, names) : folder.name;
      db.prepare('UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
        p.parentId,
        name,
        now,
        id,
      );
    }
    if (p.name && p.name !== folder.name) {
      const names = childFolderNames(db, getFolder(db, id)!.parent_id);
      names.delete(folder.name.toLowerCase());
      if (names.has(p.name.toLowerCase())) throw conflict(`a folder named "${p.name}" already exists`);
      db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(p.name, now, id);
    }
    if (p.color !== undefined) {
      db.prepare('UPDATE folders SET color = ?, updated_at = ? WHERE id = ?').run(p.color, now, id);
    }
    if (p.starred !== undefined) {
      db.prepare('UPDATE folders SET starred = ?, updated_at = ? WHERE id = ?').run(p.starred ? 1 : 0, now, id);
    }
    ctx.bus.emit('storage.changed', {});
    return { folder: toFolderDTO(db, getFolder(db, id)!) };
  });

  app.get('/api/folders/:id/breadcrumbs', async (req) => {
    const { id } = req.params as { id: string };
    return { breadcrumbs: breadcrumbs(db, id) };
  });
}
