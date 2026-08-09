/**
 * TeleDrive Worker — Sharing Routes
 *
 * Generate and manage shareable public links for files.
 * Supports password protection, expiry dates, and download limits.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';


export const sharingRoutes = new Hono<AppType>();

/**
 * Generate a short, URL-safe share token.
 */
function generateShareToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

/**
 * Simple SHA-256 hash for passwords.
 */
async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * POST /api/share/:fileId
 * Create a share link for a file.
 */
sharingRoutes.post('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');
  const body = await c.req.json<{
    password?: string;
    expiresAt?: string;
    maxDownloads?: number;
  }>();

  // Verify file ownership
  const file = await c.env.DB.prepare(
    "SELECT id, name FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete' AND is_trashed = 0"
  )
    .bind(fileId, userId)
    .first<{ id: string; name: string }>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  // Check if a share link already exists
  const existing = await c.env.DB.prepare(
    'SELECT id, token FROM shared_links WHERE file_id = ? AND user_id = ? AND is_active = 1'
  )
    .bind(fileId, userId)
    .first<{ id: string; token: string }>();

  if (existing) {
    return c.json({
      success: true,
      data: {
        id: existing.id,
        token: existing.token,
        alreadyExists: true,
      },
    });
  }

  const id = generateId();
  const token = generateShareToken();
  const passwordHash = body.password ? await hashPassword(body.password) : null;

  await c.env.DB.prepare(
    `INSERT INTO shared_links (id, file_id, user_id, token, password_hash, expires_at, max_downloads, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, fileId, userId, token, passwordHash, body.expiresAt || null, body.maxDownloads || null, now())
    .run();

  return c.json({
    success: true,
    data: {
      id,
      token,
      fileId,
      fileName: file.name,
    },
  }, 201);
});

/**
 * GET /api/share/links
 * List all active share links for the current user.
 */
sharingRoutes.get('/links', async (c) => {
  const userId = c.get('userId');

  const { results } = await c.env.DB.prepare(
    `SELECT sl.*, f.name as file_name, f.size as file_size, f.mime_type, f.extension
     FROM shared_links sl
     JOIN files f ON sl.file_id = f.id
     WHERE sl.user_id = ? AND sl.is_active = 1
     ORDER BY sl.created_at DESC`
  )
    .bind(userId)
    .all();

  return c.json({ success: true, data: results });
});

/**
 * PATCH /api/share/:fileId
 * Update share link settings.
 */
sharingRoutes.patch('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');
  const body = await c.req.json<{
    password?: string | null;
    expiresAt?: string | null;
    maxDownloads?: number | null;
  }>();

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.password !== undefined) {
    updates.push('password_hash = ?');
    params.push(body.password ? await hashPassword(body.password) : null);
  }

  if (body.expiresAt !== undefined) {
    updates.push('expires_at = ?');
    params.push(body.expiresAt);
  }

  if (body.maxDownloads !== undefined) {
    updates.push('max_downloads = ?');
    params.push(body.maxDownloads);
  }

  if (updates.length === 0) {
    return c.json({ success: false, error: 'No updates provided' }, 400);
  }

  params.push(fileId, userId);

  await c.env.DB.prepare(
    `UPDATE shared_links SET ${updates.join(', ')} WHERE file_id = ? AND user_id = ? AND is_active = 1`
  )
    .bind(...params)
    .run();

  return c.json({ success: true });
});

/**
 * DELETE /api/share/:fileId
 * Revoke (deactivate) a share link.
 */
sharingRoutes.delete('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  await c.env.DB.prepare(
    'UPDATE shared_links SET is_active = 0 WHERE file_id = ? AND user_id = ?'
  )
    .bind(fileId, userId)
    .run();

  return c.json({ success: true });
});

/**
 * GET /api/share/public/:token
 * Get shared file info (PUBLIC — no auth required).
 */
sharingRoutes.get('/public/:token', async (c) => {
  const token = c.req.param('token');

  const share = await c.env.DB.prepare(
    `SELECT sl.*, f.name as file_name, f.size as file_size, f.mime_type, f.extension, f.chunk_count
     FROM shared_links sl
     JOIN files f ON sl.file_id = f.id
     WHERE sl.token = ? AND sl.is_active = 1`
  )
    .bind(token)
    .first<{ file_name: string; file_size: number; mime_type: string | null; extension: string; password_hash: string | null; expires_at: string | null; max_downloads: number | null; download_count: number; chunk_count: number }>();

  if (!share) {
    return c.json({ success: false, error: 'Share link not found or expired' }, 404);
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return c.json({ success: false, error: 'Share link has expired' }, 410);
  }

  // Check download limit
  if (share.max_downloads && share.download_count >= share.max_downloads) {
    return c.json({ success: false, error: 'Download limit reached' }, 410);
  }

  return c.json({
    success: true,
    data: {
      fileName: share.file_name,
      fileSize: share.file_size,
      mimeType: share.mime_type,
      extension: share.extension,
      requiresPassword: !!share.password_hash,
      chunkCount: share.chunk_count,
    },
  });
});

/**
 * POST /api/share/public/:token/download
 * Download a shared file (PUBLIC — no auth required).
 */
sharingRoutes.post('/public/:token/download', async (c) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));

  const share = await c.env.DB.prepare(
    `SELECT sl.*, f.name as file_name, f.size as file_size, f.mime_type, f.chunk_count
     FROM shared_links sl
     JOIN files f ON sl.file_id = f.id
     WHERE sl.token = ? AND sl.is_active = 1`
  )
    .bind(token)
    .first();

  if (!share) {
    return c.json({ success: false, error: 'Share link not found' }, 404);
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at as string) < new Date()) {
    return c.json({ success: false, error: 'Share link has expired' }, 410);
  }

  // Check download limit
  if (share.max_downloads && (share.download_count as number) >= (share.max_downloads as number)) {
    return c.json({ success: false, error: 'Download limit reached' }, 410);
  }

  // Verify password if required
  if (share.password_hash) {
    if (!body.password) {
      return c.json({ success: false, error: 'Password required' }, 401);
    }
    const inputHash = await hashPassword(body.password);
    if (inputHash !== share.password_hash) {
      return c.json({ success: false, error: 'Incorrect password' }, 401);
    }
  }

  // Only support single-chunk files for direct shared download
  if ((share.chunk_count as number) > 1) {
    return c.json({
      success: false,
      error: 'Multi-chunk file sharing not yet supported for direct download',
    }, 400);
  }

  // Get the chunk
  const chunk = await c.env.DB.prepare(
    "SELECT telegram_file_id FROM chunks WHERE file_id = ? AND chunk_index = 0 AND upload_status = 'complete'"
  )
    .bind(share.file_id as string)
    .first<{ telegram_file_id: string }>();

  if (!chunk || !chunk.telegram_file_id) {
    return c.json({ success: false, error: 'File data not found' }, 404);
  }

  // Telegram Bot API does not permit bots to download files/chunks larger than 20 MB (20,971,520 bytes)
  if ((share.file_size as number) > 20971520) {
    return c.json({
      success: false,
      error: `File size (${((share.file_size as number) / (1024 * 1024)).toFixed(1)}MB) exceeds Telegram's 20MB bot download limit. Please re-upload as a multi-chunk file.`
    }, 400);
  }

  try {
    const { service: telegram, value: tgFileId } = TelegramService.fromPrefixedValue(
      c.env.TELEGRAM_BOT_TOKEN,
      c.env.TELEGRAM_CHAT_ID,
      chunk.telegram_file_id
    );

    const fileInfo = await telegram.getFile(tgFileId);
    if (!fileInfo.file_path) {
      return c.json({ success: false, error: 'File path unavailable' }, 500);
    }

    const telegramResponse = await telegram.downloadFile(fileInfo.file_path);

    // Increment download count
    await c.env.DB.prepare(
      'UPDATE shared_links SET download_count = download_count + 1 WHERE token = ?'
    )
      .bind(token)
      .run();

    return new Response(telegramResponse.body, {
      status: 200,
      headers: {
        'Content-Type': (share.mime_type as string) || 'application/octet-stream',
        'Content-Length': String(share.file_size),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(share.file_name as string)}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * POST /api/share/public/:token/verify
 * Verify password for a shared file (PUBLIC).
 */
sharingRoutes.post('/public/:token/verify', async (c) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));

  const share = await c.env.DB.prepare(
    `SELECT sl.password_hash, sl.expires_at, sl.max_downloads, sl.download_count
     FROM shared_links sl
     WHERE sl.token = ? AND sl.is_active = 1`
  )
    .bind(token)
    .first<{ password_hash: string | null; expires_at: string | null; max_downloads: number | null; download_count: number }>();

  if (!share) {
    return c.json({ success: false, error: 'Share link not found or expired' }, 404);
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return c.json({ success: false, error: 'Share link has expired' }, 410);
  }

  // Check download limit
  if (share.max_downloads && share.download_count >= share.max_downloads) {
    return c.json({ success: false, error: 'Download limit reached' }, 410);
  }

  // Verify password if required
  if (share.password_hash) {
    if (!body.password) {
      return c.json({ success: false, error: 'Password required' }, 401);
    }
    const inputHash = await hashPassword(body.password);
    if (inputHash !== share.password_hash) {
      return c.json({ success: false, error: 'Incorrect password' }, 401);
    }
  }

  return c.json({ success: true, message: 'Password verified successfully' });
});

/**
 * GET /api/share/public/:token/chunk/:chunkIndex
 * Download a specific chunk of a shared file (PUBLIC).
 */
sharingRoutes.get('/public/:token/chunk/:chunkIndex', async (c) => {
  const token = c.req.param('token');
  const chunkIndex = c.req.param('chunkIndex');
  const password = c.req.query('password') || undefined;

  const share = await c.env.DB.prepare(
    `SELECT sl.*, f.name as file_name, f.size as file_size, f.mime_type
     FROM shared_links sl
     JOIN files f ON sl.file_id = f.id
     WHERE sl.token = ? AND sl.is_active = 1`
  )
    .bind(token)
    .first<{ file_id: string; password_hash: string | null; expires_at: string | null; max_downloads: number | null; download_count: number; file_name: string; file_size: number; mime_type: string | null }>();

  if (!share) {
    return c.json({ success: false, error: 'Share link not found' }, 404);
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return c.json({ success: false, error: 'Share link has expired' }, 410);
  }

  // Check download limit (only check on the first chunk to avoid blocking ongoing multi-chunk downloads)
  if (Number(chunkIndex) === 0 && share.max_downloads && share.download_count >= share.max_downloads) {
    return c.json({ success: false, error: 'Download limit reached' }, 410);
  }

  // Verify password
  if (share.password_hash) {
    if (!password) {
      return c.json({ success: false, error: 'Password required' }, 401);
    }
    const inputHash = await hashPassword(password);
    if (inputHash !== share.password_hash) {
      return c.json({ success: false, error: 'Incorrect password' }, 401);
    }
  }

  // Get the chunk
  const chunk = await c.env.DB.prepare(
    "SELECT telegram_file_id, size FROM chunks WHERE file_id = ? AND chunk_index = ? AND upload_status = 'complete'"
  )
    .bind(share.file_id, Number(chunkIndex))
    .first<{ telegram_file_id: string; size: number }>();

  if (!chunk || !chunk.telegram_file_id) {
    return c.json({ success: false, error: 'Chunk not found' }, 404);
  }

  // Telegram Bot API does not permit bots to download files/chunks larger than 20 MB (20,971,520 bytes)
  if (chunk.size > 20971520) {
    return c.json({
      success: false,
      error: `This file was uploaded with a legacy chunk size (${(chunk.size / (1024 * 1024)).toFixed(1)}MB) exceeding Telegram's 20MB bot download limit. Please delete and re-upload this file.`
    }, 400);
  }

  try {
    const { service: telegram, value: tgFileId } = TelegramService.fromPrefixedValue(
      c.env.TELEGRAM_BOT_TOKEN,
      c.env.TELEGRAM_CHAT_ID,
      chunk.telegram_file_id
    );

    const fileInfo = await telegram.getFile(tgFileId);
    if (!fileInfo.file_path) {
      return c.json({ success: false, error: 'File path unavailable' }, 500);
    }

    const telegramResponse = await telegram.downloadFile(fileInfo.file_path);

    // Increment download count only on the first chunk
    if (Number(chunkIndex) === 0) {
      await c.env.DB.prepare(
        'UPDATE shared_links SET download_count = download_count + 1 WHERE token = ?'
      )
        .bind(token)
        .run();
    }

    return new Response(telegramResponse.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.size),
        'Content-Disposition': `attachment; filename="chunk_${chunkIndex}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chunk download failed';
    return c.json({ success: false, error: message }, 500);
  }
});

