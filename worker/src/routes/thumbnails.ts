/**
 * TeleDrive Worker — Thumbnail Routes
 *
 * Generate and serve image thumbnails using Telegram's photo API.
 * Thumbnails are auto-compressed by Telegram for fast loading.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { TelegramService } from '../services/telegram.js';
import type { DBFile } from '../types/index.js';
import { now } from '../db/queries.js';

export const thumbnailRoutes = new Hono<AppType>();

/** MIME types that support thumbnail generation */
const THUMBNAIL_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
];

/**
 * Check if a file supports thumbnail generation.
 */
export function supportsThumbnail(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return THUMBNAIL_MIME_TYPES.some((t) => mimeType.startsWith(t.split('/')[0] + '/'));
}

/**
 * POST /api/thumbnails/:fileId
 * Generate a thumbnail for a file by forwarding its first chunk
 * to Telegram as a photo (auto-compressed).
 */
thumbnailRoutes.post('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  // Get file info
  const file = await c.env.DB.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete'"
  )
    .bind(fileId, userId)
    .first<DBFile>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  if (!supportsThumbnail(file.mime_type)) {
    return c.json({ success: false, error: 'File type does not support thumbnails' }, 400);
  }

  // Already has a thumbnail
  if (file.thumbnail_msg_id) {
    return c.json({ success: true, data: { thumbnailMsgId: file.thumbnail_msg_id } });
  }

  try {
    // Get the first chunk to use as thumbnail source
    const chunk = await c.env.DB.prepare(
      "SELECT telegram_file_id FROM chunks WHERE file_id = ? AND chunk_index = 0 AND upload_status = 'complete'"
    )
      .bind(fileId)
      .first<{ telegram_file_id: string }>();

    if (!chunk || !chunk.telegram_file_id) {
      return c.json({ success: false, error: 'File data not available' }, 404);
    }

    // Download the first chunk from Telegram
    const { service: downloadTelegram, value: tgFileId } = TelegramService.fromPrefixedValue(
      c.env.TELEGRAM_BOT_TOKEN,
      c.env.TELEGRAM_CHAT_ID,
      chunk.telegram_file_id
    );

    const fileInfo = await downloadTelegram.getFile(tgFileId);
    if (!fileInfo.file_path) {
      return c.json({ success: false, error: 'Cannot retrieve file from Telegram' }, 500);
    }

    const downloadResponse = await downloadTelegram.downloadFile(fileInfo.file_path);
    const imageData = await downloadResponse.arrayBuffer();

    // Send as photo to Telegram (auto-compressed thumbnail)
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

    // Store the medium size photo file_id as thumbnail for optimal resolution & speed
    const photos = photoMessage.photo || [];
    const bestPhoto = photos.length > 1 ? photos[1] : (photos.length > 0 ? photos[0] : null);
    const thumbnailFileId = bestPhoto
      ? `${botIndex}:${bestPhoto.file_id}|${photoMessage.message_id}`
      : null;

    if (!thumbnailFileId) {
      return c.json({ success: false, error: 'Failed to extract photo from message' }, 500);
    }

    // Update file record with thumbnail info
    await c.env.DB.prepare(
      'UPDATE files SET thumbnail_msg_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(thumbnailFileId, now(), fileId, userId)
      .run();

    return c.json({
      success: true,
      data: {
        thumbnailMsgId: thumbnailFileId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Thumbnail generation failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * GET /api/thumbnails/:fileId
 * Stream the thumbnail image for a file.
 */
thumbnailRoutes.get('/:fileId', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  const file = await c.env.DB.prepare(
    'SELECT thumbnail_msg_id, mime_type, name FROM files WHERE id = ? AND user_id = ?'
  )
    .bind(fileId, userId)
    .first<{ thumbnail_msg_id: string | null; mime_type: string | null; name: string }>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  if (!file.thumbnail_msg_id) {
    return c.json({ success: false, error: 'No thumbnail available' }, 404);
  }

  try {
    const { service: telegram, value: prefixedValue } = TelegramService.fromPrefixedValue(
      c.env.TELEGRAM_BOT_TOKEN,
      c.env.TELEGRAM_CHAT_ID,
      file.thumbnail_msg_id
    );

    const tgFileId = prefixedValue.split('|')[0];
    const fileInfo = await telegram.getFile(tgFileId);
    if (!fileInfo.file_path) {
      return c.json({ success: false, error: 'Thumbnail path unavailable' }, 500);
    }

    const telegramResponse = await telegram.downloadFile(fileInfo.file_path);

    return new Response(telegramResponse.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800', // Cache for 7 days
        'X-Thumbnail': 'true',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load thumbnail';
    return c.json({ success: false, error: message }, 500);
  }
});
