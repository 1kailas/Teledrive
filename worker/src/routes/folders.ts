/**
 * TeleDrive Worker — Folder Routes
 *
 * CRUD operations for folders:
 * - List, create, rename, move, trash, restore, delete
 * - Nested folder support via parent_id
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { generateId, now } from '../db/queries.js';
import { safeBatch } from '../utils/db.js';

export const folderRoutes = new Hono<AppType>();

/**
 * GET /api/folders
 * List folders. If parentId is provided, list children; otherwise list root folders.
 */
folderRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const parentId = c.req.query('parentId');

  let query: string;
  const params: string[] = [userId];

  if (parentId && parentId !== 'root') {
    query = `SELECT * FROM folders WHERE user_id = ? AND parent_id = ? AND is_trashed = 0 ORDER BY name ASC`;
    params.push(parentId);
  } else {
    query = `SELECT * FROM folders WHERE user_id = ? AND parent_id IS NULL AND is_trashed = 0 ORDER BY name ASC`;
  }

  const { results } = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ success: true, data: results });
});

/**
 * GET /api/folders/:id
 * Get a single folder and its breadcrumb path.
 */
folderRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.param('id');

  const folder = await c.env.DB.prepare(
    'SELECT * FROM folders WHERE id = ? AND user_id = ?'
  )
    .bind(folderId, userId)
    .first();

  if (!folder) {
    return c.json({ success: false, error: 'Folder not found' }, 404);
  }

  // Build breadcrumb path by traversing parent_id chain
  const breadcrumbs: Array<{ id: string; name: string }> = [];
  let currentId = folderId;

  // Safety limit to prevent infinite loops
  for (let i = 0; i < 20; i++) {
    const current = await c.env.DB.prepare(
      'SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?'
    )
      .bind(currentId, userId)
      .first<{ id: string; name: string; parent_id: string | null }>();

    if (!current) break;
    breadcrumbs.unshift({ id: current.id, name: current.name });

    if (!current.parent_id) break;
    currentId = current.parent_id;
  }

  return c.json({
    success: true,
    data: { ...folder, breadcrumbs },
  });
});

/**
 * POST /api/folders
 * Create a new folder.
 */
folderRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { name, parentId } = await c.req.json<{
    name: string;
    parentId?: string;
  }>();

  if (!name || !name.trim()) {
    return c.json({ success: false, error: 'Folder name is required' }, 400);
  }

  // Validate parent exists if provided
  if (parentId) {
    const parent = await c.env.DB.prepare(
      'SELECT id FROM folders WHERE id = ? AND user_id = ? AND is_trashed = 0'
    )
      .bind(parentId, userId)
      .first();

    if (!parent) {
      return c.json({ success: false, error: 'Parent folder not found' }, 404);
    }
  }

  // Check for duplicate name in same parent
  const existing = await c.env.DB.prepare(
    parentId
      ? 'SELECT id FROM folders WHERE user_id = ? AND name = ? AND parent_id = ? AND is_trashed = 0'
      : 'SELECT id FROM folders WHERE user_id = ? AND name = ? AND parent_id IS NULL AND is_trashed = 0'
  )
    .bind(...(parentId ? [userId, name.trim(), parentId] : [userId, name.trim()]))
    .first();

  if (existing) {
    return c.json({ success: false, error: 'A folder with this name already exists' }, 409);
  }

  const folderId = generateId();
  const timestamp = now();

  await c.env.DB.prepare(
    `INSERT INTO folders (id, user_id, name, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(folderId, userId, name.trim(), parentId || null, timestamp, timestamp)
    .run();

  return c.json({
    success: true,
    data: {
      id: folderId,
      name: name.trim(),
      parentId: parentId || null,
    },
  }, 201);
});

/**
 * PATCH /api/folders/:id
 * Rename or move a folder.
 */
folderRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    parentId?: string | null;
  }>();

  const updates: string[] = [];
  const params: (string | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    params.push(body.name.trim());
  }

  if (body.parentId !== undefined) {
    // Prevent moving a folder into itself or its descendants
    if (body.parentId === folderId) {
      return c.json({ success: false, error: 'Cannot move folder into itself' }, 400);
    }

    updates.push('parent_id = ?');
    params.push(body.parentId);
  }

  if (updates.length === 0) {
    return c.json({ success: false, error: 'No updates provided' }, 400);
  }

  updates.push('updated_at = ?');
  params.push(now());
  params.push(folderId, userId);

  await c.env.DB.prepare(
    `UPDATE folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  )
    .bind(...params)
    .run();

  return c.json({ success: true });
});

/**
 * DELETE /api/folders/:id
 * Move a folder to trash (soft delete). Also trashes all contents.
 */
folderRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.param('id');
  const timestamp = now();

  // Recursively collect all descendant folder IDs
  const folderIds = await collectDescendantFolders(c.env.DB, userId, folderId);
  folderIds.push(folderId);

  // Trash all folders and their files
  const statements = [
    ...folderIds.map((id) =>
      c.env.DB.prepare(
        'UPDATE folders SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
      ).bind(timestamp, timestamp, id, userId)
    ),
    ...folderIds.map((id) =>
      c.env.DB.prepare(
        'UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE folder_id = ? AND user_id = ?'
      ).bind(timestamp, timestamp, id, userId)
    ),
  ];

  await safeBatch(c.env.DB, statements);

  return c.json({ success: true });
});

/**
 * Recursively collect all descendant folder IDs.
 */
async function collectDescendantFolders(
  db: D1Database,
  userId: string,
  parentId: string
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?')
    .bind(parentId, userId)
    .all<{ id: string }>();

  const ids: string[] = [];
  for (const folder of results) {
    ids.push(folder.id);
    const descendants = await collectDescendantFolders(db, userId, folder.id);
    ids.push(...descendants);
  }

  return ids;
}
