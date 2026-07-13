/**
 * TeleDrive Worker — Recent Files Routes
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now } from '../db/queries.js';

export const recentRoutes = new Hono<AppType>();

/**
 * GET /api/recent
 * List recently accessed files.
 */
recentRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

  const { results } = await c.env.DB.prepare(
    `SELECT f.*, rf.accessed_at 
     FROM recent_files rf 
     JOIN files f ON rf.file_id = f.id 
     WHERE rf.user_id = ? AND f.is_trashed = 0 AND f.upload_status = 'complete'
     ORDER BY rf.accessed_at DESC 
     LIMIT ?`
  )
    .bind(userId, limit)
    .all();

  return c.json({ success: true, data: results });
});

/**
 * POST /api/recent
 * Record a file access.
 */
recentRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { fileId } = await c.req.json<{ fileId: string }>();

  if (!fileId) {
    return c.json({ success: false, error: 'fileId required' }, 400);
  }

  // Upsert — update timestamp if already exists, otherwise insert
  const existing = await c.env.DB.prepare(
    'SELECT id FROM recent_files WHERE user_id = ? AND file_id = ?'
  )
    .bind(userId, fileId)
    .first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      'UPDATE recent_files SET accessed_at = ? WHERE id = ?'
    )
      .bind(now(), existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      'INSERT INTO recent_files (id, user_id, file_id, accessed_at) VALUES (?, ?, ?, ?)'
    )
      .bind(generateId(), userId, fileId, now())
      .run();
  }

  // Keep only the latest 100 entries
  await c.env.DB.prepare(
    `DELETE FROM recent_files WHERE user_id = ? AND id NOT IN (
      SELECT id FROM recent_files WHERE user_id = ? ORDER BY accessed_at DESC LIMIT 100
    )`
  )
    .bind(userId, userId)
    .run();

  return c.json({ success: true });
});

/**
 * DELETE /api/recent
 * Clear recent files history.
 */
recentRoutes.delete('/', async (c) => {
  const userId = c.get('userId');

  await c.env.DB.prepare('DELETE FROM recent_files WHERE user_id = ?')
    .bind(userId)
    .run();

  return c.json({ success: true });
});
