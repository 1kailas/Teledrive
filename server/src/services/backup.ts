import { createGzip } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../context.js';
import { getSetting, insertBackup, listBackups, setSetting, enqueueDeletions } from '../db/repos/misc.js';

/**
 * Snapshot the SQLite db (online backup), gzip it, and send it to the channel
 * as a pinned document. Keeps at most BACKUP_KEEP entries — older pinned
 * backup messages are enqueued for deletion (deletion unpins implicitly).
 */
export async function runBackup(ctx: AppContext): Promise<{ id: number; fileName: string; size: number } | null> {
  const { db, config, pool, logger } = ctx;
  const bot = pool.healthyBots()[0];
  if (!bot) {
    logger.warn('backup skipped: no healthy bots');
    return null;
  }

  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `teledrive-backup-${iso}.db.gz`;
  const tmpDb = path.join(os.tmpdir(), `teledrive-backup-${process.pid}-${Date.now()}.db`);
  const tmpGz = `${tmpDb}.gz`;
  try {
    await db.backup(tmpDb);
    await pipeline(fs.createReadStream(tmpDb), createGzip({ level: 6 }), fs.createWriteStream(tmpGz));
    const size = fs.statSync(tmpGz).size;

    const counts = db
      .prepare(`SELECT (SELECT COUNT(*) FROM files) f, (SELECT COUNT(*) FROM folders) d`)
      .get() as { f: number; d: number };
    const totalSize = (
      db.prepare(`SELECT COALESCE(SUM(size),0) s FROM files WHERE status = 'ready'`).get() as {
        s: number;
      }
    ).s;
    const caption = `#teledrive_backup ${new Date().toISOString()} files=${counts.f} folders=${counts.d} size=${totalSize}`;

    const msg = await bot.client.sendDocument({
      chatId: config.channelId,
      filePath: pool.remotePath(tmpGz),
      caption,
    });
    try {
      await bot.client.pinChatMessage(config.channelId, msg.message_id);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'pinChatMessage failed (bot may lack can_pin_messages)');
    }
    const id = insertBackup(db, { messageId: msg.message_id, botId: bot.id, fileName, size });
    setSetting(db, 'last_backup_at', String(Date.now()));

    // prune old backups beyond BACKUP_KEEP
    const all = listBackups(db);
    const stale = all.slice(config.backupKeep);
    enqueueDeletions(db, stale.map((b) => b.message_id).filter((m): m is number => m != null));
    if (stale.length > 0) {
      const ids = stale.map((b) => b.id);
      db.prepare(`DELETE FROM backups WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
    }
    logger.info({ fileName, size }, 'backup uploaded');
    return { id, fileName, size };
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpGz, { force: true });
  }
}

/** Change marker: skip scheduled backups when nothing changed since last run. */
export function backupNeeded(ctx: AppContext): boolean {
  const { db, config } = ctx;
  if (!config.backupEnabled) return false;
  const lastAt = Number(getSetting(db, 'last_backup_at') ?? 0);
  if (Date.now() - lastAt < config.backupIntervalMs) return false;
  const marker = getSetting(db, 'last_backup_change_marker');
  const current = currentChangeMarker(db);
  return marker !== current;
}

/**
 * A stable fingerprint of user data. Counts and sums are included so additions
 * with older timestamps and pure deletions still trigger a new backup.
 */
export function currentChangeMarker(db: import('../db/index.js').Db): string {
  const r = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM files) f_count,
         (SELECT COALESCE(MAX(updated_at),0) FROM files) f_updated,
         (SELECT COALESCE(SUM(size),0) FROM files WHERE status = 'ready') f_size,
         (SELECT COUNT(*) FROM folders) d_count,
         (SELECT COALESCE(MAX(updated_at),0) FROM folders) d_updated,
         (SELECT COUNT(*) FROM shares) s_count,
         (SELECT COALESCE(MAX(created_at),0) FROM shares) s_created`,
    )
    .get() as Record<string, number>;
  return [
    r.f_count, r.f_updated, r.f_size,
    r.d_count, r.d_updated,
    r.s_count, r.s_created,
  ].join(':');
}

export function markBackupDone(ctx: AppContext): void {
  setSetting(ctx.db, 'last_backup_change_marker', currentChangeMarker(ctx.db));
}
