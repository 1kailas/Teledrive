/**
 * TeleDrive Worker — Main Entry Point
 *
 * Hono-based API router for the Cloudflare Worker backend.
 * All routes are prefixed with /api and protected by JWT authentication
 * middleware (except auth routes).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types/index.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { folderRoutes } from './routes/folders.js';
import { uploadRoutes } from './routes/upload.js';
import { downloadRoutes } from './routes/download.js';
import { searchRoutes } from './routes/search.js';
import { favoritesRoutes } from './routes/favorites.js';
import { recentRoutes } from './routes/recent.js';
import { trashRoutes } from './routes/trash.js';
import { statsRoutes } from './routes/stats.js';
import { settingsRoutes } from './routes/settings.js';
import { thumbnailRoutes } from './routes/thumbnails.js';
import { previewRoutes } from './routes/preview.js';
import { sharingRoutes } from './routes/sharing.js';
import { bulkRoutes } from './routes/bulk.js';

// ============================================
// App Type with environment bindings
// ============================================

export type AppType = {
  Bindings: Env;
  Variables: {
    userId: string;
    userEmail?: string;
  };
};

const app = new Hono<AppType>();

// ============================================
// Global Middleware
// ============================================

// Request logging
app.use('*', logger());

// CORS — allow frontend origin
app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin: c.env.FRONTEND_URL || 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  });
  return corsMiddleware(c, next);
});

// ============================================
// Health Check (unauthenticated)
// ============================================

app.get('/api/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'ok',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    },
  });
});

// ============================================
// Auth Routes (unauthenticated)
// ============================================

app.route('/api/auth', authRoutes);

// ============================================
// Protected Routes — JWT required
// ============================================

app.use('/api/*', authMiddleware);

app.route('/api/files', fileRoutes);
app.route('/api/folders', folderRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/download', downloadRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/favorites', favoritesRoutes);
app.route('/api/recent', recentRoutes);
app.route('/api/trash', trashRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/thumbnails', thumbnailRoutes);
app.route('/api/preview', previewRoutes);
app.route('/api/share', sharingRoutes);
app.route('/api/bulk', bulkRoutes);

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Not Found',
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

// ============================================
// Global Error Handler
// ============================================

app.onError((err, c) => {
  console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err);
  return c.json(
    {
      success: false,
      error: 'Internal Server Error',
      message:
        c.env.ENVIRONMENT === 'development'
          ? err.message
          : 'An unexpected error occurred',
    },
    500
  );
});

import { cleanupAbandonedUploads } from './utils/cleanup.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      cleanupAbandonedUploads(env.DB, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID)
        .catch((err) => console.error('Cron cleanup failed:', err))
    );
  }
};
