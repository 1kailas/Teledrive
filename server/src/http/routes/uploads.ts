import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { AppContext } from '../../context.js';
import { getPart } from '../../db/repos/files.js';
import { getUpload, listUploads, sliceCountForPart } from '../../db/repos/uploads.js';
import {
  cancelUpload,
  completeUpload,
  createUpload,
  expectedSliceLength,
  partTempPath,
  retryUpload,
  toUploadDTO,
  uploadListDTO,
} from '../../services/uploads.js';
import { uploadTmpDir } from '../../db/index.js';
import { toFileDTO } from '../dto.js';
import { badRequest, conflict, insufficientStorage, notFound } from '../errors.js';
import { writeStreamAt } from '../../util.js';
import type { UploadRow } from '../../types.js';

const createSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().min(0),
  mimeType: z.string().optional(),
  folderId: z.string().nullable().optional(),
  lastModified: z.number().optional(),
  relativePath: z.string().optional(),
  onConflict: z.enum(['rename', 'replace', 'error']).optional(),
  clientKey: z.string().optional(),
});

function requireActiveUpload(ctx: AppContext, id: string): UploadRow {
  const upload = getUpload(ctx.db, id);
  if (!upload) throw notFound('upload not found');
  if (upload.status !== 'active') throw conflict(`upload is ${upload.status}`);
  return upload;
}

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  app.post('/api/uploads', async (req) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) throw badRequest(`invalid upload request: ${body.error.issues[0]?.message ?? ''}`);
    return createUpload(ctx, body.data);
  });

  app.get('/api/uploads', async (req) => {
    const q = req.query as Record<string, string>;
    const uploads = listUploads(db, q['status']);
    return { uploads: uploads.map((u) => uploadListDTO(db, u)) };
  });

  app.get('/api/uploads/:id', async (req) => {
    const { id } = req.params as { id: string };
    const upload = getUpload(db, id);
    if (!upload) throw notFound('upload not found');
    return toUploadDTO(db, upload);
  });

  app.put(
    '/api/uploads/:id/parts/:idx/slices/:s',
    { bodyLimit: config.sliceSize + 1024 },
    async (req, reply) => {
      const { id, idx, s } = req.params as { id: string; idx: string; s: string };
      const upload = requireActiveUpload(ctx, id);
      const partIdx = parseInt(idx, 10);
      const sliceIdx = parseInt(s, 10);
      const part = getPart(db, upload.blob_id, partIdx);
      if (!part) throw notFound('part not found');

      const expected = expectedSliceLength(part, upload.slice_size, sliceIdx);
      if (expected < 0) throw badRequest('slice index out of range');
      const contentLength = parseInt(req.headers['content-length'] ?? '', 10);
      if (!Number.isFinite(contentLength) || contentLength !== expected) {
        throw badRequest(`Content-Length must be ${expected} bytes`);
      }

      if (part.status === 'pending') {
        const blob = db.prepare('SELECT part_count FROM blobs WHERE id = ?').get(upload.blob_id) as {
          part_count: number;
        };
        const tmpPath = partTempPath(config.dataDir, upload, blob.part_count, partIdx);
        fs.mkdirSync(uploadTmpDir(config.dataDir, upload.id), { recursive: true });

        const st = fs.statfsSync(config.dataDir);
        const free = st.bavail * st.bsize;
        if (free < expected + config.minFreeDisk) {
          throw insufficientStorage('insufficient disk space');
        }

        const stream = (req.body ?? req.raw) as Readable;
        await writeStreamAt(stream, tmpPath, sliceIdx * upload.slice_size, expected);
        db.prepare(
          'INSERT OR IGNORE INTO upload_slices (upload_id, part_idx, slice_idx) VALUES (?,?,?)',
        ).run(upload.id, partIdx, sliceIdx);

        const count = sliceCountForPart(db, upload.id, partIdx);
        const total = Math.max(1, Math.ceil(part.size / upload.slice_size));
        if (count >= total) {
          const claimed = db
            .prepare(`UPDATE parts SET status = 'received' WHERE blob_id = ? AND idx = ? AND status = 'pending'`)
            .run(part.blob_id, part.idx);
          if (claimed.changes === 1) {
            ctx.bus.emit('upload.part', { uploadId: upload.id, idx: partIdx, status: 'received' });
            ctx.queue.enqueue(part.blob_id, part.idx);
            return { partReceived: true };
          }
        }
        return { partReceived: false };
      }

      // part already moved past 'pending': idempotent response
      return { partReceived: true };
    },
  );

  app.post('/api/uploads/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const { file, ready } = completeUpload(ctx, id);
    return { file: toFileDTO(db, file), ready };
  });

  app.delete('/api/uploads/:id', async (req) => {
    const { id } = req.params as { id: string };
    cancelUpload(ctx, id);
    return { ok: true };
  });

  app.post('/api/uploads/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    return retryUpload(ctx, id);
  });
}
