import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { SessionRow } from '../types.js';
import { AppError, forbidden, notFound, unauthorized } from './errors.js';
import { sessionFromToken } from './auth.js';
import { streamToBuffer } from '../util.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerDriveRoutes } from './routes/drive.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerItemRoutes } from './routes/items.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerZipRoutes } from './routes/zip.js';
import { registerInsightRoutes } from './routes/insights.js';
import { uploadSettingsSnapshot } from '../services/settings.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRow;
  }
}

const PUBLIC_API = new Set(['/api/health', '/api/config']);
const TEXT_LIMIT = 10 * 1024 * 1024;

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: ctx.config.trustProxy,
    // 2 GB part fetches can stall mid-stream; no request timeout.
    requestTimeout: 0,
    // zip tokens embed base64url JSON + HMAC — they exceed the default 100-char param limit
    routerOptions: { maxParamLength: 512 },
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { global: false });

  // raw octet-stream bodies (upload slices) — never buffered
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  // small buffered text bodies (text editor save)
  app.addContentTypeParser('text/plain', (_req, payload, done) => {
    streamToBuffer(payload, TEXT_LIMIT).then(
      (buf) => done(null, buf.toString('utf8')),
      (e: unknown) => done(e instanceof Error ? e : new Error(String(e))),
    );
  });

  // auth + CSRF
  app.addHook('onRequest', async (req) => {
    const url = (req.raw.url ?? '').split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    const isLogin = url === '/api/auth/login';
    const isPublic = url.startsWith('/api/public/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isLogin && !isPublic) {
      if (req.headers['x-requested-with'] !== 'teledrive') {
        throw forbidden('missing X-Requested-With header');
      }
    }
    if (PUBLIC_API.has(url) || isLogin || isPublic) return;
    const session = sessionFromToken(ctx, req.cookies['td_session']);
    if (!session) throw unauthorized();
    req.session = session;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { error: { code: err.code, message: err.message } };
      if (err.details !== undefined) (body['error'] as Record<string, unknown>)['details'] = err.details;
      return reply.code(err.statusCode).send(body);
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'too many requests' } });
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: (err as { code?: string }).code ?? 'BAD_REQUEST', message: (err as Error).message },
      });
    }
    ctx.logger.error({ err, url: req.raw.url }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  // public endpoints
  app.get('/api/health', async () => ({ status: 'ok', version: ctx.config.version }));
  app.get('/api/config', async () => {
    const upload = uploadSettingsSnapshot(ctx.config);
    return {
      version: ctx.config.version,
      partSize: ctx.config.partSize,
      effectivePartSizeMb: upload.effectivePartSizeMb,
      partSizeMaxMb: upload.maxAllowedMb,
      isLocalBotApi: ctx.config.isLocalBotApi,
      sliceSize: ctx.config.sliceSize,
      uploadConcurrency: ctx.config.clientUploadConcurrency,
      telegramUploadConcurrency: ctx.config.telegramUploadConcurrency,
      botMaxConcurrentUploads: ctx.config.botMaxConcurrentUploads,
      maxFileSize: ctx.config.maxFileSize,
      trashRetentionDays: ctx.config.trashRetentionDays,
      desktopMode: false,
      features: { ffmpeg: !!ctx.tools.ffmpeg, pdf: !!ctx.tools.pdftoppm },
    };
  });

  registerAuthRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerDriveRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerMiscRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerZipRoutes(app, ctx);
  registerInsightRoutes(app, ctx);

  // Direct desktop download route for Windows executable
  app.get('/download/teledrive.exe', async (_req, reply) => {
    const exePath = path.resolve(ctx.config.dataDir, '../desktop/release/TeleDrive-Windows.exe');
    if (fs.existsSync(exePath)) {
      reply.header('Content-Disposition', 'attachment; filename="TeleDrive-Windows.exe"');
      reply.header('Content-Type', 'application/vnd.microsoft.portable-executable');
      return reply.send(fs.createReadStream(exePath));
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'TeleDrive executable not found' } });
  });

  // Direct desktop download route for Windows MSI installer
  app.get('/download/teledrive.msi', async (_req, reply) => {
    const msiPath = path.resolve(ctx.config.dataDir, '../desktop/release/TeleDrive-Setup.msi');
    if (fs.existsSync(msiPath)) {
      reply.header('Content-Disposition', 'attachment; filename="TeleDrive-Setup.msi"');
      reply.header('Content-Type', 'application/x-msi');
      return reply.send(fs.createReadStream(msiPath));
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'TeleDrive MSI installer not found' } });
  });

  // static frontend with SPA fallback (only when the build exists)
  const hasStatic = fs.existsSync(path.join(ctx.config.staticDir, 'index.html'));
  if (hasStatic) {
    await app.register(fastifyStatic, { root: ctx.config.staticDir });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = (req.raw.url ?? '').split('?')[0]!;
    if (hasStatic && req.method === 'GET' && !url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
  });

  return app;
}
