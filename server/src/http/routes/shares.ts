import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { getFile } from '../../db/repos/files.js';
import { getFolder } from '../../db/repos/folders.js';
import { getShare, listShares } from '../../db/repos/shares.js';
import { createShare, shareStatus } from '../../services/shares.js';
import { badRequest, notFound } from '../errors.js';
import type { ShareRow } from '../../types.js';

function shareDTO(ctx: AppContext, s: ShareRow): Record<string, unknown> {
  const file = s.file_id ? getFile(ctx.db, s.file_id) : undefined;
  const folder = s.folder_id ? getFolder(ctx.db, s.folder_id) : undefined;
  return {
    id: s.id,
    token: s.token,
    url: `${ctx.config.publicUrl}/s/${s.token}`,
    fileId: s.file_id,
    folderId: s.folder_id,
    itemName: file?.name ?? folder?.name ?? null,
    itemType: s.file_id ? 'file' : 'folder',
    status: shareStatus(s),
    requiresPassword: !!s.password_hash,
    expiresAt: s.expires_at,
    maxDownloads: s.max_downloads,
    downloadCount: s.download_count,
    viewCount: s.view_count,
    allowDownload: !!s.allow_download,
    createdAt: s.created_at,
    revokedAt: s.revoked_at,
  };
}

export function registerShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/shares', async () => {
    return { shares: listShares(db).map((s) => shareDTO(ctx, s)) };
  });

  app.post('/api/shares', async (req) => {
    const body = z
      .object({
        fileId: z.string().optional(),
        folderId: z.string().optional(),
        password: z.string().optional(),
        expiresAt: z.number().optional(),
        maxDownloads: z.number().int().positive().optional(),
        allowDownload: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('invalid share request');
    const share = await createShare(ctx, body.data);
    return { share: shareDTO(ctx, share), url: `${ctx.config.publicUrl}/s/${share.token}` };
  });

  app.patch('/api/shares/:id', async (req) => {
    const { id } = req.params as { id: string };
    const share = getShare(db, id);
    if (!share) throw notFound('share not found');
    const body = z
      .object({
        expiresAt: z.number().nullable().optional(),
        maxDownloads: z.number().int().positive().nullable().optional(),
        allowDownload: z.boolean().optional(),
        revoked: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('invalid patch');
    const p = body.data;
    if (p.expiresAt !== undefined) {
      db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(p.expiresAt, id);
    }
    if (p.maxDownloads !== undefined) {
      db.prepare('UPDATE shares SET max_downloads = ? WHERE id = ?').run(p.maxDownloads, id);
    }
    if (p.allowDownload !== undefined) {
      db.prepare('UPDATE shares SET allow_download = ? WHERE id = ?').run(p.allowDownload ? 1 : 0, id);
    }
    if (p.revoked) {
      db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
    }
    return { share: shareDTO(ctx, getShare(db, id)!) };
  });

  app.delete('/api/shares/:id', async (req) => {
    const { id } = req.params as { id: string };
    const res = db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    if (res.changes === 0 && !getShare(db, id)) throw notFound('share not found');
    return { ok: true };
  });
}
