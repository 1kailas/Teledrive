/**
 * TeleDrive Worker — Search Routes (Enhanced)
 *
 * Full-text search using FTS5 with ranking, filtering,
 * autocomplete suggestions, and smart filters.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';

export const searchRoutes = new Hono<AppType>();

/** Map file type categories to MIME type patterns */
const TYPE_FILTERS: Record<string, string[]> = {
  image: ['image/%'],
  video: ['video/%'],
  audio: ['audio/%'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats%', 'text/%'],
  archive: ['application/zip', 'application/x-rar%', 'application/x-7z%', 'application/gzip', 'application/x-tar'],
  code: ['text/javascript', 'application/json', 'text/html', 'text/css', 'text/xml', 'application/xml'],
};

/**
 * GET /api/search
 * Enhanced search with FTS5 ranking, filters, and folder context.
 */
searchRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const q = c.req.query('q') || '';
  const ext = c.req.query('ext');
  const mimeType = c.req.query('mimeType');
  const type = c.req.query('type'); // image, video, audio, document, archive, code
  const minSize = c.req.query('minSize');
  const maxSize = c.req.query('maxSize');
  const fromDate = c.req.query('fromDate');
  const toDate = c.req.query('toDate');
  const folderId = c.req.query('folderId');
  const starred = c.req.query('starred');
  const modified = c.req.query('modified'); // today, week, month
  const sortBy = c.req.query('sortBy') || 'relevance';
  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = Math.min(parseInt(c.req.query('pageSize') || '50', 10), 100);

  const conditions: string[] = ['f.user_id = ?', 'f.is_trashed = 0', "f.upload_status = 'complete'"];
  const params: (string | number)[] = [userId];

  // FTS5 query — use MATCH for text search with ranking
  let useFTS = false;
  let ftsQuery = '';

  if (q) {
    // Sanitize for FTS5: escape special characters
    const sanitized = q.replace(/['"*()]/g, '').trim();
    if (sanitized.length > 0) {
      // Use prefix matching for partial word search
      ftsQuery = sanitized
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => `"${word}"*`)
        .join(' ');
      useFTS = true;
    }
  }

  // Extension filter
  if (ext) {
    conditions.push('f.extension = ?');
    params.push(ext.toLowerCase());
  }

  // MIME type filter
  if (mimeType) {
    conditions.push('f.mime_type LIKE ?');
    params.push(`%${mimeType}%`);
  }

  // Type category filter (maps to MIME patterns)
  if (type && TYPE_FILTERS[type]) {
    const mimePatterns = TYPE_FILTERS[type];
    const mimeConditions = mimePatterns.map(() => 'f.mime_type LIKE ?');
    conditions.push(`(${mimeConditions.join(' OR ')})`);
    params.push(...mimePatterns);
  }

  // Size range
  if (minSize) {
    conditions.push('f.size >= ?');
    params.push(parseInt(minSize, 10));
  }
  if (maxSize) {
    conditions.push('f.size <= ?');
    params.push(parseInt(maxSize, 10));
  }

  // Date range
  if (fromDate) {
    conditions.push('f.created_at >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('f.created_at <= ?');
    params.push(toDate);
  }

  // Smart date filters
  if (modified === 'today') {
    conditions.push("f.updated_at >= datetime('now', '-1 day')");
  } else if (modified === 'week') {
    conditions.push("f.updated_at >= datetime('now', '-7 days')");
  } else if (modified === 'month') {
    conditions.push("f.updated_at >= datetime('now', '-30 days')");
  }

  // Folder filter
  if (folderId) {
    if (folderId === 'root') {
      conditions.push('f.folder_id IS NULL');
    } else {
      conditions.push('f.folder_id = ?');
      params.push(folderId);
    }
  }

  // Starred filter
  if (starred === 'true') {
    conditions.push('f.is_favorite = 1');
  }

  const whereClause = conditions.join(' AND ');
  const offset = (page - 1) * pageSize;

  let filesQuery: string;
  let countQuery: string;
  let queryParams: (string | number)[];

  if (useFTS && ftsQuery) {
    // FTS5 query with BM25 ranking
    filesQuery = `
      SELECT f.*, 
        highlight(files_fts, 0, '<mark>', '</mark>') as name_highlighted
      FROM files_fts
      JOIN files f ON files_fts.rowid = f.rowid
      WHERE files_fts MATCH ? AND ${whereClause}
      ORDER BY ${sortBy === 'relevance' ? 'bm25(files_fts)' : `f.${sortBy === 'name' ? 'name' : sortBy === 'size' ? 'size' : sortBy === 'date' ? 'created_at' : 'created_at'} ${sortBy === 'size' ? 'DESC' : 'ASC'}`}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total
      FROM files_fts
      JOIN files f ON files_fts.rowid = f.rowid
      WHERE files_fts MATCH ? AND ${whereClause}
    `;
    queryParams = [ftsQuery, ...params, pageSize, offset];
  } else {
    // Fallback to LIKE query when no text search
    if (q) {
      conditions.push('f.name LIKE ?');
      params.push(`%${q}%`);
    }
    const fallbackWhere = conditions.join(' AND ');

    const orderBy = sortBy === 'name' ? 'f.name ASC' : sortBy === 'size' ? 'f.size DESC' : 'f.created_at DESC';
    filesQuery = `SELECT f.* FROM files f WHERE ${fallbackWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    countQuery = `SELECT COUNT(*) as total FROM files f WHERE ${fallbackWhere}`;
    queryParams = [...params, pageSize, offset];
  }

  try {
    const [filesResult, countResult] = await Promise.all([
      useFTS
        ? c.env.DB.prepare(filesQuery).bind(...queryParams).all()
        : c.env.DB.prepare(filesQuery).bind(...queryParams).all(),
      useFTS
        ? c.env.DB.prepare(countQuery).bind(ftsQuery, ...params).first<{ total: number }>()
        : c.env.DB.prepare(countQuery).bind(...params).first<{ total: number }>(),
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

    // Get folder paths for files (breadcrumb context)
    const fileIds = (filesResult.results || []).map((f: Record<string, unknown>) => f.folder_id).filter(Boolean);
    let folderPaths: Record<string, string> = {};
    if (fileIds.length > 0) {
      const uniqueFolderIds = [...new Set(fileIds)] as string[];
      for (const fid of uniqueFolderIds.slice(0, 20)) {
        const folder = await c.env.DB.prepare('SELECT name FROM folders WHERE id = ?')
          .bind(fid)
          .first<{ name: string }>();
        if (folder) {
          folderPaths[fid] = folder.name;
        }
      }
    }

    return c.json({
      success: true,
      data: {
        files: filesResult.results,
        folders,
        folderPaths,
      },
      total: countResult?.total || 0,
      page,
      pageSize,
      totalPages: Math.ceil((countResult?.total || 0) / pageSize),
    });
  } catch (ftsError) {
    // FTS5 might not be available — fallback to LIKE query
    console.error('[Search] FTS5 error, falling back to LIKE:', ftsError);

    const fallbackConditions = [...conditions];
    const fallbackParams = [...params];
    if (q) {
      fallbackConditions.push('f.name LIKE ?');
      fallbackParams.push(`%${q}%`);
    }
    const fallbackWhere = fallbackConditions.join(' AND ');

    const [filesResult, countResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT f.* FROM files f WHERE ${fallbackWhere} ORDER BY f.name ASC LIMIT ? OFFSET ?`
      )
        .bind(...fallbackParams, pageSize, offset)
        .all(),
      c.env.DB.prepare(
        `SELECT COUNT(*) as total FROM files f WHERE ${fallbackWhere}`
      )
        .bind(...fallbackParams)
        .first<{ total: number }>(),
    ]);

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
      data: { files: filesResult.results, folders, folderPaths: {} },
      total: countResult?.total || 0,
      page,
      pageSize,
      totalPages: Math.ceil((countResult?.total || 0) / pageSize),
    });
  }
});

/**
 * GET /api/search/suggest
 * Autocomplete suggestions based on file names.
 */
searchRoutes.get('/suggest', async (c) => {
  const userId = c.get('userId');
  const q = c.req.query('q') || '';

  if (q.length < 2) {
    return c.json({ success: true, data: [] });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT name, extension, mime_type FROM files 
     WHERE user_id = ? AND name LIKE ? AND is_trashed = 0 AND upload_status = 'complete'
     ORDER BY name ASC LIMIT 8`
  )
    .bind(userId, `%${q}%`)
    .all();

  // Also suggest folder names
  const { results: folderResults } = await c.env.DB.prepare(
    `SELECT DISTINCT name FROM folders 
     WHERE user_id = ? AND name LIKE ? AND is_trashed = 0
     ORDER BY name ASC LIMIT 4`
  )
    .bind(userId, `%${q}%`)
    .all();

  const suggestions = [
    ...(results || []).map((r) => ({
      text: r.name as string,
      type: 'file' as const,
      extension: r.extension as string | null,
    })),
    ...(folderResults || []).map((r) => ({
      text: r.name as string,
      type: 'folder' as const,
      extension: null,
    })),
  ];

  return c.json({ success: true, data: suggestions });
});
