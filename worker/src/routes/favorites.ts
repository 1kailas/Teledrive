/**
 * TeleDrive Worker — Favorites Routes
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now } from '../db/queries.js';

export const favoritesRoutes = new Hono<AppType>();

/**
 * GET /api/favorites
 * List all favorite files and folders.
 */
favoritesRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const { results: files } = await c.env.DB.prepare(
    `SELECT * FROM files WHERE user_id = ? AND is_favorite = 1 AND is_trashed = 0 AND upload_status = 'complete' ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  const { results: folders } = await c.env.DB.prepare(
    `SELECT * FROM folders WHERE user_id = ? AND is_trashed = 0 AND id IN (
      SELECT folder_id FROM favorites WHERE user_id = ? AND folder_id IS NOT NULL
    ) ORDER BY name ASC`
  )
    .bind(userId, userId)
    .all();

  return c.json({ success: true, data: { files, folders } });
});

/**
 * POST /api/favorites
 * Add a file or folder to favorites.
 */
favoritesRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { fileId, folderId } = await c.req.json<{
    fileId?: string;
    folderId?: string;
  }>();

  if (!fileId && !folderId) {
    return c.json({ success: false, error: 'fileId or folderId required' }, 400);
  }

  if (fileId) {
    await c.env.DB.prepare(
      'UPDATE files SET is_favorite = 1, updated_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(now(), fileId, userId)
      .run();
  }

  if (folderId) {
    const favId = generateId();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO favorites (id, user_id, folder_id, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(favId, userId, folderId, now())
      .run();
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/favorites/:id
 * Remove from favorites. The :id can be a fileId or folderId.
 */
favoritesRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const type = c.req.query('type') || 'file';

  if (type === 'file') {
    await c.env.DB.prepare(
      'UPDATE files SET is_favorite = 0, updated_at = ? WHERE id = ? AND user_id = ?'
    )
      .bind(now(), id, userId)
      .run();
  } else {
    await c.env.DB.prepare(
      'DELETE FROM favorites WHERE folder_id = ? AND user_id = ?'
    )
      .bind(id, userId)
      .run();
  }

  return c.json({ success: true });
});
