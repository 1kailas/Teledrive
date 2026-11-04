import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { buildZipStream, collectZipEntries, createZipToken, verifyZipToken } from '../../services/zip.js';
import { badRequest } from '../errors.js';

export function registerZipRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/zip', async (req) => {
    const body = z
      .object({
        fileIds: z.array(z.string()).default([]),
        folderIds: z.array(z.string()).default([]),
      })
      .safeParse(req.body);
    if (!body.success || (body.data.fileIds.length === 0 && body.data.folderIds.length === 0)) {
      throw badRequest('fileIds or folderIds required');
    }
    const token = createZipToken(ctx.config.sessionSecret, body.data.fileIds, body.data.folderIds);
    return { url: `/api/zip/${token}` };
  });

  app.get('/api/zip/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const payload = verifyZipToken(ctx.config.sessionSecret, token);
    const entries = collectZipEntries(ctx.db, payload.fileIds, payload.folderIds);
    if (entries.length === 0) throw badRequest('nothing to zip');
    const date = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="TeleDrive-${date}.zip"`);
    return reply.send(buildZipStream(ctx, entries));
  });
}
