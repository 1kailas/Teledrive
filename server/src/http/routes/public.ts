import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { getFile, filesByFolder } from '../../db/repos/files.js';
import { childFolders, getFolder } from '../../db/repos/folders.js';
import { tryCountDownload } from '../../db/repos/shares.js';
import {
  fileInShare,
  folderInShare,
  isShareUnlocked,
  requireActiveShare,
  shareCookieValue,
  shareUnlockCookie,
  verifySharePassword,
} from '../../services/shares.js';
import { badRequest, forbidden, gone, notFound, unauthorized } from '../errors.js';
import { toPublicFileDTO } from '../dto.js';
import { sendFileContent, sendMediaStream } from './files.js';
import { thumbnailPath } from '../../db/index.js';
import { buildZipStream, collectZipEntries } from '../../services/zip.js';
import type { ShareRow } from '../../types.js';
import type { FastifyRequest } from 'fastify';

const RL = { rateLimit: { max: 120, timeWindow: '1 minute' } };

function unlocked(ctx: AppContext, req: FastifyRequest, share: ShareRow): boolean {
  return isShareUnlocked(ctx, share, req.cookies[shareUnlockCookie(share)]);
}

function requireUnlocked(ctx: AppContext, req: FastifyRequest, share: ShareRow): void {
  if (!unlocked(ctx, req, share)) throw unauthorized('share is password protected');
}

/** Breadcrumbs inside a folder share, relative to the share root. */
function shareBreadcrumbs(ctx: AppContext, share: ShareRow, folderId: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  let cur: string | null = folderId;
  let guard = 0;
  while (cur && guard++ < 1000) {
    const f = getFolder(ctx.db, cur);
    if (!f) break;
    out.unshift({ id: f.id, name: f.name });
    if (f.id === share.folder_id) break;
    cur = f.parent_id;
  }
  return out;
}

/** Full folder path from the drive root, or null for a dangling folder chain. */
function folderPath(ctx: AppContext, folderId: string): string | null {
  const parts: string[] = [];
  let cur: string | null = folderId;
  let guard = 0;
  while (cur && guard++ < 1000) {
    const f = getFolder(ctx.db, cur);
    if (!f) return null;
    parts.unshift(f.name);
    cur = f.parent_id;
  }
  return parts.join('/');
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/public/shares/:token', { config: RL }, async (req) => {
    const { token } = req.params as { token: string };
    const share = requireActiveShare(ctx, token);
    db.prepare('UPDATE shares SET view_count = view_count + 1 WHERE id = ?').run(share.id);
    const isUnlocked = unlocked(ctx, req, share);
    const base = {
      type: share.file_id ? ('file' as const) : ('folder' as const),
      requiresPassword: !!share.password_hash,
      unlocked: isUnlocked,
      expiresAt: share.expires_at,
      allowDownload: !!share.allow_download,
    };
    if (!isUnlocked) return { ...base, name: null };
    if (share.file_id) {
      const file = getFile(db, share.file_id);
      if (!file || file.trashed_at || file.status !== 'ready') throw gone('file unavailable');
      return { ...base, name: file.name, file: toPublicFileDTO(file, `/api/public/shares/${token}`) };
    }
    const folder = getFolder(db, share.folder_id!);
    if (!folder || folder.trashed_at) throw gone('folder unavailable');
    return { ...base, name: folder.name, folder: { id: folder.id, name: folder.name } };
  });

  app.post(
    '/api/public/shares/:token/unlock',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const share = requireActiveShare(ctx, token);
      if (!share.password_hash) return { unlocked: true };
      const body = z.object({ password: z.string() }).safeParse(req.body);
      if (!body.success) throw badRequest('password required');
      if (!(await verifySharePassword(share, body.data.password))) throw unauthorized('wrong password');
      reply.setCookie(shareUnlockCookie(share), shareCookieValue(ctx.config.sessionSecret, share), {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.secureCookies,
        path: '/',
        maxAge: 7 * 24 * 3600,
      });
      return { unlocked: true };
    },
  );

  app.get('/api/public/shares/:token/folders/:folderId?', { config: RL }, async (req) => {
    const { token, folderId } = req.params as { token: string; folderId?: string };
    const share = requireActiveShare(ctx, token);
    if (!share.folder_id) throw notFound('not a folder share');
    requireUnlocked(ctx, req, share);
    const targetId = folderId ?? share.folder_id;
    if (!folderInShare(db, share, targetId)) throw forbidden('outside shared folder');
    const folder = getFolder(db, targetId);
    if (!folder || folder.trashed_at) throw notFound('folder not found');
    const folders = childFolders(db, targetId).map((f) => ({ id: f.id, name: f.name }));
    const { files } = filesByFolder(db, targetId, { statuses: ['ready'], limit: 2000 });
    return {
      folder: { id: folder.id, name: folder.name },
      breadcrumbs: shareBreadcrumbs(ctx, share, targetId),
      folders,
      files: files.map((f) => toPublicFileDTO(f, `/api/public/shares/${token}`)),
      allowDownload: !!share.allow_download,
    };
  });

  app.get('/api/public/shares/:token/files/:fileId/content', { config: RL }, async (req, reply) => {
    const { token, fileId } = req.params as { token: string; fileId: string };
    const share = requireActiveShare(ctx, token);
    requireUnlocked(ctx, req, share);
    if (!fileInShare(db, share, fileId)) throw forbidden('outside share');
    const file = getFile(db, fileId);
    if (!file || file.trashed_at) throw notFound('file not found');
    if (file.status !== 'ready') throw gone('file unavailable');
    const q = req.query as Record<string, string>;
    const download = q['download'] === '1';
    if (download) {
      if (!share.allow_download) throw forbidden('downloads disabled for this share');
      const rangeHeader = req.headers.range;
      const counts = !rangeHeader || /^bytes=0-/.test(rangeHeader);
      if (counts && !tryCountDownload(db, share.id)) throw gone('download limit reached');
    }
    return sendFileContent(ctx, req, reply, file, { download, countAccess: false });
  });

  app.get('/api/public/shares/:token/files/:fileId/stream', { config: RL }, async (req, reply) => {
    const { token, fileId } = req.params as { token: string; fileId: string };
    const share = requireActiveShare(ctx, token);
    requireUnlocked(ctx, req, share);
    if (!fileInShare(db, share, fileId)) throw forbidden('outside share');
    const file = getFile(db, fileId);
    if (!file || file.trashed_at || file.status !== 'ready') throw notFound('file not found');
    return sendMediaStream(ctx, req, reply, file);
  });

  app.get('/api/public/shares/:token/files/:fileId/thumbnail', { config: RL }, async (req, reply) => {
    const { token, fileId } = req.params as { token: string; fileId: string };
    const share = requireActiveShare(ctx, token);
    requireUnlocked(ctx, req, share);
    if (!fileInShare(db, share, fileId)) throw forbidden('outside share');
    const file = getFile(db, fileId);
    if (!file || file.trashed_at || file.status !== 'ready' || !file.has_thumbnail) throw notFound('no thumbnail');
    const p = thumbnailPath(ctx.config.dataDir, file.id);
    if (!fs.existsSync(p)) throw notFound('no thumbnail');
    reply.header('Content-Type', 'image/webp');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(p));
  });

  app.get('/api/public/shares/:token/zip', { config: RL }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const share = requireActiveShare(ctx, token);
    if (!share.folder_id) throw notFound('not a folder share');
    requireUnlocked(ctx, req, share);
    if (!share.allow_download) throw forbidden('downloads disabled for this share');
    if (!tryCountDownload(db, share.id)) throw gone('download limit reached');
    const root = getFolder(db, share.folder_id);
    if (!root || root.trashed_at) throw gone('folder unavailable');
    const prefix = folderPath(ctx, root.id);
    if (!prefix) throw gone('folder unavailable');
    const entries = collectZipEntries(db, [], [share.folder_id]);
    // Strip the shared folder's own path so the archive starts at its contents.
    const strip = `${prefix}/`;
    const rootEntries = entries
      .map((e) => e.name.startsWith(strip) ? { ...e, name: e.name.slice(strip.length) } : e)
      .filter((e) => e.name.length > 0);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${root.name.replace(/"/g, '_')}.zip"`);
    return reply.send(buildZipStream(ctx, rootEntries));
  });
}
