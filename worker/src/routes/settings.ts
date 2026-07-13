/**
 * TeleDrive Worker — Settings Routes
 *
 * User preferences and configuration.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId } from '../db/queries.js';

export const settingsRoutes = new Hono<AppType>();

/**
 * GET /api/settings
 * Get all settings for the current user.
 */
settingsRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const { results } = await c.env.DB.prepare(
    'SELECT key, value FROM settings WHERE user_id = ?'
  )
    .bind(userId)
    .all();

  // Convert to key-value map
  const settings: Record<string, string | null> = {};
  for (const row of results) {
    settings[row.key as string] = row.value as string | null;
  }

  return c.json({ success: true, data: settings });
});

/**
 * PUT /api/settings
 * Update settings. Accepts a key-value map.
 */
settingsRoutes.put('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<Record<string, string>>();

  const statements = Object.entries(body).map(([key, value]) =>
    c.env.DB.prepare(
      `INSERT INTO settings (id, user_id, key, value) 
       VALUES (?, ?, ?, ?) 
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
    ).bind(generateId(), userId, key, value)
  );

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  return c.json({ success: true });
});

/**
 * GET /api/settings/:key
 * Get a single setting.
 */
settingsRoutes.get('/:key', async (c) => {
  const userId = c.get('userId');
  const key = c.req.param('key');

  const result = await c.env.DB.prepare(
    'SELECT value FROM settings WHERE user_id = ? AND key = ?'
  )
    .bind(userId, key)
    .first<{ value: string | null }>();

  return c.json({
    success: true,
    data: { key, value: result?.value || null },
  });
});

/**
 * DELETE /api/settings/:key
 * Delete a single setting.
 */
settingsRoutes.delete('/:key', async (c) => {
  const userId = c.get('userId');
  const key = c.req.param('key');

  await c.env.DB.prepare(
    'DELETE FROM settings WHERE user_id = ? AND key = ?'
  )
    .bind(userId, key)
    .run();

  return c.json({ success: true });
});
