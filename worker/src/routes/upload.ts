/**
 * TeleDrive Worker — Upload Routes
 *
 * Handles file upload lifecycle:
 * - Initialize upload session
 * - Receive and forward chunks to Telegram
 * - Complete/cancel uploads
 * - Resume interrupted uploads
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now, getExtension } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';

export const uploadRoutes = new Hono<AppType>();

/**
 * POST /api/upload/init
 * Initialize a new file upload. Creates the file record, chunk records,
 * and an upload session for tracking progress.
 */
uploadRoutes.post('/init', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    fileName: string;
    fileSize: number;
    mimeType: string;
    folderId?: string;
    chunkCount: number;
    sha256Hash?: string;
    chunks: Array<{ index: number; size: number }>;
  }>();

  const { fileName, fileSize, mimeType, folderId, chunkCount, sha256Hash, chunks } = body;

  if (!fileName || !fileSize || !chunkCount || !chunks) {
    return c.json({ success: false, error: 'Missing required fields' }, 400);
  }

  const fileId = generateId();
  const sessionId = generateId();
  const extension = getExtension(fileName);
  const timestamp = now();

  // Validate folder exists if provided
  if (folderId) {
    const folder = await c.env.DB.prepare(
      'SELECT id FROM folders WHERE id = ? AND user_id = ? AND is_trashed = 0'
    )
      .bind(folderId, userId)
      .first();

    if (!folder) {
      return c.json({ success: false, error: 'Folder not found' }, 404);
    }
  }

  // Create file record
  await c.env.DB.prepare(
    `INSERT INTO files (id, user_id, folder_id, name, extension, mime_type, size, chunk_count, sha256_hash, upload_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`
  )
    .bind(fileId, userId, folderId || null, fileName, extension, mimeType, fileSize, chunkCount, sha256Hash || null, timestamp, timestamp)
    .run();

  // Create chunk records
  const chunkInserts = chunks.map((chunk) => {
    const chunkId = generateId();
    return c.env.DB.prepare(
      `INSERT INTO chunks (id, file_id, chunk_index, size, upload_status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).bind(chunkId, fileId, chunk.index, chunk.size, timestamp);
  });

  // Batch insert chunks
  await c.env.DB.batch(chunkInserts);

  // Create upload session
  await c.env.DB.prepare(
    `INSERT INTO upload_sessions (id, file_id, user_id, total_chunks, completed_chunks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`
  )
    .bind(sessionId, fileId, userId, chunkCount, timestamp, timestamp)
    .run();

  return c.json({
    success: true,
    data: {
      fileId,
      sessionId,
      totalChunks: chunkCount,
    },
  });
});

/**
 * POST /api/upload/chunk
 * Upload a single chunk. The Worker receives the chunk data,
 * forwards it to Telegram as a document, and records the result.
 */
uploadRoutes.post('/chunk', async (c) => {
  const userId = c.get('userId');
  const formData = await c.req.formData();

  const fileId = formData.get('fileId') as string;
  const sessionId = formData.get('sessionId') as string;
  const chunkIndex = parseInt(formData.get('chunkIndex') as string, 10);
  const chunkHash = formData.get('chunkHash') as string | null;
  const chunkFile = formData.get('chunk') as unknown as File;

  if (!fileId || !sessionId || isNaN(chunkIndex) || !chunkFile) {
    return c.json({ success: false, error: 'Missing required fields' }, 400);
  }

  // Verify session belongs to user and is active
  const session = await c.env.DB.prepare(
    'SELECT id, status FROM upload_sessions WHERE id = ? AND user_id = ? AND file_id = ?'
  )
    .bind(sessionId, userId, fileId)
    .first<{ id: string; status: string }>();

  if (!session) {
    return c.json({ success: false, error: 'Upload session not found' }, 404);
  }

  if (session.status !== 'active') {
    return c.json({ success: false, error: `Upload session is ${session.status}` }, 400);
  }

  // Check if chunk already uploaded (for resume support)
  const existingChunk = await c.env.DB.prepare(
    "SELECT id, upload_status FROM chunks WHERE file_id = ? AND chunk_index = ? AND upload_status = 'complete'"
  )
    .bind(fileId, chunkIndex)
    .first();

  if (existingChunk) {
    return c.json({
      success: true,
      data: { chunkIndex, status: 'already_uploaded' },
    });
  }

  // Update chunk status to uploading
  await c.env.DB.prepare(
    "UPDATE chunks SET upload_status = 'uploading' WHERE file_id = ? AND chunk_index = ?"
  )
    .bind(fileId, chunkIndex)
    .run();

  try {
    // Forward chunk to Telegram (using bot pool)
    const { service: telegram, botIndex } = TelegramService.fromPool(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, chunkIndex);
    const chunkData = await chunkFile.arrayBuffer();

    // Get original file name and chunk count for context
    const file = await c.env.DB.prepare('SELECT name, chunk_count FROM files WHERE id = ?')
      .bind(fileId)
      .first<{ name: string; chunk_count: number }>();

    // Keep original filename for single-chunk uploads so Telegram detects format & auto-generates thumbnails
    const chunkFileName = file
      ? (file.chunk_count === 1 ? file.name : `${file.name}.chunk_${chunkIndex}`)
      : `chunk_${chunkIndex}`;

    const message = await telegram.sendDocument(
      chunkData,
      chunkFileName,
      `TeleDrive | ${file?.name || fileId} | Chunk ${chunkIndex + 1}`
    );

    // Save Telegram's auto-generated thumbnail if available (e.g. for videos, images, pdfs)
    const docThumb = message.document?.thumbnail || message.document?.thumb;
    if (docThumb && docThumb.file_id) {
      const thumbnailMsgId = `${botIndex}:${docThumb.file_id}`;
      await c.env.DB.prepare(
        'UPDATE files SET thumbnail_msg_id = ? WHERE id = ?'
      )
        .bind(thumbnailMsgId, fileId)
        .run();
    }

    const telegramMessageId = `${botIndex}:${message.message_id}`;
    const telegramFileId = `${botIndex}:${message.document?.file_id || ''}`;
    const timestamp = now();

    // Update chunk record with Telegram info
    await c.env.DB.prepare(
      `UPDATE chunks SET 
        telegram_message_id = ?, 
        telegram_file_id = ?, 
        sha256_hash = ?,
        upload_status = 'complete',
        created_at = ?
       WHERE file_id = ? AND chunk_index = ?`
    )
      .bind(telegramMessageId, telegramFileId, chunkHash, timestamp, fileId, chunkIndex)
      .run();

    // Update session progress
    await c.env.DB.prepare(
      `UPDATE upload_sessions SET 
        completed_chunks = completed_chunks + 1, 
        updated_at = ? 
       WHERE id = ?`
    )
      .bind(timestamp, sessionId)
      .run();

    return c.json({
      success: true,
      data: {
        chunkIndex,
        telegramMessageId,
        telegramFileId,
        status: 'complete',
      },
    });
  } catch (error) {
    // Update chunk as failed with retry count
    await c.env.DB.prepare(
      "UPDATE chunks SET upload_status = 'failed', retry_count = retry_count + 1 WHERE file_id = ? AND chunk_index = ?"
    )
      .bind(fileId, chunkIndex)
      .run();

    console.error('Chunk upload failed:', error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * POST /api/upload/complete
 * Finalize an upload session. Marks the file as complete.
 */
uploadRoutes.post('/complete', async (c) => {
  const userId = c.get('userId');
  const { sessionId, fileId } = await c.req.json<{
    sessionId: string;
    fileId: string;
  }>();

  // Verify all chunks are uploaded
  const pendingChunks = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM chunks WHERE file_id = ? AND upload_status != 'complete'"
  )
    .bind(fileId)
    .first<{ count: number }>();

  if (pendingChunks && pendingChunks.count > 0) {
    return c.json({
      success: false,
      error: `${pendingChunks.count} chunks still pending`,
    }, 400);
  }

  const timestamp = now();

  // Update file status
  await c.env.DB.prepare(
    "UPDATE files SET upload_status = 'complete', updated_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(timestamp, fileId, userId)
    .run();

  // Update session status
  await c.env.DB.prepare(
    "UPDATE upload_sessions SET status = 'complete', updated_at = ? WHERE id = ?"
  )
    .bind(timestamp, sessionId)
    .run();

  // Run thumbnail auto-generation fallback in background context to avoid blocking the client
  const runBackgroundThumbnail = async () => {
    try {
      const file = await c.env.DB.prepare(
        "SELECT id, name, mime_type, chunk_count, thumbnail_msg_id FROM files WHERE id = ? AND user_id = ?"
      )
        .bind(fileId, userId)
        .first<{ id: string; name: string; mime_type: string | null; chunk_count: number; thumbnail_msg_id: string | null }>();

      if (!file || file.thumbnail_msg_id) {
        return; // Already set by the chunk upload trigger or file missing
      }

      // Check format support via mime or filename extension
      const THUMBNAIL_MIME_TYPES = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/svg+xml',
      ];
      const isImage = file.mime_type && THUMBNAIL_MIME_TYPES.some((t) => file.mime_type!.startsWith(t.split('/')[0] + '/'));
      const hasImageExt = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes((file.name.split('.').pop() || '').toLowerCase());

      if ((isImage || hasImageExt) && file.chunk_count === 1) {
        // Get the first chunk to use as thumbnail source
        const chunk = await c.env.DB.prepare(
          "SELECT telegram_file_id FROM chunks WHERE file_id = ? AND chunk_index = 0 AND upload_status = 'complete'"
        )
          .bind(fileId)
          .first<{ telegram_file_id: string }>();

        if (chunk && chunk.telegram_file_id) {
          const { service: downloadTelegram, value: tgFileId } = TelegramService.fromPrefixedValue(
            c.env.TELEGRAM_BOT_TOKEN,
            c.env.TELEGRAM_CHAT_ID,
            chunk.telegram_file_id
          );

          const fileInfo = await downloadTelegram.getFile(tgFileId);
          if (fileInfo.file_path) {
            const downloadResponse = await downloadTelegram.downloadFile(fileInfo.file_path);
            const imageData = await downloadResponse.arrayBuffer();

            const { service: uploadTelegram, botIndex } = TelegramService.fromPool(
              c.env.TELEGRAM_BOT_TOKEN,
              c.env.TELEGRAM_CHAT_ID,
              0
            );

            const photoMessage = await uploadTelegram.sendPhoto(
              imageData,
              `thumb_${file.name}`,
              `TeleDrive Thumbnail | ${file.name}`
            );

            const photos = photoMessage.photo || [];
            const bestPhoto = photos.length > 1 ? photos[1] : (photos.length > 0 ? photos[0] : null);
            const thumbnailFileId = bestPhoto
              ? `${botIndex}:${bestPhoto.file_id}|${photoMessage.message_id}`
              : null;

            if (thumbnailFileId) {
              await c.env.DB.prepare(
                'UPDATE files SET thumbnail_msg_id = ? WHERE id = ? AND user_id = ?'
              )
                .bind(thumbnailFileId, fileId, userId)
                .run();
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to auto-generate thumbnail in background:', error);
    }
  };

  if (c.env.ENVIRONMENT === 'development') {
    setTimeout(() => {
      runBackgroundThumbnail();
    }, 10);
  } else if (c.executionCtx) {
    c.executionCtx.waitUntil(runBackgroundThumbnail());
  } else {
    setTimeout(() => {
      runBackgroundThumbnail();
    }, 10);
  }

  return c.json({
    success: true,
    data: { fileId, status: 'complete' },
  });
});

/**
 * GET /api/upload/sessions
 * List all upload sessions for the current user.
 */
uploadRoutes.get('/sessions', async (c) => {
  const userId = c.get('userId');
  const status = c.req.query('status'); // active, paused, complete, failed

  let query = `
    SELECT us.*, f.name as file_name, f.size as file_size, f.mime_type
    FROM upload_sessions us
    JOIN files f ON us.file_id = f.id
    WHERE us.user_id = ?
  `;
  const params: string[] = [userId];

  if (status) {
    query += ' AND us.status = ?';
    params.push(status);
  }

  query += ' ORDER BY us.updated_at DESC LIMIT 50';

  const { results } = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ success: true, data: results });
});

/**
 * POST /api/upload/pause/:sessionId
 * Pause an active upload session.
 */
uploadRoutes.post('/pause/:sessionId', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');

  await c.env.DB.prepare(
    "UPDATE upload_sessions SET status = 'paused', updated_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(now(), sessionId, userId)
    .run();

  return c.json({ success: true, data: { sessionId, status: 'paused' } });
});

/**
 * POST /api/upload/resume/:sessionId
 * Resume a paused upload session. Returns pending chunk indices.
 */
uploadRoutes.post('/resume/:sessionId', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');

  const session = await c.env.DB.prepare(
    'SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?'
  )
    .bind(sessionId, userId)
    .first();

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  // Get pending chunks
  const { results: pendingChunks } = await c.env.DB.prepare(
    "SELECT chunk_index, size FROM chunks WHERE file_id = ? AND upload_status != 'complete' ORDER BY chunk_index"
  )
    .bind(session.file_id as string)
    .all();

  await c.env.DB.prepare(
    "UPDATE upload_sessions SET status = 'active', updated_at = ? WHERE id = ?"
  )
    .bind(now(), sessionId)
    .run();

  return c.json({
    success: true,
    data: {
      sessionId,
      fileId: session.file_id,
      status: 'active',
      pendingChunks,
    },
  });
});

/**
 * DELETE /api/upload/cancel/:sessionId
 * Cancel an upload session. Deletes Telegram messages for uploaded chunks
 * and removes the file record.
 */
uploadRoutes.delete('/cancel/:sessionId', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');

  const session = await c.env.DB.prepare(
    'SELECT file_id FROM upload_sessions WHERE id = ? AND user_id = ?'
  )
    .bind(sessionId, userId)
    .first<{ file_id: string }>();

  if (!session) {
    return c.json({ success: false, error: 'Session not found' }, 404);
  }

  // Get uploaded chunks to delete from Telegram
  const { results: chunks } = await c.env.DB.prepare(
    "SELECT telegram_message_id FROM chunks WHERE file_id = ? AND upload_status = 'complete' AND telegram_message_id IS NOT NULL"
  )
    .bind(session.file_id)
    .all();

  // Delete Telegram messages in background
  for (const chunk of chunks) {
    try {
      const { service: telegram, value: msgId } = TelegramService.fromPrefixedValue(
        c.env.TELEGRAM_BOT_TOKEN,
        c.env.TELEGRAM_CHAT_ID,
        chunk.telegram_message_id as string
      );
      await telegram.deleteMessage(Number(msgId));
    } catch {
      // Best-effort deletion
    }
  }

  // Clean up DB records (CASCADE handles chunks)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?').bind(sessionId),
    c.env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(session.file_id, userId),
  ]);

  return c.json({ success: true, data: { sessionId, status: 'cancelled' } });
});
