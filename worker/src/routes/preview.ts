/**
 * TeleDrive Worker — File Preview Routes
 *
 * Stream files for inline preview with proper MIME types
 * and Range header support for video seeking.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { TelegramService } from '../services/telegram.js';
import type { DBFile } from '../types/index.js';

export const previewRoutes = new Hono<AppType>();

/** MIME types that can be previewed inline */
const PREVIEWABLE_TYPES = [
  'image/', 'video/', 'audio/',
  'application/pdf',
  'text/', 'application/json',
  'application/javascript',
  'application/xml',
];

/**
 * Check if a file type is previewable.
 */
export function isPreviewable(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return PREVIEWABLE_TYPES.some((t) => mimeType.startsWith(t));
}

/**
 * GET /api/preview/:fileId
 * Stream a file for inline preview.
 * Only works for single-chunk files or returns the first chunk for multi-chunk files.
 */
previewRoutes.get('/:fileId', async (c) => {
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

  if (!isPreviewable(file.mime_type)) {
    return c.json({ success: false, error: 'File type not previewable' }, 400);
  }

  // For multi-chunk files, we can only preview single-chunk or the first chunk
  const chunkIndex = file.chunk_count > 1 ? 0 : 0;

  const chunk = await c.env.DB.prepare(
    "SELECT telegram_file_id, size FROM chunks WHERE file_id = ? AND chunk_index = ? AND upload_status = 'complete'"
  )
    .bind(fileId, chunkIndex)
    .first<{ telegram_file_id: string; size: number }>();

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

    const headers: Record<string, string> = {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'none',
    };

    // For single-chunk files, include Content-Length
    if (file.chunk_count === 1) {
      headers['Content-Length'] = String(file.size);
    }

    return new Response(telegramResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview failed';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * GET /api/preview/:fileId/info
 * Get preview metadata (what type of preview to render, etc.)
 */
previewRoutes.get('/:fileId/info', async (c) => {
  const userId = c.get('userId');
  const fileId = c.req.param('fileId');

  const file = await c.env.DB.prepare(
    "SELECT id, name, extension, mime_type, size, chunk_count, thumbnail_msg_id FROM files WHERE id = ? AND user_id = ? AND upload_status = 'complete'"
  )
    .bind(fileId, userId)
    .first<Partial<DBFile>>();

  if (!file) {
    return c.json({ success: false, error: 'File not found' }, 404);
  }

  const previewable = isPreviewable(file.mime_type || null);
  let previewType: string = 'none';

  if (file.mime_type) {
    if (file.mime_type.startsWith('image/')) previewType = 'image';
    else if (file.mime_type.startsWith('video/')) previewType = 'video';
    else if (file.mime_type.startsWith('audio/')) previewType = 'audio';
    else if (file.mime_type === 'application/pdf') previewType = 'pdf';
    else if (file.mime_type.startsWith('text/') || file.mime_type === 'application/json' || file.mime_type === 'application/javascript' || file.mime_type === 'application/xml') previewType = 'text';
  }

  // Can only preview single-chunk files inline (Telegram's 20MB file limit)
  const canPreview = previewable && file.chunk_count === 1;

  return c.json({
    success: true,
    data: {
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mime_type,
      size: file.size,
      previewType,
      canPreview,
      hasThumbnail: !!file.thumbnail_msg_id,
    },
  });
});
