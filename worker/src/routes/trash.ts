/**
 * TeleDrive Worker — Trash Routes
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';

export const trashRoutes = new Hono<AppType>();

/**
 * GET /api/trash
 * List all trashed files and folders.
 */
trashRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const [filesResult, foldersResult] = await Promise.all([
    c.env.DB.prepare(
      'SELECT * FROM files WHERE user_id = ? AND is_trashed = 1 ORDER BY trashed_at DESC'
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare(
      'SELECT * FROM folders WHERE user_id = ? AND is_trashed = 1 ORDER BY trashed_at DESC'
    )
      .bind(userId)
      .all(),
  ]);

  return c.json({
    success: true,
    data: {
      files: filesResult.results,
      folders: foldersResult.results,
    },
  });
});

/**
 * POST /api/trash/restore/:id
 * Restore a file or folder from trash.
 */
trashRoutes.post('/restore/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const type = c.req.query('type') || 'file';
  const timestamp = now();

  if (type === 'folder') {
    await c.env.DB.prepare(
      'UPDATE folders SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(timestamp, id, userId)
      .run();

    // Also restore files in this folder
    await c.env.DB.prepare(
      'UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE folder_id = ? AND user_id = ?'
    )
      .bind(timestamp, id, userId)
      .run();
  } else {
    await c.env.DB.prepare(
      'UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(timestamp, id, userId)
      .run();
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/trash/:id
 * Permanently delete a single trashed item.
 */
trashRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const type = c.req.query('type') || 'file';

  if (type === 'file') {
    // Delete chunks from Telegram
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
    )
      .bind(id)
      .all();

    const telegram = new TelegramService(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);
    for (const chunk of chunks) {
      try {
        await telegram.deleteMessage(Number(chunk.telegram_message_id));
      } catch {
        // Best-effort
      }
    }

    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(id, userId),
    ]);
  } else {
    // For folders, permanently delete all contained files too
    const { results: files } = await c.env.DB.prepare(
      'SELECT id FROM files WHERE folder_id = ? AND user_id = ?'
    )
      .bind(id, userId)
      .all();

    for (const file of files) {
      const { results: chunks } = await c.env.DB.prepare(
        'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
      )
        .bind(file.id as string)
        .all();

      const telegram = new TelegramService(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);
      for (const chunk of chunks) {
        try {
          await telegram.deleteMessage(Number(chunk.telegram_message_id));
        } catch {
          // Best-effort
        }
      }
    }

    await c.env.DB.batch([
      ...files.map((f) => c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(f.id as string)),
      ...files.map((f) => c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f.id as string)),
      c.env.DB.prepare('DELETE FROM favorites WHERE folder_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(id, userId),
    ]);
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/trash/empty
 * Empty the entire trash.
 */
trashRoutes.delete('/', async (c) => {
  const userId = c.get('userId');

  // Get all trashed files
  const { results: trashedFiles } = await c.env.DB.prepare(
    'SELECT id FROM files WHERE user_id = ? AND is_trashed = 1'
  )
    .bind(userId)
    .all();

  // Delete all chunks from Telegram
  const telegram = new TelegramService(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID);

  for (const file of trashedFiles) {
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
    )
      .bind(file.id as string)
      .all();

    for (const chunk of chunks) {
      try {
        await telegram.deleteMessage(Number(chunk.telegram_message_id));
      } catch {
        // Best-effort
      }
    }
  }

  // Batch delete all trashed items
  await c.env.DB.batch([
    ...trashedFiles.map((f) => c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(f.id as string)),
    ...trashedFiles.map((f) => c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(f.id as string)),
    ...trashedFiles.map((f) => c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(f.id as string)),
    ...trashedFiles.map((f) => c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(f.id as string)),
    c.env.DB.prepare('DELETE FROM files WHERE user_id = ? AND is_trashed = 1').bind(userId),
    c.env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ? AND is_trashed = 1)').bind(userId, userId),
    c.env.DB.prepare('DELETE FROM folders WHERE user_id = ? AND is_trashed = 1').bind(userId),
  ]);

  return c.json({ success: true });
});
