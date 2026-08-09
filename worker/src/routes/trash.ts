/**
 * TeleDrive Worker — Trash Routes
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { now } from '../db/queries.js';
import { TelegramService } from '../services/telegram.js';
import { safeBatch } from '../utils/db.js';

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
    // Delete thumbnail message if present
    const file = await c.env.DB.prepare(
      'SELECT thumbnail_msg_id FROM files WHERE id = ? AND user_id = ?'
    )
      .bind(id, userId)
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

    // Delete chunks from Telegram
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
    )
      .bind(id)
      .all();

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

    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM shared_links WHERE file_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(id, userId),
    ]);
  } else {
    // 1. Get all subfolders recursively
    const { results: allSubfolders } = await c.env.DB.prepare(
      `WITH RECURSIVE subfolders(id) AS (
         SELECT ? AS id
         UNION ALL
         SELECT f.id FROM folders f
         JOIN subfolders s ON f.parent_id = s.id
       )
       SELECT id FROM subfolders`
    )
      .bind(id)
      .all<{ id: string }>();

    const folderIds = allSubfolders.map((f) => f.id);

    // 2. Get all files in these folders
    const { results: files } = await c.env.DB.prepare(
      `SELECT id, thumbnail_msg_id FROM files WHERE folder_id IN (${folderIds.map(() => '?').join(', ')}) AND user_id = ?`
    )
      .bind(...folderIds, userId)
      .all<{ id: string; thumbnail_msg_id: string | null }>();

    // Delete all thumbnail messages
    for (const file of files) {
      if (file.thumbnail_msg_id && file.thumbnail_msg_id.includes('|')) {
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
    }

    // Delete all chunk messages
    for (const file of files) {
      const { results: chunks } = await c.env.DB.prepare(
        'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
      )
        .bind(file.id)
        .all();

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
    }

    // Batch DB cleanups
    const statements: D1PreparedStatement[] = [];
    for (const file of files) {
      statements.push(c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM shared_links WHERE file_id = ?').bind(file.id));
      statements.push(c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(file.id));
    }
    for (const fId of folderIds) {
      statements.push(c.env.DB.prepare('DELETE FROM favorites WHERE folder_id = ?').bind(fId));
      statements.push(c.env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(fId, userId));
    }

    if (statements.length > 0) {
      await safeBatch(c.env.DB, statements);
    }
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/trash
 * Empty the entire trash.
 */
trashRoutes.delete('/', async (c) => {
  const userId = c.get('userId');

  // 1. Get all trashed folders and their subfolders recursively
  const { results: allTrashedFolders } = await c.env.DB.prepare(
    `WITH RECURSIVE trashed_subfolders(id) AS (
       SELECT id FROM folders WHERE user_id = ? AND is_trashed = 1
       UNION ALL
       SELECT f.id FROM folders f
       JOIN trashed_subfolders ts ON f.parent_id = ts.id
     )
     SELECT id FROM trashed_subfolders`
  )
    .bind(userId)
    .all<{ id: string }>();

  const folderIds = allTrashedFolders.map((f) => f.id);

  // 2. Get all files that are directly trashed OR inside any of the trashed folders
  let filesQuery = 'SELECT id, thumbnail_msg_id FROM files WHERE user_id = ? AND (is_trashed = 1';
  const queryParams: any[] = [userId];
  
  if (folderIds.length > 0) {
    filesQuery += ` OR folder_id IN (${folderIds.map(() => '?').join(', ')})`;
    queryParams.push(...folderIds);
  }
  filesQuery += ')';

  const { results: filesToDelete } = await c.env.DB.prepare(filesQuery)
    .bind(...queryParams)
    .all<{ id: string; thumbnail_msg_id: string | null }>();

  // Delete all thumbnail messages
  for (const file of filesToDelete) {
    if (file.thumbnail_msg_id && file.thumbnail_msg_id.includes('|')) {
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
  }

  // Delete all chunk messages
  for (const file of filesToDelete) {
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT telegram_message_id FROM chunks WHERE file_id = ? AND telegram_message_id IS NOT NULL'
    )
      .bind(file.id)
      .all();

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
  }

  // Batch delete all trashed files & folders
  const statements: D1PreparedStatement[] = [];
  for (const file of filesToDelete) {
    statements.push(c.env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM favorites WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM recent_files WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM upload_sessions WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM download_sessions WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM shared_links WHERE file_id = ?').bind(file.id));
    statements.push(c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(file.id));
  }
  for (const fId of folderIds) {
    statements.push(c.env.DB.prepare('DELETE FROM favorites WHERE folder_id = ?').bind(fId));
    statements.push(c.env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(fId, userId));
  }
  
  // Also delete directly trashed folders (just in case some had no subfolders or files)
  statements.push(c.env.DB.prepare('DELETE FROM folders WHERE user_id = ? AND is_trashed = 1').bind(userId));

  if (statements.length > 0) {
    await safeBatch(c.env.DB, statements);
  }

  return c.json({ success: true });
});
