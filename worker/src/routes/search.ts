/**
 * TeleDrive Worker — Search Routes
 *
 * Full-text and filtered search across files and folders.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';

export const searchRoutes = new Hono<AppType>();

/**
 * GET /api/search
 * Search files by name, extension, size range, date range, and folder.
 */
searchRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const q = c.req.query('q') || '';
  const ext = c.req.query('ext');
  const mimeType = c.req.query('mimeType');
  const minSize = c.req.query('minSize');
  const maxSize = c.req.query('maxSize');
  const fromDate = c.req.query('fromDate');
  const toDate = c.req.query('toDate');
  const folderId = c.req.query('folderId');
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = Math.min(parseInt(c.req.query('pageSize') || '50', 10), 100);

  const conditions: string[] = ['user_id = ?', 'is_trashed = 0', "upload_status = 'complete'"];
  const params: (string | number)[] = [userId];

  if (q) {
    conditions.push('name LIKE ?');
    params.push(`%${q}%`);
  }

  if (ext) {
    conditions.push('extension = ?');
    params.push(ext.toLowerCase());
  }

  if (mimeType) {
    conditions.push('mime_type LIKE ?');
    params.push(`%${mimeType}%`);
  }

  if (minSize) {
    conditions.push('size >= ?');
    params.push(parseInt(minSize, 10));
  }

  if (maxSize) {
    conditions.push('size <= ?');
    params.push(parseInt(maxSize, 10));
  }

  if (fromDate) {
    conditions.push('created_at >= ?');
    params.push(fromDate);
  }

  if (toDate) {
    conditions.push('created_at <= ?');
    params.push(toDate);
  }

  if (folderId) {
    if (folderId === 'root') {
      conditions.push('folder_id IS NULL');
    } else {
      conditions.push('folder_id = ?');
      params.push(folderId);
    }
  }

  const whereClause = conditions.join(' AND ');
  const offset = (page - 1) * pageSize;

  const [filesResult, countResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM files WHERE ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, pageSize, offset)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM files WHERE ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>(),
  ]);

  // Also search folders if there's a text query
  let folders: unknown[] = [];
  if (q) {
    const folderResult = await c.env.DB.prepare(
      `SELECT * FROM folders WHERE user_id = ? AND name LIKE ? AND is_trashed = 0 ORDER BY name ASC LIMIT 20`
    )
      .bind(userId, `%${q}%`)
      .all();
    folders = folderResult.results;
  }

  return c.json({
    success: true,
    data: {
      files: filesResult.results,
      folders,
    },
    total: countResult?.total || 0,
    page,
    pageSize,
    totalPages: Math.ceil((countResult?.total || 0) / pageSize),
  });
});
