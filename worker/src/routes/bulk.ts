/**
 * TeleDrive Worker — Bulk Operations Routes
 *
 * Batch operations for multiple files/folders:
 * move, trash, restore, delete, favorite.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';

export const bulkRoutes = new Hono<AppType>();

/**
 * POST /api/bulk/move
 * Move multiple files/folders to a target folder.
 */
bulkRoutes.post('/move', async (c) => {
  const userId = c.get('userId');
  const { fileIds, folderIds, targetFolderId } = await c.req.json<{
    fileIds?: string[];
    folderIds?: string[];
    targetFolderId: string | null;
  }>();

  const timestamp = now();
  const statements: D1PreparedStatement[] = [];

  // Validate target folder
  if (targetFolderId) {
    const target = await c.env.DB.prepare(
      'SELECT id FROM folders WHERE id = ? AND user_id = ? AND is_trashed = 0'
    )
      .bind(targetFolderId, userId)
      .first();

    if (!target) {
      return c.json({ success: false, error: 'Target folder not found' }, 404);
    }
  }

  // Move files
  if (fileIds && fileIds.length > 0) {
    for (const fileId of fileIds) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(targetFolderId, timestamp, fileId, userId)
      );
    }
  }

  // Move folders
  if (folderIds && folderIds.length > 0) {
    for (const folderId of folderIds) {
      // Prevent moving into itself
      if (folderId === targetFolderId) continue;
      statements.push(
        c.env.DB.prepare(
          'UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(targetFolderId, timestamp, folderId, userId)
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.json({
    success: true,
    data: { movedFiles: fileIds?.length || 0, movedFolders: folderIds?.length || 0 },
  });
});

/**
 * POST /api/bulk/trash
 * Move multiple files/folders to trash.
 */
bulkRoutes.post('/trash', async (c) => {
  const userId = c.get('userId');
  const { fileIds, folderIds } = await c.req.json<{
    fileIds?: string[];
    folderIds?: string[];
  }>();

  const timestamp = now();
  const statements: D1PreparedStatement[] = [];

  if (fileIds && fileIds.length > 0) {
    for (const fileId of fileIds) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(timestamp, timestamp, fileId, userId)
      );
    }
  }

  if (folderIds && folderIds.length > 0) {
    for (const folderId of folderIds) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE folders SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(timestamp, timestamp, folderId, userId)
      );
      // Also trash files in these folders
      statements.push(
        c.env.DB.prepare(
          'UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE folder_id = ? AND user_id = ?'
        ).bind(timestamp, timestamp, folderId, userId)
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.json({
    success: true,
    data: { trashedFiles: fileIds?.length || 0, trashedFolders: folderIds?.length || 0 },
  });
});

/**
 * POST /api/bulk/restore
 * Restore multiple files/folders from trash.
 */
bulkRoutes.post('/restore', async (c) => {
  const userId = c.get('userId');
  const { fileIds, folderIds } = await c.req.json<{
    fileIds?: string[];
    folderIds?: string[];
  }>();

  const timestamp = now();
  const statements: D1PreparedStatement[] = [];

  if (fileIds && fileIds.length > 0) {
    for (const fileId of fileIds) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(timestamp, fileId, userId)
      );
    }
  }

  if (folderIds && folderIds.length > 0) {
    for (const folderId of folderIds) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE folders SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
        ).bind(timestamp, folderId, userId)
      );
      // Also restore files
      statements.push(
        c.env.DB.prepare(
          'UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE folder_id = ? AND user_id = ?'
        ).bind(timestamp, folderId, userId)
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.json({ success: true });
});

/**
 * POST /api/bulk/favorite
 * Toggle favorite on multiple files.
 */
bulkRoutes.post('/favorite', async (c) => {
  const userId = c.get('userId');
  const { fileIds, isFavorite } = await c.req.json<{
    fileIds: string[];
    isFavorite: boolean;
  }>();

  const timestamp = now();
  const statements: D1PreparedStatement[] = [];

  for (const fileId of fileIds) {
    statements.push(
      c.env.DB.prepare(
        'UPDATE files SET is_favorite = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      ).bind(isFavorite ? 1 : 0, timestamp, fileId, userId)
    );
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.json({ success: true });
});

/**
 * POST /api/bulk/delete
 * Permanently delete multiple trashed files.
 */
bulkRoutes.post('/delete', async (c) => {
  const userId = c.get('userId');
  const { fileIds } = await c.req.json<{ fileIds: string[] }>();

  for (const fileId of fileIds) {
    // Delete thumbnail message if present
    const file = await c.env.DB.prepare(
      'SELECT thumbnail_msg_id FROM files WHERE id = ? AND user_id = ?'
    )
      .bind(fileId, userId)
      .first<{ thumbnail_msg_id: string | null }>();

    if (file && file.thumbnail_msg_id && file.thumbnail_msg_id.includes('|')) {
      try {
        const { service: telegram, value: prefixedValue } = TelegramService.fromPrefixedValue(
          c.env.TELEGRAM_BOT_TOKEN,
          c.env.TELEGRAM_CHAT_ID,
          file.thumbnail_msg_id
        );
        const msgId = prefixedValue.split('|')[1];
        if (msgId) {
          await telegram.deleteMessage(Number(msgId));
        }
      } catch {
        // Best-effort
      }
    }

    // Get Telegram message IDs
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
    )
      .bind(fileId)
      .all();

    // Delete from Telegram (best-effort)
    for (const chunk of chunks) {
      try {
        const { service: telegram, value: msgId } = TelegramService.fromPrefixedValue(
          c.env.TELEGRAM_BOT_TOKEN,
          c.env.TELEGRAM_CHAT_ID,
          chunk.telegram_message_id as string
        );
        await telegram.deleteMessage(Number(msgId));
      } catch {
        // Best-effort
      }
    }

    // Clean up DB
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM shared_links WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(fileId),
      c.env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(fileId, userId),
    ]);
  }

  return c.json({ success: true, data: { deletedCount: fileIds.length } });
});
