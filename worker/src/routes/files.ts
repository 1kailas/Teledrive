/**
 * TeleDrive Worker — File Routes
 *
 * CRUD operations for files:
 * - List, get details, rename, move, favorite, trash, restore, delete
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';
import type { DBFile } from '../types/index.js';

export const fileRoutes = new Hono<AppType>();

/**
 * GET /api/files
 * List files with pagination, filtering, and sorting.
 */
fileRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.query('folderId') || null;
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = Math.min(parseInt(c.req.query('pageSize') || '50', 10), 100);
  const sortBy = c.req.query('sortBy') || 'created_at';
  const sortOrder = c.req.query('sortOrder') || 'desc';

  const allowedSort = ['name', 'size', 'created_at', 'updated_at', 'extension'];
  const sort = allowedSort.includes(sortBy) ? sortBy : 'created_at';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  const offset = (page - 1) * pageSize;

  // Build query based on whether folderId is specified
  let filesQuery: string;
  let countQuery: string;
  const params: (string | number | null)[] = [userId];

  if (folderId === 'root' || folderId === null) {
    filesQuery = `
      SELECT * FROM files 
      WHERE user_id = ? AND folder_id IS NULL AND is_trashed = 0 AND upload_status = 'complete'
      ORDER BY ${sort} ${order} LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total FROM files 
      WHERE user_id = ? AND folder_id IS NULL AND is_trashed = 0 AND upload_status = 'complete'
    `;
  } else {
    filesQuery = `
      SELECT * FROM files 
      WHERE user_id = ? AND folder_id = ? AND is_trashed = 0 AND upload_status = 'complete'
      ORDER BY ${sort} ${order} LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total FROM files 
      WHERE user_id = ? AND folder_id = ? AND is_trashed = 0 AND upload_status = 'complete'
    `;
    params.push(folderId);
  }

  const countParams = [...params];
  params.push(pageSize, offset);

  const [filesResult, countResult] = await Promise.all([
    c.env.DB.prepare(filesQuery).bind(...params).all(),
    c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
  ]);

  return c.json({
    success: true,
    data: filesResult.results,
    total: countResult?.total || 0,
    page,
    pageSize,
    totalPages: Math.ceil((countResult?.total || 0) / pageSize),
  });
});

/**
 * GET /api/files/:id
 * Get detailed file info including chunk data.
 */
fileRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');

  const file = await c.env.DB.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ?'
  )
    .bind(fileId, userId)
    .first<DBFile>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  const { results: chunks } = await c.env.DB.prepare(
    'SELECT chunk_index, size, upload_status, telegram_file_id FROM chunks WHERE file_id = ? ORDER BY chunk_index'
  )
    .bind(fileId)
    .all();

  return c.json({
    success: true,
    data: { ...file, chunks },
  });
});

/**
 * PATCH /api/files/:id
 * Update file properties: rename, move, favorite, tags.
 */
fileRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    folderId?: string | null;
    isFavorite?: boolean;
    tags?: string[];
  }>();

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    params.push(body.name);

    // Update extension too
    const ext = body.name.includes('.') 
      ? body.name.substring(body.name.lastIndexOf('.') + 1).toLowerCase()
      : null;
    updates.push('extension = ?');
    params.push(ext);
  }

  if (body.folderId !== undefined) {
    updates.push('folder_id = ?');
    params.push(body.folderId);
  }

  if (body.isFavorite !== undefined) {
    updates.push('is_favorite = ?');
    params.push(body.isFavorite ? 1 : 0);
  }

  if (body.tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(body.tags));
  }

  if (updates.length === 0) {
    return c.json({ success: false, error: 'No updates provided' }, 400);
  }

  updates.push('updated_at = ?');
  params.push(now());
  params.push(fileId, userId);

  await c.env.DB.prepare(
    `UPDATE files SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  )
    .bind(...params)
    .run();

  return c.json({ success: true });
});

/**
 * DELETE /api/files/:id
 * Move a file to trash (soft delete).
 */
fileRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');
  const timestamp = now();

  await c.env.DB.prepare(
    'UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  )
    .bind(timestamp, timestamp, fileId, userId)
    .run();

  return c.json({ success: true });
});

/**
 * POST /api/files/:id/restore
 * Restore a file from trash.
 */
fileRoutes.post('/:id/restore', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');

  await c.env.DB.prepare(
    'UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
  )
    .bind(now(), fileId, userId)
    .run();

  return c.json({ success: true });
});

/**
 * DELETE /api/files/:id/permanent
 * Permanently delete a file. Also deletes all chunks from Telegram.
 */
fileRoutes.delete('/:id/permanent', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');

  // Get all Telegram message IDs for this file
  const { results: chunks } = await c.env.DB.prepare(
    'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
  )
    .bind(fileId)
    .all();

  // Delete from Telegram
  const telegram = new TelegramService(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);
  for (const chunk of chunks) {
    try {
      await telegram.deleteMessage(Number(chunk.telegram_message_id));
    } catch {
      // Best-effort — continue even if Telegram delete fails
    }
  }

  // Delete from DB (CASCADE handles chunks, favorites, recent)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(fileId, userId),
  ]);

  return c.json({ success: true });
});

/**
 * POST /api/files/:id/duplicate
 * Create a copy of a file's metadata (shares same Telegram messages).
 */
fileRoutes.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('id');

  const file = await c.env.DB.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ?'
  )
    .bind(fileId, userId)
    .first<DBFile>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  const newFileId = crypto.randomUUID();
  const timestamp = now();
  const newName = `${file.name.replace(/(\.[^.]+)$/, '')} (copy)${file.extension ? '.' + file.extension : ''}`;

  // Copy file record
  await c.env.DB.prepare(
    `INSERT INTO files (id, user_id, folder_id, name, extension, mime_type, size, chunk_count, sha256_hash, upload_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)`
  )
    .bind(newFileId, userId, file.folder_id, newName, file.extension, file.mime_type, file.size, file.chunk_count, file.sha256_hash, timestamp, timestamp)
    .run();

  // Copy chunk records (share Telegram references)
  const { results: chunks } = await c.env.DB.prepare(
    'SELECT * FROM chunks WHERE file_id = ?'
  )
    .bind(fileId)
    .all();

  if (chunks.length > 0) {
    const chunkInserts = chunks.map((ch) =>
      c.env.DB.prepare(
        `INSERT INTO chunks (id, file_id, chunk_index, telegram_message_id, telegram_file_id, size, sha256_hash, upload_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?)`
      ).bind(
        crypto.randomUUID(),
        newFileId,
        ch.chunk_index as number,
        ch.telegram_message_id as string,
        ch.telegram_file_id as string,
        ch.size as number,
        ch.sha256_hash as string,
        timestamp
      )
    );

    await c.env.DB.batch(chunkInserts);
  }

  return c.json({
    success: true,
    data: { fileId: newFileId, name: newName },
  });
});
