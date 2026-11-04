import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, REPO_ROOT, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db/index.js';
import { createContext, Scheduler } from './bootstrap.js';
import { recoverUploads } from './services/uploads.js';
import { backfillContentHashes } from './services/blobs.js';
import { buildApp } from './http/app.js';

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const logger = createLogger(config.logLevel, config.nodeEnv === 'development');
  for (const w of config.warnings) logger.warn(w);
  const db = openDb(config.dataDir);
  const ctx = createContext(config, db, logger);

  const backfilled = backfillContentHashes(db);
  if (backfilled > 0) logger.info({ backfilled }, 'computed content fingerprints for existing files');

  await ctx.pool.init();
  const recovered = recoverUploads(ctx);
  if (recovered.requeued > 0) logger.info({ requeued: recovered.requeued }, 're-enqueued recovered parts');

  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  app.server.requestTimeout = 0;
  // bodies may legitimately take long (slow links), but headers must arrive promptly (slowloris guard)
  app.server.headersTimeout = 60_000;
  app.server.keepAliveTimeout = 75_000;

  const scheduler = new Scheduler(ctx);
  ctx.scheduler = scheduler;
  scheduler.start();

  logger.info(
    {
      url: config.publicUrl,
      port: config.port,
      dataDir: config.dataDir,
      healthyBots: ctx.pool.healthyCount(),
      uploadSlots: ctx.pool.effectiveUploadConcurrency(),
      partSizeMiB: Math.round(config.partSize / 1024 / 1024),
      downloadParallelParts: config.downloadParallelParts,
    },
    'teledrive started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    ctx.queue.stop();
    try {
      await app.close(); // stops accepting, drains in-flight requests
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'error during app close');
    }
    try {
      await ctx.queue.drain();
    } catch { /* ignore */ }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('fatal startup error:', e);
  process.exit(1);
});
