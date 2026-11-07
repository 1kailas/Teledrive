import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { BotPool } from '../telegram/botPool.js';
import type { PartRow } from '../types.js';
import { cacheRows, cacheTotalBytes, deleteCacheRow, touchCacheRow, upsertCacheRow } from '../db/repos/misc.js';

/**
 * Resolves Telegram parts to local files via getFile and tracks them in the
 * part_cache table for LRU eviction.
 *
 * Assumption: the telegram-bot-api server (in --local mode) re-downloads a
 * file on the next getFile call if its local copy has been deleted, so files
 * under TELEGRAM_BOT_API_DIR are safe to evict.
 */
export interface FetchInfo {
  startedAt: number;
  botId: string | null;
}

export class PartCache {
  private inflight = new Map<string, Promise<string>>();
  private inflightInfo = new Map<string, FetchInfo>();
  private inUse = new Map<string, number>();

  /** In-progress Telegram → local fetch for a part, if any. */
  fetchInfo(blobId: string, idx: number): FetchInfo | undefined {
    return this.inflightInfo.get(`${blobId}:${idx}`);
  }

  /** True when a verified local copy of the part is known to exist. */
  isCached(blobId: string, idx: number, size: number): boolean {
    const row = this.db
      .prepare('SELECT local_path FROM part_cache WHERE blob_id = ? AND idx = ?')
      .get(blobId, idx) as { local_path: string } | undefined;
    if (!row) return false;
    try {
      return fs.statSync(row.local_path).size === size;
    } catch {
      return false;
    }
  }

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly pool: BotPool,
    private readonly logger: Logger,
  ) {}

  ref(localPath: string): void {
    this.inUse.set(localPath, (this.inUse.get(localPath) ?? 0) + 1);
    touchCacheRow(this.db, localPath);
  }

  unref(localPath: string): void {
    const n = (this.inUse.get(localPath) ?? 0) - 1;
    if (n <= 0) this.inUse.delete(localPath);
    else this.inUse.set(localPath, n);
  }

  isInUse(localPath: string): boolean {
    return (this.inUse.get(localPath) ?? 0) > 0;
  }

  /** Ensure a part's bytes exist locally; returns an absolute local path. */
  ensureLocal(part: PartRow): Promise<string> {
    const key = `${part.blob_id}:${part.idx}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const started = Date.now();
    const cachedBefore = this.isCached(part.blob_id, part.idx, part.size);
    if (!cachedBefore) this.inflightInfo.set(key, { startedAt: started, botId: part.bot_id });
    const p = this.fetchLocal(part)
      .then((local) => {
        // only time real downloads; a cache hit returns instantly and would skew the estimate
        if (!cachedBefore && part.bot_id) this.pool.recordTransfer(part.bot_id, 'down', part.size, Date.now() - started);
        return local;
      })
      .catch((e) => {
        this.logger.warn({ blobId: part.blob_id, idx: part.idx, err: (e as Error).message }, 'ensureLocal failed');
        throw e;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.inflightInfo.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private async fetchLocal(part: PartRow): Promise<string> {
    if (!part.tg_file_id) throw new Error('part has no tg_file_id');
    const { bot, part: resolved } = await this.pool.clientForPart(part);
    const info = this.inflightInfo.get(`${part.blob_id}:${part.idx}`);
    if (info) info.botId = bot.id;
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await bot.client.getFile(resolved.tg_file_id!);
      if (!file.file_path) throw new Error('getFile returned no file_path');
      const local = this.pool.localPath(file.file_path);
      try {
        const st = fs.statSync(local);
        if (st.size === resolved.size) {
          upsertCacheRow(this.db, { localPath: local, blobId: resolved.blob_id, idx: resolved.idx, size: resolved.size });
          return local;
        }
        this.logger.warn({ local, expected: resolved.size, actual: st.size }, 'cached part size mismatch');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (attempt === 1) throw new Error(`part file missing or wrong size at ${local}`);
    }
    throw new Error('unreachable');
  }

  /** Evict least-recently-used cached parts until under CACHE_MAX_GB. */
  evict(): void {
    const { total } = cacheTotalBytes(this.db);
    let bytes = total;
    if (bytes <= this.config.cacheMaxBytes) return;
    const allowedRoot = path.resolve(this.config.telegramBotApiDir) + path.sep;
    for (const row of cacheRows(this.db)) {
      if (bytes <= this.config.cacheMaxBytes) break;
      const resolved = path.resolve(row.local_path) + '';
      if (!resolved.startsWith(allowedRoot)) {
        // never delete files outside the bot-api cache directory
        deleteCacheRow(this.db, row.local_path);
        continue;
      }
      if (this.isInUse(row.local_path)) continue;
      try {
        fs.unlinkSync(row.local_path);
        bytes -= row.size;
        deleteCacheRow(this.db, row.local_path);
        this.logger.debug({ path: row.local_path }, 'evicted cached part');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          deleteCacheRow(this.db, row.local_path);
        }
      }
    }
  }

  /** Delete every unused cached part. Returns the number of bytes freed. */
  clearAll(): number {
    let freed = 0;
    const allowedRoot = path.resolve(this.config.telegramBotApiDir) + path.sep;
    for (const row of cacheRows(this.db)) {
      const resolved = path.resolve(row.local_path);
      if (!resolved.startsWith(allowedRoot)) {
        // never delete files outside the bot-api cache directory
        deleteCacheRow(this.db, row.local_path);
        continue;
      }
      if (this.isInUse(row.local_path)) continue;
      try {
        fs.unlinkSync(row.local_path);
        freed += row.size;
        deleteCacheRow(this.db, row.local_path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          deleteCacheRow(this.db, row.local_path);
        }
      }
    }
    return freed;
  }

  stats(): { usedBytes: number; maxBytes: number; files: number } {
    const { total, files } = cacheTotalBytes(this.db);
    return { usedBytes: total, maxBytes: this.config.cacheMaxBytes, files };
  }
}
