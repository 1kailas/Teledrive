import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { dueFailedParts } from '../db/repos/files.js';
import { dueDeletions, markDeletionDone, markDeletionFailed, deleteExpiredSessions, pruneActivity } from '../db/repos/misc.js';
import { staleActiveUploads, staleProcessingUploads } from '../db/repos/uploads.js';
import { cancelUpload, cancelFailedUploads, partTempPath } from './uploads.js';
import { purgeExpiredTrash } from './trash.js';
import { runBackup, backupNeeded, markBackupDone } from './backup.js';
import { TelegramError } from '../telegram/botApi.js';
import type { UploadRow } from '../types.js';
import { getBlob } from '../db/repos/files.js';

interface Job {
  name: string;
  intervalMs: number;
  lastRun: number;
  running: boolean;
  fn: () => Promise<void> | void;
}

/**
 * A single 60s ticking loop running per-job intervals, non-overlapping
 * (a job that is still running is skipped until its next interval).
 */
export class Scheduler {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** One tick at a time: a slow job must not stack ticks on top of each other. */
  private tickInProgress = false;

  constructor(private readonly ctx: AppContext) {
    const min = 60_000;
    this.jobs = [
      { name: 'retryParts', intervalMs: min, lastRun: 0, running: false, fn: () => this.retryParts() },
      { name: 'expireUploads', intervalMs: min, lastRun: 0, running: false, fn: () => this.expireUploads() },
      { name: 'purgeTrash', intervalMs: 15 * min, lastRun: 0, running: false, fn: () => this.purgeTrash() },
      { name: 'tgDeletions', intervalMs: min, lastRun: 0, running: false, fn: () => this.processDeletions() },
      { name: 'cacheEviction', intervalMs: 5 * min, lastRun: 0, running: false, fn: () => this.ctx.cache.evict() },
      { name: 'orphanTmp', intervalMs: 10 * min, lastRun: 0, running: false, fn: () => this.cleanOrphanTmp() },
      { name: 'expiredSessions', intervalMs: 10 * min, lastRun: 0, running: false, fn: () => deleteExpiredSessions(this.ctx.db, Date.now()) },
      { name: 'pruneActivity', intervalMs: 60 * min, lastRun: 0, running: false, fn: () => pruneActivity(this.ctx.db, Date.now() - 180 * 24 * 3600 * 1000) },
      { name: 'botHealth', intervalMs: 5 * min, lastRun: 0, running: false, fn: () => this.ctx.pool.recheckHealth() },
      { name: 'failedUploads', intervalMs: 15 * min, lastRun: 0, running: false, fn: () => cancelFailedUploads(this.ctx, Date.now() - this.ctx.config.uploadSessionTtlMs) },
      { name: 'backups', intervalMs: min, lastRun: 0, running: false, fn: () => this.maybeBackup() },
    ];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run a single job by name immediately (used by tests + retry-failed endpoint). */
  async runJob(name: string): Promise<void> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job || job.running) return;
    job.running = true;
    try {
      await job.fn();
    } catch (e) {
      this.ctx.logger.warn({ job: name, err: (e as Error).message }, 'scheduler job failed');
    } finally {
      job.running = false;
      job.lastRun = Date.now();
    }
  }

  async tick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      const now = Date.now();
      for (const job of this.jobs) {
        if (job.running || now - job.lastRun < job.intervalMs) continue;
        await this.runJob(job.name);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private retryParts(): void {
    const due = dueFailedParts(this.ctx.db, Date.now());
    for (const p of due) {
      // only retry if the temp file still exists
      const upload = this.ctx.db
        .prepare(`SELECT * FROM uploads WHERE blob_id = ? AND status IN ('active','processing')`)
        .get(p.blob_id) as UploadRow | undefined;
      const blob = getBlob(this.ctx.db, p.blob_id);
      if (upload && blob) {
        const tmp = partTempPath(this.ctx.config.dataDir, upload, blob.part_count, p.idx);
        if (!fs.existsSync(tmp)) continue;
      }
      this.ctx.db
        .prepare(`UPDATE parts SET status = 'received', next_attempt_at = NULL WHERE blob_id = ? AND idx = ?`)
        .run(p.blob_id, p.idx);
      this.ctx.queue.enqueue(p.blob_id, p.idx);
    }
  }

  private expireUploads(): void {
    const now = Date.now();
    const stale = [...staleActiveUploads(this.ctx.db, now), ...staleProcessingUploads(this.ctx.db, now)];
    for (const u of stale) {
      try {
        cancelUpload(this.ctx, u.id);
        this.ctx.logger.info({ uploadId: u.id, status: u.status }, 'expired stale upload cancelled');
      } catch (e) {
        this.ctx.logger.warn({ uploadId: u.id, err: (e as Error).message }, 'failed to cancel stale upload');
      }
    }
  }

  private purgeTrash(): void {
    const olderThan = Date.now() - this.ctx.config.trashRetentionDays * 24 * 3600 * 1000;
    const n = purgeExpiredTrash(this.ctx, olderThan);
    if (n > 0) this.ctx.logger.info({ count: n }, 'purged expired trash items');
  }

  async processDeletions(): Promise<void> {
    const due = dueDeletions(this.ctx.db, Date.now(), 100);
    if (due.length === 0) return;
    const bot = this.ctx.pool.deletionBot();
    if (!bot) return;
    const ids = due.map((d) => d.message_id);
    try {
      const { failed } = await bot.client.deleteMessages(this.ctx.config.channelId, ids);
      const failedIds = new Set(failed.map((f) => f.id));
      let deletedCount = 0;
      for (const d of due) {
        if (failedIds.has(d.message_id)) {
          const f = failed.find((x) => x.id === d.message_id)!;
          markDeletionFailed(this.ctx.db, d.message_id, d.attempts + 1, f.error);
        } else {
          markDeletionDone(this.ctx.db, d.message_id);
          deletedCount++;
        }
      }
      if (deletedCount > 0) {
        this.ctx.logger.info({ count: deletedCount, ids }, 'deleted Telegram messages');
      }
    } catch (e) {
      const msg = e instanceof TelegramError ? `${e.code} ${e.message}` : (e as Error).message;
      this.ctx.logger.warn({ err: msg, ids }, 'failed to delete Telegram messages');
      for (const d of due) markDeletionFailed(this.ctx.db, d.message_id, d.attempts + 1, msg);
    }
  }

  private cleanOrphanTmp(): void {
    const tmpRoot = path.join(this.ctx.config.dataDir, 'tmp', 'uploads');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const row = this.ctx.db
        .prepare(`SELECT id FROM uploads WHERE id = ? AND status IN ('active','processing','failed')`)
        .get(e.name);
      if (!row) {
        fs.rmSync(path.join(tmpRoot, e.name), { recursive: true, force: true });
        this.ctx.logger.debug({ dir: e.name }, 'removed orphan tmp upload dir');
      }
    }
  }

  private async maybeBackup(): Promise<void> {
    if (!backupNeeded(this.ctx)) return;
    const result = await runBackup(this.ctx);
    if (result) markBackupDone(this.ctx);
  }
}
