import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import mime from 'mime-types';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { getBlob, getFile, partsByBlob, findChildFile, childFileNames } from '../../db/repos/files.js';
import { breadcrumbs, getFolder } from '../../db/repos/folders.js';
import { logActivity } from '../../db/repos/misc.js';
import { toFileDTO } from '../dto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parseRangeHeader, rangeToSegments, createBlobStream } from '../../services/streaming.js';
import { applyMediaResult, extractMedia } from '../../services/media.js';
import { thumbnailPath } from '../../db/index.js';
import { categorize, fileExtension, sanitizeFileName, uniqueName } from '../../util.js';
import { derefBlob, updateContentHash } from '../../services/blobs.js';
import type { FileRow } from '../../types.js';

const TEXT_LIMIT = 10 * 1024 * 1024;

const INLINE_SAFE_TEXT = new Set(['text/plain', 'text/csv', 'text/markdown']);
/** Mimes that may execute active content are flattened to text/plain for inline display. */
function safeInlineMime(mime: string): string {
  const m = (mime || 'application/octet-stream').toLowerCase();
  if (INLINE_SAFE_TEXT.has(m)) return `${m}; charset=utf-8`;
  if (m === 'application/pdf' || m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')) {
    return m;
  }
  if (m.startsWith('text/') || m.includes('xml') || m.includes('javascript') || m.includes('ecmascript')) {
    return 'text/plain; charset=utf-8';
  }
  return m;
}

function contentDisposition(name: string, download: boolean): string {
  const type = download ? 'attachment' : 'inline';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

/** Stream a ready file's content with Range support. */
export async function sendFileContent(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  file: FileRow,
  opts: { download?: boolean; countAccess?: boolean; shareId?: string } = {},
): Promise<FastifyReply> {
  if (file.status !== 'ready' || !file.blob_id) {
    throw conflict(`file is not ready (status: ${file.status})`);
  }
  const parts = partsByBlob(ctx.db, file.blob_id).filter((p) => p.status === 'stored');
  const totalParts = partsByBlob(ctx.db, file.blob_id).length;
  if (parts.length !== totalParts) throw conflict('file parts not fully stored');

  reply.header('Accept-Ranges', 'bytes');
  reply.header('X-Content-Type-Options', 'nosniff');
  const safeMime = opts.download ? file.mime_type : safeInlineMime(file.mime_type);
  reply.header('Content-Type', safeMime);
  // sandbox the inline viewer so served HTML/SVG/scripts can't run in our origin
  if (file.mime_type !== 'application/pdf') {
    reply.header(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'",
    );
  }
  reply.header('ETag', `"${file.blob_id}"`);
  reply.header('Last-Modified', new Date(file.updated_at).toUTCString());
  reply.header('Cache-Control', 'private');
  reply.header('Content-Disposition', contentDisposition(file.name, !!opts.download));

  const size = file.size;
  const range = parseRangeHeader(req.headers.range, size);
  if (range === 'invalid') {
    reply.header('Content-Range', `bytes */${size}`);
    return reply
      .code(416)
      .type('application/json')
      .send(JSON.stringify({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'invalid range' } }));
  }
  if (size === 0) {
    return reply.header('Content-Length', '0').send('');
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const segments = rangeToSegments(parts, start, end);
  if (segments.length === 0) {
    reply.header('Content-Range', `bytes */${size}`);
    return reply
      .code(416)
      .type('application/json')
      .send(JSON.stringify({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'invalid range' } }));
  }

  if (opts.countAccess !== false && (!range || range.start === 0)) {
    ctx.db.prepare('UPDATE files SET last_accessed_at = ? WHERE id = ?').run(Date.now(), file.id);
    if (opts.download) {
      logActivity(ctx.db, { action: 'download', itemType: 'file', itemId: file.id, itemName: file.name });
    }
  }

  const ac = new AbortController();
  // abort part fetching as soon as the client connection dies (closed mid-stream)
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  const stream = createBlobStream(ctx.cache, segments, {
    parts,
    signal: ac.signal,
    prefetchAhead: ctx.config.prefetchNextPart ? Math.max(1, ctx.config.downloadParallelParts - 1) : 0,
    // a full download (no Range, or explicit attachment) reads everything: fetch ahead right away
    eager: !!opts.download || !range,
  });

  if (range) {
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('Content-Length', String(end - start + 1));
  return reply.send(stream);
}

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  folderId: z.string().nullable().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  starred: z.boolean().optional(),
});

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/files/:id', async (req) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    return { file: toFileDTO(db, file), breadcrumbs: breadcrumbs(db, file.folder_id) };
  });

  app.patch('/api/files/:id', async (req) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    const body = patchSchema.safeParse(req.body);
    if (!body.success) throw badRequest('invalid patch body');
    const p = body.data;
    const now = Date.now();
    if (file.status !== 'ready' && (p.name !== undefined || p.folderId !== undefined)) {
      throw conflict('only starred, description and tags can be changed on a non-ready file');
    }
    if (p.name && p.name !== file.name) {
      const names = childFileNames(db, file.folder_id);
      names.delete(file.name.toLowerCase());
      if (names.has(p.name.toLowerCase())) throw conflict(`a file named "${p.name}" already exists`);
      const ext = fileExtension(p.name);
      const mimeWasGeneric = file.mime_type === 'application/octet-stream';
      const newMime = mimeWasGeneric ? mime.lookup(p.name) || file.mime_type : file.mime_type;
      db.prepare(
        'UPDATE files SET name = ?, extension = ?, mime_type = ?, category = ?, updated_at = ? WHERE id = ?',
      ).run(p.name, ext, newMime, mimeWasGeneric ? categorize(newMime, ext) : file.category, now, id);
    }
    if (p.folderId !== undefined && p.folderId !== file.folder_id) {
      if (p.folderId) {
        const folder = getFolder(db, p.folderId);
        if (!folder || folder.trashed_at) throw notFound('target folder not found');
      }
      const names = childFileNames(db, p.folderId);
      const name = names.has(file.name.toLowerCase()) ? uniqueName(file.name, names) : file.name;
      db.prepare('UPDATE files SET folder_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
        p.folderId,
        name,
        now,
        id,
      );
    }
    if (p.description !== undefined) {
      db.prepare('UPDATE files SET description = ?, updated_at = ? WHERE id = ?').run(p.description, now, id);
    }
    if (p.tags !== undefined) {
      db.prepare('UPDATE files SET tags = ?, updated_at = ? WHERE id = ?').run(p.tags.join(','), now, id);
    }
    if (p.starred !== undefined) {
      db.prepare('UPDATE files SET starred = ?, updated_at = ? WHERE id = ?').run(p.starred ? 1 : 0, now, id);
    }
    ctx.bus.emit('file.updated', { fileId: id, status: getFile(db, id)!.status });
    return { file: toFileDTO(db, getFile(db, id)!) };
  });

  app.post('/api/files/:id/copy', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ folderId: z.string().nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) throw badRequest('invalid body');
    const src = getFile(db, id);
    if (!src || src.trashed_at || src.status !== 'ready') throw notFound('file not found');
    const folderId = body.data.folderId !== undefined ? body.data.folderId : src.folder_id;
    if (folderId) {
      const folder = getFolder(db, folderId);
      if (!folder || folder.trashed_at) throw notFound('target folder not found');
    }
    const newId = crypto.randomUUID();
    const name = uniqueName(src.name, childFileNames(db, folderId));
    const now = Date.now();
    db.prepare(
      `INSERT INTO files (id, folder_id, blob_id, name, extension, mime_type, category, size, status,
        description, tags, starred, has_thumbnail, width, height, duration, metadata, taken_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId, folderId, src.blob_id, name, src.extension, src.mime_type, src.category, src.size,
      'ready', src.description, src.tags, src.starred, src.has_thumbnail, src.width, src.height,
      src.duration, src.metadata, src.taken_at, now, now,
    );
    // copy thumbnail file if present
    if (src.has_thumbnail) {
      const srcThumb = thumbnailPath(ctx.config.dataDir, src.id);
      const dstThumb = thumbnailPath(ctx.config.dataDir, newId);
      try {
        fs.mkdirSync(path.dirname(dstThumb), { recursive: true });
        fs.copyFileSync(srcThumb, dstThumb);
      } catch { /* thumbnail copy best-effort */ }
    }
    ctx.bus.emit('storage.changed', {});
    return { file: toFileDTO(db, getFile(db, newId)!) };
  });

  app.get('/api/files/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    return sendFileContent(ctx, req, reply, file, { download: q['download'] === '1' });
  });

  app.get('/api/files/:id/thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || !file.has_thumbnail) throw notFound('no thumbnail');
    const p = thumbnailPath(ctx.config.dataDir, file.id);
    if (!fs.existsSync(p)) throw notFound('no thumbnail');
    reply.header('Content-Type', 'image/webp');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(p));
  });

  app.post('/api/files/:id/thumbnail', async (req) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || file.trashed_at || !file.blob_id) throw notFound('file not found');
    const blob = getBlob(db, file.blob_id);
    if (!blob) throw notFound('blob not found');
    const part0 = partsByBlob(db, file.blob_id).find((p) => p.idx === 0);
    if (!part0 || part0.status !== 'stored') throw conflict('part 0 not stored');
    const local = await ctx.cache.ensureLocal(part0);
    const result = await extractMedia({
      config: ctx.config,
      tools: ctx.tools,
      logger: ctx.logger,
      file,
      partPath: local,
      isWholeFile: blob.part_count === 1,
    });
    applyMediaResult(db, file.id, result);
    if (result.hasThumbnail) ctx.bus.emit('thumbnail.ready', { fileId: file.id });
    return { file: toFileDTO(db, getFile(db, id)!) };
  });

  app.get('/api/files/:id/text', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    if (file.size > TEXT_LIMIT) throw badRequest('file too large for text preview');
    const parts = partsByBlob(db, file.blob_id!);
    if (parts.some((p) => p.status !== 'stored')) throw conflict('file not ready');
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const local = await ctx.cache.ensureLocal(p);
      chunks.push(await fs.promises.readFile(local));
    }
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(Buffer.concat(chunks).toString('utf8'));
  });

  app.put('/api/files/:id/text', { bodyLimit: TEXT_LIMIT + 4096 }, async (req) => {
    const { id } = req.params as { id: string };
    const file = getFile(db, id);
    if (!file || file.trashed_at) throw notFound('file not found');
    const text = typeof req.body === 'string' ? req.body : '';
    return replaceTextContent(ctx, file, text);
  });

  app.post('/api/files/text', async (req) => {
    const body = z
      .object({ folderId: z.string().nullable().optional(), name: z.string().min(1), content: z.string() })
      .safeParse(req.body);
    if (!body.success) throw badRequest('name and content required');
    const { folderId, name, content } = body.data;
    if (folderId) {
      const folder = getFolder(db, folderId);
      if (!folder || folder.trashed_at) throw notFound('folder not found');
    }
    const existing = findChildFile(db, folderId ?? null, name);
    const finalName = existing ? uniqueName(name, childFileNames(db, folderId ?? null)) : name;
    const fileId = crypto.randomUUID();
    const now = Date.now();
    const mimeType = mime.lookup(finalName) || 'text/plain';
    db.prepare(
      `INSERT INTO files (id, folder_id, name, extension, mime_type, category, size, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(fileId, folderId ?? null, finalName, fileExtension(finalName), mimeType,
      categorize(mimeType, fileExtension(finalName)), Buffer.byteLength(content), 'uploading', now, now);
    const file = getFile(db, fileId)!;
    return replaceTextContent(ctx, file, content);
  });
}

/** Write `text` to a temp file, upload to Telegram synchronously, swap blob. */
async function replaceTextContent(ctx: AppContext, file: FileRow, text: string): Promise<Record<string, unknown>> {
  const { db, config, pool } = ctx;
  const content = Buffer.from(text, 'utf8');
  if (content.length > TEXT_LIMIT) throw badRequest('content exceeds 10 MiB');
  const blobId = crypto.randomUUID();
  const now = Date.now();
  const safe = sanitizeFileName(file.name);
  const dir = path.join(config.dataDir, 'tmp', 'text', crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, safe);
  fs.writeFileSync(tmpPath, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  try {
    db.prepare(
      `INSERT INTO blobs (id, size, part_size, part_count, status, created_at) VALUES (?,?,?,?,?,?)`,
    ).run(blobId, content.length, config.partSize, 1, 'uploading', now);
    db.prepare(`INSERT INTO parts (blob_id, idx, offset, size, sha256, status) VALUES (?,?,?,?,?,?)`).run(
      blobId, 0, 0, content.length, sha, 'received',
    );
    const bot = await pool.acquire();
    try {
      const msg = await bot.client.sendDocument({
        chatId: config.channelId,
        filePath: pool.remotePath(tmpPath),
        caption: `#teledrive\nfile: ${file.name}\npart: 1/1\nfile_id: ${file.id}\nblob: ${blobId}\nsha256: ${sha}`,
      });
      const doc = msg.document!;
      db.prepare(
        `UPDATE parts SET status = 'stored', bot_id = ?, message_id = ?, tg_file_id = ?, tg_file_unique_id = ? WHERE blob_id = ? AND idx = 0`,
      ).run(bot.id, msg.message_id, doc.file_id, doc.file_unique_id, blobId);
      pool.recordUpload(bot.id, content.length);
    } finally {
      pool.release(bot);
    }
    const oldBlobId = file.blob_id;
    db.transaction(() => {
      db.prepare(`UPDATE blobs SET status = 'ready' WHERE id = ?`).run(blobId);
      updateContentHash(db, blobId);
      db.prepare(`UPDATE files SET blob_id = ?, size = ?, status = 'ready', mime_type = ?, updated_at = ? WHERE id = ?`)
        .run(blobId, content.length, file.mime_type === 'application/octet-stream' ? (mime.lookup(file.name) || file.mime_type) : file.mime_type, Date.now(), file.id);
      derefBlob(ctx, oldBlobId);
    })();
    ctx.bus.emit('file.updated', { fileId: file.id, status: 'ready' });
    ctx.bus.emit('storage.changed', {});
    return { file: toFileDTO(db, getFile(db, file.id)!) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
