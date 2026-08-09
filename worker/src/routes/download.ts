/**
 * TeleDrive Worker — Download Routes
 *
 * Handles file download lifecycle:
 * - Get download info (chunk list)
 * - Stream individual chunks from Telegram
 * - Download session tracking for resume
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';
import type { DBFile } from '../types/index.js';

export const downloadRoutes = new Hono<AppType>();

/**
 * GET /api/download/:fileId/info
 * Get download info: file metadata + chunk list for the browser to plan downloads.
 */
downloadRoutes.get('/:fileId/info', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete'"
  )
    .bind(fileId, userId)
    .first<DBFile>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  const { results: chunks } = await c.env.DB.prepare(
    "SELECT chunk_index, size, telegram_file_id, sha256_hash FROM chunks WHERE file_id = ? AND upload_status = 'complete' ORDER BY chunk_index"
  )
    .bind(fileId)
    .all();

  // Record in recent files
  const recentId = generateId();
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO recent_files (id, user_id, file_id, accessed_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(recentId, userId, fileId, now())
    .run();

  return c.json({
    success: true,
    data: {
      fileId: file.id,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.mime_type,
      sha256Hash: file.sha256_hash,
      chunkCount: file.chunk_count,
      chunks: chunks.map((ch) => ({
        index: ch.chunk_index,
        size: ch.size,
        telegramFileId: ch.telegram_file_id,
        sha256Hash: ch.sha256_hash,
      })),
    },
  });
});

/**
 * GET /api/download/:fileId/chunk/:index
 * Stream a single chunk from Telegram back to the browser.
 * The Worker acts as a proxy: Telegram → Worker → Browser.
 */
downloadRoutes.get('/:fileId/chunk/:index', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');
  const chunkIndex = parseInt(c.req.param('index'), 10);

  // Verify file ownership
  const file = await c.env.DB.prepare(
    'SELECT id, name FROM files WHERE id = ? AND user_id = ?'
  )
    .bind(fileId, userId)
    .first<{ id: string; name: string }>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  // Get chunk info
  const chunk = await c.env.DB.prepare(
    "SELECT telegram_file_id, size FROM chunks WHERE file_id = ? AND chunk_index = ? AND upload_status = 'complete'"
  )
    .bind(fileId, chunkIndex)
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
    const { service: telegram, value: fileId } = TelegramService.fromPrefixedValue(
      c.env.TELEGRAM_BOT_TOKEN,
      c.env.TELEGRAM_CHAT_ID,
      chunk.telegram_file_id
    );

    // Get temporary file path from Telegram
    const fileInfo = await telegram.getFile(fileId);
    if (!fileInfo.file_path) {
      return c.json({ success: false, error: 'File path unavailable' }, 500);
    }

    // Stream from Telegram
    const telegramResponse = await telegram.downloadFile(fileInfo.file_path);

    // Forward the response with appropriate headers
    return new Response(telegramResponse.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.size),
        'Content-Disposition': `attachment; filename="${file.name}.chunk_${chunkIndex}"`,
        'X-Chunk-Index': String(chunkIndex),
        'X-Chunk-Size': String(chunk.size),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * GET /api/download/:fileId
 * Direct download for single-chunk files. Streams the file with correct
 * Content-Disposition for browser download.
 */
downloadRoutes.get('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete'"
  )
    .bind(fileId, userId)
    .first<DBFile>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  // For multi-chunk files, return info instead
  if (file.chunk_count > 1) {
    return c.json({
      success: false,
      error: 'Multi-chunk file — use /info endpoint to get chunk list',
      data: { chunkCount: file.chunk_count },
    }, 400);
  }

  // Telegram Bot API does not permit bots to download files/chunks larger than 20 MB (20,971,520 bytes)
  if (file.size > 20971520) {
    return c.json({
      success: false,
      error: `File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds Telegram's 20MB bot download limit. Please re-upload as a multi-chunk file.`
    }, 400);
  }

  // Get the single chunk
  const chunk = await c.env.DB.prepare(
    "SELECT telegram_file_id FROM chunks WHERE file_id = ? AND chunk_index = 0 AND upload_status = 'complete'"
  )
    .bind(fileId)
    .first<{ telegram_file_id: string }>();

  if (!chunk || !chunk.telegram_file_id) {
    return c.json({ success: false, error: 'File data not found' }, 404);
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

    // Record access
    const recentId = generateId();
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO recent_files (id, user_id, file_id, accessed_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(recentId, userId, fileId, now())
      .run();

    return new Response(telegramResponse.body, {
      status: 200,
      headers: {
        'Content-Type': file.mime_type || 'application/octet-stream',
        'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * POST /api/download/session
 * Create a download session for tracking multi-chunk download progress.
 */
downloadRoutes.post('/session', async (c) => {
  const userId = c.get('userId');
  const { fileId } = await c.req.json<{ fileId: string }>();

  const file = await c.env.DB.prepare(
    "SELECT id, chunk_count FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete'"
  )
    .bind(fileId, userId)
    .first<{ id: string; chunk_count: number }>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  const sessionId = generateId();
  const timestamp = now();

  await c.env.DB.prepare(
    `INSERT INTO download_sessions (id, file_id, user_id, total_chunks, completed_chunks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`
  )
    .bind(sessionId, fileId, userId, file.chunk_count, timestamp, timestamp)
    .run();

  return c.json({
    success: true,
    data: { sessionId, fileId, totalChunks: file.chunk_count },
  });
});

/**
 * PATCH /api/download/session/:sessionId
 * Update download session progress.
 */
downloadRoutes.patch('/session/:sessionId', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');
  const { completedChunks, status } = await c.req.json<{
    completedChunks?: number;
    status?: string;
  }>();

  const updates: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now()];

  if (completedChunks !== undefined) {
    updates.push('completed_chunks = ?');
    params.push(completedChunks);
  }
  if (status) {
    updates.push('status = ?');
    params.push(status);
  }

  params.push(sessionId, userId);

  await c.env.DB.prepare(
    `UPDATE download_sessions SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  )
    .bind(...params)
    .run();

  return c.json({ success: true });
});
