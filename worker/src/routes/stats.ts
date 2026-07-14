/**
 * TeleDrive Worker — Stats Routes
 *
 * Storage statistics, file counts, and analytics.
 */

import { Hono } from 'hono';
import type { AppType } from '../index.js';
import { cleanupAbandonedUploads } from '../utils/cleanup.js';

export const statsRoutes = new Hono<AppType>();

/**
 * GET /api/stats
 * Get comprehensive storage statistics.
 */
statsRoutes.get('/', async (c) => {
  const userId = c.get('userId');

  const [
    totalFilesResult,
    totalFoldersResult,
    totalStorageResult,
    largestFilesResult,
    recentUploadsResult,
    fileTypeResult,
    recentDownloadsResult,
  ] = await Promise.all([
    // Total completed files count
    c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM files WHERE user_id = ? AND is_trashed = 0 AND upload_status = 'complete'"
    )
      .bind(userId)
      .first<{ count: number }>(),

    // Total folders count
    c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM folders WHERE user_id = ? AND is_trashed = 0'
    )
      .bind(userId)
      .first<{ count: number }>(),

    // Total storage used
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(size), 0) as total FROM files WHERE user_id = ? AND is_trashed = 0 AND upload_status = 'complete'"
    )
      .bind(userId)
      .first<{ total: number }>(),

    // Top 10 largest files
    c.env.DB.prepare(
      "SELECT id, name, size, extension, mime_type, created_at FROM files WHERE user_id = ? AND is_trashed = 0 AND upload_status = 'complete' ORDER BY size DESC LIMIT 10"
    )
      .bind(userId)
      .all(),

    // Recent 10 uploads
    c.env.DB.prepare(
      "SELECT id, name, size, extension, mime_type, created_at FROM files WHERE user_id = ? AND is_trashed = 0 AND upload_status = 'complete' ORDER BY created_at DESC LIMIT 10"
    )
      .bind(userId)
      .all(),

    // File type distribution (by extension)
    c.env.DB.prepare(
      "SELECT extension, COUNT(*) as count, SUM(size) as total_size FROM files WHERE user_id = ? AND is_trashed = 0 AND upload_status = 'complete' AND extension IS NOT NULL GROUP BY extension ORDER BY count DESC LIMIT 20"
    )
      .bind(userId)
      .all(),

    // Recent downloads (from recent_files)
    c.env.DB.prepare(
      `SELECT f.id, f.name, f.size, f.extension, f.mime_type, rf.accessed_at 
       FROM recent_files rf 
       JOIN files f ON rf.file_id = f.id 
       WHERE rf.user_id = ? AND f.is_trashed = 0 
       ORDER BY rf.accessed_at DESC LIMIT 10`
    )
      .bind(userId)
      .all(),
  ]);

  // Storage by folder
  const { results: folderStorageResult } = await c.env.DB.prepare(
    `SELECT fo.id, fo.name, COALESCE(SUM(fi.size), 0) as total_size, COUNT(fi.id) as file_count
     FROM folders fo
     LEFT JOIN files fi ON fi.folder_id = fo.id AND fi.is_trashed = 0 AND fi.upload_status = 'complete'
     WHERE fo.user_id = ? AND fo.is_trashed = 0
     GROUP BY fo.id
     ORDER BY total_size DESC
     LIMIT 10`
  )
    .bind(userId)
    .all();

  return c.json({
    success: true,
    data: {
      totalFiles: totalFilesResult?.count || 0,
      totalFolders: totalFoldersResult?.count || 0,
      totalStorage: totalStorageResult?.total || 0,
      largestFiles: largestFilesResult.results,
      recentUploads: recentUploadsResult.results,
      recentDownloads: recentDownloadsResult.results,
      fileTypeDistribution: fileTypeResult.results,
      largestFolders: folderStorageResult,
    },
  });
});

/**
 * POST /api/stats/cleanup
 * Manually trigger cleanup of abandoned upload sessions.
 */
statsRoutes.post('/cleanup', async (c) => {
  const result = await cleanupAbandonedUploads(
    c.env.DB,
    c.env.TELEGRAM_BOT_TOKEN,
    c.env.TELEGRAM_CHAT_ID
  );
  return c.json({
    success: true,
    data: result,
  });
});
