import type { Db } from '../db/index.js';
import { listBots } from '../db/repos/misc.js';
import type { BotPool } from '../telegram/botPool.js';
import type { FileRow } from '../types.js';

export function stats(db: Db, pool?: BotPool): Record<string, unknown> {
  const total = db
    .prepare(
      `SELECT COALESCE(SUM(size),0) s, COUNT(*) c FROM files WHERE trashed_at IS NULL AND status = 'ready'`,
    )
    .get() as { s: number; c: number };
  const folderCount = (
    db.prepare('SELECT COUNT(*) c FROM folders WHERE trashed_at IS NULL').get() as { c: number }
  ).c;
  const trash = db
    .prepare(`SELECT COALESCE(SUM(size),0) s, COUNT(*) c FROM files WHERE trashed_at IS NOT NULL`)
    .get() as { s: number; c: number };
  const trashFolderCount = (
    db.prepare('SELECT COUNT(*) c FROM folders WHERE trashed_at IS NOT NULL').get() as { c: number }
  ).c;
  const byCategory = db
    .prepare(
      `SELECT category, COUNT(*) count, COALESCE(SUM(size),0) size FROM files
       WHERE trashed_at IS NULL AND status = 'ready' GROUP BY category`,
    )
    .all() as { category: string; count: number; size: number }[];
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const uploadsByDay = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') day, COUNT(*) count, COALESCE(SUM(size),0) size
       FROM files WHERE created_at >= ? AND status <> 'failed' GROUP BY day ORDER BY day`,
    )
    .all(since) as { day: string; count: number; size: number }[];
  const largestFiles = db
    .prepare(
      `SELECT * FROM files WHERE trashed_at IS NULL AND status = 'ready' ORDER BY size DESC LIMIT 10`,
    )
    .all() as FileRow[];
  const allBots = listBots(db);
  const activeBots = pool ? allBots.filter((b) => pool.entry(b.bot_id)) : allBots;
  const bots = activeBots.map((b) => ({
    botId: b.bot_id,
    username: b.username,
    healthy: pool ? !!pool.entry(b.bot_id)?.healthy : !!b.healthy,
    partsUploaded: b.parts_uploaded,
    bytesUploaded: b.bytes_uploaded,
  }));
  return {
    totalSize: total.s,
    fileCount: total.c,
    folderCount,
    trashSize: trash.s,
    trashCount: trash.c + trashFolderCount,
    byCategory,
    uploadsByDay,
    largestFiles,
    bots,
  };
}
