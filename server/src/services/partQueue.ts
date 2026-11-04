import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import { thumbnailPath } from '../db/index.js';
import { getFile, getPart } from '../db/repos/files.js';
import { enqueueDeletions } from '../db/repos/misc.js';
import type { FileRow, PartRow, UploadRow } from '../types.js';
import { sha256File } from '../util.js';
import { applyMediaResult, extractMedia } from './media.js';
import { maybeFinalizeBlob, partTempPath } from './uploads.js';
import { TelegramError, type BotApiClient } from '../telegram/botApi.js';
import type { BotEntry } from '../telegram/botPool.js';

const MAX_PART_ATTEMPTS = 10;

/** Telegram rejects these permanently; retrying just burns bot slots forever. */
const PERMANENT_UPLOAD_ERROR =
  /file is too big|file too large|request entity too large|payload too large|entity too large|document (?:size|is too large)|exceeds? .{0,20}(?:limit|size)|http 413/i;

function isPermanentUploadError(error: string): boolean {
  return PERMANENT_UPLOAD_ERROR.test(error);
}

function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
}

function partCaption(file: FileRow, part: PartRow, partCount: number): string {
  const lines = [
    '#teledrive',
    `file: ${file.name}`,
    `part: ${part.idx + 1}/${partCount}`,
    `file_id: ${file.id}`,
    `blob: ${part.blob_id}`,
    `sha256: ${part.sha256 ?? ''}`,
  ];
  let caption = lines.join('\n');
  if (caption.length > 1024) {
    const overflow = caption.length - 1024;
    const short = file.name.length > overflow + 8 ? file.name.slice(0, file.name.length - overflow - 8) : 'file';
    caption = lines.map((l, i) => (i === 1 ? `file: ${short}` : l)).join('\n');
  }
  return caption.slice(0, 1024);
}

interface Job {
  blobId: string;
  idx: number;
}

/**
 * Server-side pipeline: received part -> sha256 -> (part 0) media extraction
 * -> sendDocument via a pooled bot -> 'stored'. Concurrency is bounded by
 * TELEGRAM_UPLOAD_CONCURRENCY globally and BOT_MAX_CONCURRENT_UPLOADS per bot.
 */
export interface ActivePartInfo {
  phase: 'hashing' | 'media' | 'waiting-bot' | 'sending';
  startedAt: number;
  botId: string | null;
}

export class PartQueue {
  private pending: Job[] = [];
  private running = 0;
  private cancelledBlobs = new Set<string>();
  private idleResolvers: Array<() => void> = [];
  private stopped = false;
  private active = new Map<string, ActivePartInfo>();
  /** `${blobId}:${idx}` currently inside process(); prevents duplicate sends. */
  private processing = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  /** Live pipeline state for a part that is currently being processed, if any. */
  activeInfo(blobId: string, idx: number): ActivePartInfo | undefined {
    return this.active.get(`${blobId}:${idx}`);
  }

  /** Position (1-based) of a part in the pending queue, or 0 if not queued. */
  queuePosition(blobId: string, idx: number): number {
    return this.pending.findIndex((j) => j.blobId === blobId && j.idx === idx) + 1;
  }

  private setPhase(part: PartRow, phase: ActivePartInfo['phase'], botId: string | null = null): void {
    this.active.set(`${part.blob_id}:${part.idx}`, { phase, startedAt: Date.now(), botId });
  }

  enqueue(blobId: string, idx: number): void {
    if (this.stopped) return;
    if (this.processing.has(`${blobId}:${idx}`)) return;
    if (this.pending.some((j) => j.blobId === blobId && j.idx === idx)) return;
    this.pending.push({ blobId, idx });
    this.pump();
  }

  cancelBlob(blobId: string): void {
    this.cancelledBlobs.add(blobId);
    this.pending = this.pending.filter((j) => j.blobId !== blobId);
    // The blob is deleted with the upload; don't grow this set forever.
    const t = setTimeout(() => this.cancelledBlobs.delete(blobId), 10 * 60_000);
    t.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.pending = [];
  }

  /** Test helper: resolves when the queue is fully drained. */
  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.running > 0) {
      await new Promise<void>((r) => this.idleResolvers.push(r));
    }
  }

  private notifyIdle(): void {
    if (this.pending.length === 0 && this.running === 0) {
      const rs = this.idleResolvers;
      this.idleResolvers = [];
      rs.forEach((r) => r());
    }
  }

  private pump(): void {
    while (
      !this.stopped &&
      this.running < this.ctx.pool.effectiveUploadConcurrency() &&
      this.pending.length > 0
    ) {
      const job = this.pending.shift()!;
      if (this.cancelledBlobs.has(job.blobId)) continue;
      const key = `${job.blobId}:${job.idx}`;
      if (this.processing.has(key)) continue;
      this.processing.add(key);
      this.running++;
      void this.process(job)
        .catch((e) => this.ctx.logger.error({ err: (e as Error).message }, 'part pipeline error'))
        .finally(() => {
          this.processing.delete(key);
          this.running--;
          this.pump();
          this.notifyIdle();
        });
    }
  }

  private uploadForPart(part: PartRow): UploadRow | undefined {
    return this.ctx.db
      .prepare(`SELECT * FROM uploads WHERE blob_id = ? AND status IN ('active','processing') ORDER BY created_at DESC LIMIT 1`)
      .get(part.blob_id) as UploadRow | undefined;
  }

  private async process(job: Job): Promise<void> {
    try {
      await this.processInner(job);
    } finally {
      this.active.delete(`${job.blobId}:${job.idx}`);
    }
  }

  private async processInner(job: Job): Promise<void> {
    const { db, config, logger } = this.ctx;
    const part = getPart(db, job.blobId, job.idx);
    if (!part || part.status !== 'received') return;
    this.setPhase(part, 'hashing');

    const upload = this.uploadForPart(part);
    const file = upload ? getFile(db, upload.file_id) : db.prepare('SELECT * FROM files WHERE blob_id = ?').get(part.blob_id) as FileRow | undefined;
    const blob = db.prepare('SELECT * FROM blobs WHERE id = ?').get(part.blob_id) as
      | { id: string; part_count: number }
      | undefined;
    if (!file || !blob) return;

    const tmpPath = upload
      ? partTempPath(config.dataDir, upload, blob.part_count, part.idx)
      : null;
    if (!tmpPath || !fs.existsSync(tmpPath)) {
      this.failPart(part, 'temp file missing');
      return;
    }

    // sha256 + media run once per part; retries (sha256 already set) go straight to sending
    const firstPass = !part.sha256;
    if (firstPass) {
      try {
        const sha = await sha256File(tmpPath);
        db.prepare('UPDATE parts SET sha256 = ? WHERE blob_id = ? AND idx = ?').run(sha, part.blob_id, part.idx);
        part.sha256 = sha;
      } catch (e) {
        this.failPart(part, `sha256 failed: ${(e as Error).message}`);
        return;
      }
    }

    // media extraction on part 0, before Telegram upload
    if (part.idx === 0 && firstPass) {
      this.setPhase(part, 'media');
      try {
        const result = await extractMedia({
          config,
          tools: this.ctx.tools,
          logger,
          file,
          partPath: tmpPath,
          isWholeFile: blob.part_count === 1,
        });
        applyMediaResult(db, file.id, result);
        if (result.hasThumbnail) this.ctx.bus.emit('thumbnail.ready', { fileId: file.id });
      } catch (e) {
        logger.warn({ fileId: file.id, err: (e as Error).message }, 'media step failed');
      }
    }

    if (this.cancelledBlobs.has(part.blob_id)) return;
    const claimed = db
      .prepare(`UPDATE parts SET status = 'uploading' WHERE blob_id = ? AND idx = ? AND status = 'received'`)
      .run(part.blob_id, part.idx);
    if (claimed.changes !== 1) return;
    this.emitPart(upload, part, 'uploading');

    // Send via the least-busy bot. Bot-specific problems (flood-wait, revoked
    // token, removed from channel) move the part to another bot without
    // consuming one of its retry attempts.
    let avoid: string | undefined;
    for (let switches = 0; ; switches++) {
      if (this.cancelledBlobs.has(part.blob_id)) return;
      this.setPhase(part, 'waiting-bot');
      const bot = await this.ctx.pool
        .acquire(avoid, () => this.cancelledBlobs.has(part.blob_id))
        .catch((e) => {
          if ((e as Error).message !== 'upload cancelled') {
            this.failPart(part, (e as Error).message);
          }
          return null;
        });
      if (!bot) return;
      // Cancelled while waiting in the bot queue: hand the slot straight back.
      if (this.cancelledBlobs.has(part.blob_id)) {
        this.ctx.pool.release(bot);
        return;
      }
      const outcome = await this.sendWith(bot, part, file, blob.part_count, tmpPath, upload);
      if (outcome !== 'switch-bot') return;
      if (switches >= 20) {
        this.failPart(part, 'all bots rate-limited or unavailable');
        return;
      }
      avoid = bot.id;
    }
  }

  /** One sendDocument attempt. Returns 'switch-bot' when another bot should take over. */
  private async sendWith(
    bot: BotEntry, part: PartRow, file: FileRow, partCount: number, tmpPath: string, upload: UploadRow | undefined,
  ): Promise<'done' | 'switch-bot'> {
    const { db, config } = this.ctx;
    this.setPhase(part, 'sending', bot.id);
    const sendStarted = Date.now();
    try {
      const msg = await bot.client.sendDocument({
        chatId: config.channelId,
        filePath: this.ctx.pool.remotePath(tmpPath),
        caption: partCaption(file, part, partCount),
        retry429: false,
      });
      const doc = msg.document;
      if (!doc) throw new Error('sendDocument returned no document');
      const updated = db
        .prepare(
          `UPDATE parts SET status = 'stored', bot_id = ?, message_id = ?, tg_file_id = ?, tg_file_unique_id = ?
           WHERE blob_id = ? AND idx = ? AND status = 'uploading'`,
        )
        .run(bot.id, msg.message_id, doc.file_id, doc.file_unique_id, part.blob_id, part.idx);
      this.ctx.pool.recordUpload(bot.id, part.size);
      this.ctx.pool.recordTransfer(bot.id, 'up', part.size, Date.now() - sendStarted);
      if (updated.changes !== 1) {
        // part row vanished mid-upload (cancelled): delete the orphan Telegram message
        enqueueDeletions(db, [msg.message_id]);
        return 'done';
      }
      fs.unlink(tmpPath, () => {});
      this.emitPart(upload, part, 'stored');
      // use a Telegram-generated thumbnail if we have none
      const fresh = getFile(db, file.id);
      if (doc.thumb?.file_id && fresh && !fresh.has_thumbnail) {
        void this.adoptTelegramThumb(bot.client, doc.thumb.file_id, fresh.id).catch(() => {});
      }
      maybeFinalizeBlob(this.ctx, part.blob_id);
      return 'done';
    } catch (e) {
      if (e instanceof TelegramError) {
        if (e.code === 429) {
          this.ctx.pool.cooldown(bot.id, e.retryAfter ?? 5);
          return 'switch-bot';
        }
        // revoked token / bot kicked or lost rights in the channel
        if (e.code === 401 || e.code === 403 || /chat not found|not enough rights|need administrator/i.test(e.message)) {
          this.ctx.pool.markUnhealthy(bot.id, `${e.code} ${e.message}`);
          this.ctx.logger.error({ botId: bot.id, err: e.message }, 'bot disabled after Telegram error; using remaining bots');
          return this.ctx.pool.healthyCount() > 0 ? 'switch-bot' : (this.failPart(part, `${e.code} ${e.message}`), 'done');
        }
      }
      const msg = e instanceof TelegramError ? `${e.code} ${e.message}` : (e as Error).message;
      const permanent =
        (e instanceof TelegramError && e.code === 413) ||
        (e instanceof TelegramError && e.code === 400 && isPermanentUploadError(e.message)) ||
        isPermanentUploadError(msg);
      this.failPart(part, msg, permanent);
      return 'done';
    } finally {
      this.ctx.pool.release(bot);
    }
  }

  private async adoptTelegramThumb(client: BotApiClient, fileId: string, fileRowId: string): Promise<void> {
    const f = await client.getFile(fileId);
    if (!f.file_path) return;
    const local = this.ctx.pool.localPath(f.file_path);
    const out = thumbnailPath(this.ctx.config.dataDir, fileRowId);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(local)
      .resize({
        width: this.ctx.config.thumbnailSize,
        height: this.ctx.config.thumbnailSize,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 75 })
      .toFile(out);
    this.ctx.db.prepare('UPDATE files SET has_thumbnail = 1, updated_at = ? WHERE id = ?').run(Date.now(), fileRowId);
    this.ctx.bus.emit('thumbnail.ready', { fileId: fileRowId });
  }

  private emitPart(upload: UploadRow | undefined, part: PartRow, status: string): void {
    if (!upload) return;
    this.ctx.bus.emit('upload.part', { uploadId: upload.id, idx: part.idx, status });
  }

  private failPart(part: PartRow, error: string, permanent = false): void {
    const attempts = permanent ? MAX_PART_ATTEMPTS : part.attempts + 1;
    const { db } = this.ctx;
    if (permanent || attempts >= MAX_PART_ATTEMPTS) {
      db.transaction(() => {
        db.prepare(`UPDATE parts SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL WHERE blob_id = ? AND idx = ?`).run(
          attempts,
          error,
          part.blob_id,
          part.idx,
        );
        db.prepare(`UPDATE blobs SET status = 'failed' WHERE id = ?`).run(part.blob_id);
        db.prepare(`UPDATE files SET status = 'failed', updated_at = ? WHERE blob_id = ?`).run(Date.now(), part.blob_id);
        db.prepare(`UPDATE uploads SET status = 'failed', updated_at = ? WHERE blob_id = ? AND status IN ('active','processing')`).run(
          Date.now(),
          part.blob_id,
        );
      })();
      const file = db.prepare('SELECT id FROM files WHERE blob_id = ?').get(part.blob_id) as { id: string } | undefined;
      if (file) this.ctx.bus.emit('file.updated', { fileId: file.id, status: 'failed' });
      return;
    }
    db.prepare(`UPDATE parts SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ? WHERE blob_id = ? AND idx = ?`).run(
      attempts,
      error,
      Date.now() + backoffMs(attempts),
      part.blob_id,
      part.idx,
    );
    this.ctx.bus.emit('upload.part', {
      uploadId: this.uploadForPart(part)?.id ?? '',
      idx: part.idx,
      status: 'failed',
    });
  }
}
