import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { getFile } from '../../db/repos/files.js';
import { childFolderSizes, getFolder, breadcrumbs } from '../../db/repos/folders.js';
import {
  fileStorage,
  findDuplicates,
  listTags,
  prefetchFile,
  uploadProgress,
  verifyFile,
} from '../../services/insights.js';
import { toFileDTO } from '../dto.js';
import { notFound } from '../errors.js';
import type { FileRow } from '../../types.js';

export function registerInsightRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const liveFile = (id: string): FileRow => {
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    return file;
  };

  app.get('/api/uploads/:id/progress', async (req) => uploadProgress(ctx, (req.params as { id: string }).id));

  app.get('/api/files/:id/storage', async (req) => fileStorage(ctx, liveFile((req.params as { id: string }).id)));

  app.post('/api/files/:id/prefetch', async (req, reply) => {
    const file = liveFile((req.params as { id: string }).id);
    const queued = prefetchFile(ctx, file);
    return reply.code(202).send({ queued });
  });

  app.post('/api/files/:id/verify', async (req) => verifyFile(ctx, liveFile((req.params as { id: string }).id)));

  app.get('/api/duplicates', async () => {
    const { groups, wastedBytes } = findDuplicates(db);
    return {
      wastedBytes,
      groups: groups.map((g) => ({
        contentHash: g.contentHash,
        size: g.size,
        storedCopies: g.storedCopies,
        wastedBytes: g.wastedBytes,
        files: g.files.map((f) => ({ ...toFileDTO(db, f), path: f.path })),
      })),
    };
  });

  app.get('/api/storage/folders', async (req) => {
    const parentId = (req.query as Record<string, string>)['parentId'] || null;
    if (parentId) {
      const folder = getFolder(db, parentId);
      if (!folder || folder.trashed_at) throw notFound('folder not found');
    }
    const { folders, loose } = childFolderSizes(db, parentId);
    return { parentId, breadcrumbs: breadcrumbs(db, parentId), folders, loose };
  });

  app.get('/api/tags', async () => ({ tags: listTags(db) }));
}
