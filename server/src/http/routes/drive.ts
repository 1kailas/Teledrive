import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { filesByFolder } from '../../db/repos/files.js';
import { breadcrumbs, childFolders, getFolder } from '../../db/repos/folders.js';
import { toFileDTO, toFolderDTO } from '../dto.js';
import { notFound } from '../errors.js';
import type { FileRow } from '../../types.js';

export function registerDriveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/drive', async (req) => {
    const q = req.query as Record<string, string>;
    const folderId = q['folderId'] || null;
    let folder = null;
    if (folderId) {
      folder = getFolder(db, folderId);
      if (!folder || folder.trashed_at) throw notFound('folder not found');
    }
    const folders = childFolders(db, folderId).map((f) => toFolderDTO(db, f));
    const { files, total } = filesByFolder(db, folderId, {
      sort: q['sort'],
      order: q['order'],
      limit: q['limit'] ? parseInt(q['limit'], 10) : undefined,
      offset: q['offset'] ? parseInt(q['offset'], 10) : undefined,
    });
    return {
      folder: folder ? toFolderDTO(db, folder) : null,
      breadcrumbs: breadcrumbs(db, folderId),
      folders,
      files: files.map((f) => toFileDTO(db, f)),
      totalFiles: total,
    };
  });

  app.get('/api/starred', async () => {
    const files = db
      .prepare(`SELECT * FROM files WHERE starred = 1 AND trashed_at IS NULL AND status IN ('ready','processing') ORDER BY name COLLATE NOCASE`)
      .all() as FileRow[];
    const folders = childFoldersStarred(db);
    return {
      folders: folders.map((f) => toFolderDTO(db, f)),
      files: files.map((f) => toFileDTO(db, f)),
    };
  });

  app.get('/api/recent', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '50', 10) || 50, 200);
    const files = db
      .prepare(
        `SELECT * FROM files WHERE trashed_at IS NULL AND status = 'ready'
         ORDER BY MAX(COALESCE(last_accessed_at, 0), created_at) DESC LIMIT ?`,
      )
      .all(limit) as FileRow[];
    return { files: files.map((f) => toFileDTO(db, f)) };
  });
}

function childFoldersStarred(db: import('../../db/index.js').Db) {
  return db
    .prepare('SELECT * FROM folders WHERE starred = 1 AND trashed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all() as import('../../types.js').FolderRow[];
}
