import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { listBackups, listBots, pendingDeletionCount } from '../db/repos/misc.js';
import { partStatusCounts } from '../db/repos/files.js';
import { retryUpload } from './uploads.js';

export async function systemInfo(ctx: AppContext): Promise<Record<string, unknown>> {
  const { config, db, pool, cache, tools, startedAt } = ctx;
  const bots = listBots(db);
  const botApi = { url: config.telegramBotApiUrl, reachable: false, latencyMs: null as number | null };
  const probeBot = pool.healthyBots()[0];
  if (probeBot) {
    const t0 = Date.now();
    try {
      await probeBot.client.getMe();
      botApi.reachable = true;
      botApi.latencyMs = Date.now() - t0;
    } catch {
      /* unreachable */
    }
  }
  let channelTitle: string | null = null;
  try {
    channelTitle = await pool.getChannelTitle();
  } catch {
    /* noop */
  }
  let disk = { dataDir: config.dataDir, free: 0, total: 0 };
  try {
    const st = fs.statfsSync(config.dataDir);
    disk = { dataDir: config.dataDir, free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    /* noop */
  }
  const partCounts = partStatusCounts(db);
  const newestBackup = listBackups(db)[0];
  const lastBackup = newestBackup
    ? { fileName: newestBackup.file_name, createdAt: newestBackup.created_at, size: newestBackup.size }
    : null;
  return {
    version: config.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    botApi,
    channel: { id: config.channelId, title: channelTitle },
    // only bots currently configured (the table keeps history of removed tokens)
    bots: bots.filter((b) => pool.entry(b.bot_id)).map((b) => {
      const e = pool.entry(b.bot_id)!;
      return {
        botId: b.bot_id,
        username: b.username,
        healthy: e.healthy,
        lastError: e.lastError ?? b.last_error,
        inFlight: e.inFlight,
        coolingDownSec: e.cooldownUntil > Date.now() ? Math.ceil((e.cooldownUntil - Date.now()) / 1000) : 0,
        uploadRate: pool.estimatedRate(b.bot_id, 'up'),
        downloadRate: pool.estimatedRate(b.bot_id, 'down'),
        partsUploaded: b.parts_uploaded,
        bytesUploaded: b.bytes_uploaded,
      };
    }),
    uploadSlots: pool.effectiveUploadConcurrency(),
    partSize: config.partSize,
    disk,
    cache: cache.stats(),
    tools: {
      ffmpeg: !!tools.ffmpeg,
      ffprobe: !!tools.ffprobe,
      pdftoppm: !!tools.pdftoppm,
    },
    queue: {
      receivedParts: partCounts['received'] ?? 0,
      uploadingParts: partCounts['uploading'] ?? 0,
      failedParts: partCounts['failed'] ?? 0,
      pendingDeletions: pendingDeletionCount(db),
    },
    lastBackup,
  };
}

/** Retry every failed upload whose temp files still exist. */
export function retryFailedParts(ctx: AppContext): number {
  const { db } = ctx;
  const failed = db.prepare(`SELECT id FROM uploads WHERE status = 'failed'`).all() as { id: string }[];
  let retried = 0;
  for (const u of failed) {
    try {
      retryUpload(ctx, u.id);
      retried++;
    } catch {
      /* temp files gone — left for the failedUploads sweeper */
    }
  }
  return retried;
}
