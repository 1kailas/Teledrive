import type { Db } from '../index.js';
import type { BackupRow, BotRow, SessionRow } from '../../types.js';

// ---- sessions ----
export function createSession(
  db: Db,
  s: { id: string; tokenHash: string; expiresAt: number; ip?: string; userAgent?: string },
): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
  ).run(s.id, s.tokenHash, now, now, s.expiresAt, s.ip ?? null, s.userAgent ?? null);
}

export function sessionByTokenHash(db: Db, hash: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash) as
    | SessionRow
    | undefined;
}

export function touchSession(db: Db, id: string, now: number): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?').run(
    now,
    id,
    now - 60_000,
  );
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function listSessions(db: Db): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all() as SessionRow[];
}

export function deleteExpiredSessions(db: Db, now: number): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
}

// ---- settings ----
export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

// ---- activity ----
export function logActivity(
  db: Db,
  a: { action: string; itemType?: string; itemId?: string; itemName?: string; details?: string },
): void {
  db.prepare(
    'INSERT INTO activity (action, item_type, item_id, item_name, details, created_at) VALUES (?,?,?,?,?,?)',
  ).run(a.action, a.itemType ?? null, a.itemId ?? null, a.itemName ?? null, a.details ?? null, Date.now());
}

export function listActivity(
  db: Db,
  limit: number,
  before?: number,
): Record<string, unknown>[] {
  const rows = (
    before
      ? db
          .prepare('SELECT * FROM activity WHERE id < ? ORDER BY id DESC LIMIT ?')
          .all(before, limit)
      : db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit)
  ) as { id: number; action: string; item_type: string | null; item_id: string | null; item_name: string | null; details: string | null; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    itemType: r.item_type,
    itemId: r.item_id,
    itemName: r.item_name,
    details: r.details ? JSON.parse(r.details) : null,
    createdAt: r.created_at,
  }));
}

export function pruneActivity(db: Db, olderThan: number): number {
  return db.prepare('DELETE FROM activity WHERE created_at < ?').run(olderThan).changes;
}

// ---- bots ----
export function upsertBot(
  db: Db,
  b: { botId: string; username?: string; firstName?: string; healthy: boolean; lastError?: string | null },
): void {
  db.prepare(
    `INSERT INTO bots (bot_id, username, first_name, healthy, last_error, last_checked_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(bot_id) DO UPDATE SET
       username = excluded.username,
       first_name = COALESCE(excluded.first_name, bots.first_name),
       healthy = excluded.healthy,
       last_error = excluded.last_error,
       last_checked_at = excluded.last_checked_at`,
  ).run(b.botId, b.username ?? null, b.firstName ?? null, b.healthy ? 1 : 0, b.lastError ?? null, Date.now());
}

export function listBots(db: Db): BotRow[] {
  return db.prepare('SELECT * FROM bots ORDER BY bot_id').all() as BotRow[];
}

export function bumpBotStats(db: Db, botId: string, bytes: number): void {
  db.prepare(
    'UPDATE bots SET parts_uploaded = parts_uploaded + 1, bytes_uploaded = bytes_uploaded + ? WHERE bot_id = ?',
  ).run(bytes, botId);
}

// ---- tg_deletions ----
export function enqueueDeletions(db: Db, messageIds: number[]): void {
  const now = Date.now();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tg_deletions (message_id, next_attempt_at, created_at) VALUES (?, ?, ?)',
  );
  for (const id of messageIds) stmt.run(id, now, now);
}

export function dueDeletions(db: Db, now: number, limit: number): { message_id: number; attempts: number }[] {
  return db
    .prepare('SELECT message_id, attempts FROM tg_deletions WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?')
    .all(now, limit) as { message_id: number; attempts: number }[];
}

export function markDeletionDone(db: Db, messageId: number): void {
  db.prepare('DELETE FROM tg_deletions WHERE message_id = ?').run(messageId);
}

export function markDeletionFailed(db: Db, messageId: number, attempts: number, error: string): void {
  const backoff = Math.min(30_000 * 2 ** Math.min(attempts, 10), 3_600_000);
  if (attempts >= 10) {
    // give up: keep the row out of the retry path but recorded via last_error
    db.prepare('UPDATE tg_deletions SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE message_id = ?').run(
      attempts,
      error,
      Number.MAX_SAFE_INTEGER,
      messageId,
    );
    return;
  }
  db.prepare('UPDATE tg_deletions SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE message_id = ?').run(
    attempts,
    error,
    Date.now() + backoff,
    messageId,
  );
}

export function pendingDeletionCount(db: Db): number {
  return (
    db
      .prepare('SELECT COUNT(*) c FROM tg_deletions WHERE next_attempt_at < ?')
      .get(Number.MAX_SAFE_INTEGER) as { c: number }
  ).c;
}

// ---- part_cache ----
export interface PartCacheRow {
  local_path: string;
  blob_id: string | null;
  idx: number | null;
  size: number;
  last_access_at: number;
}

export function upsertCacheRow(db: Db, row: { localPath: string; blobId: string; idx: number; size: number }): void {
  db.prepare(
    `INSERT INTO part_cache (local_path, blob_id, idx, size, last_access_at) VALUES (?,?,?,?,?)
     ON CONFLICT(local_path) DO UPDATE SET last_access_at = excluded.last_access_at, size = excluded.size`,
  ).run(row.localPath, row.blobId, row.idx, row.size, Date.now());
}

export function touchCacheRow(db: Db, localPath: string): void {
  db.prepare('UPDATE part_cache SET last_access_at = ? WHERE local_path = ?').run(Date.now(), localPath);
}

export function cacheRows(db: Db): PartCacheRow[] {
  return db.prepare('SELECT * FROM part_cache ORDER BY last_access_at ASC').all() as PartCacheRow[];
}

export function cacheTotalBytes(db: Db): { total: number; files: number } {
  const r = db.prepare('SELECT COALESCE(SUM(size),0) t, COUNT(*) c FROM part_cache').get() as {
    t: number;
    c: number;
  };
  return { total: r.t, files: r.c };
}

export function deleteCacheRow(db: Db, localPath: string): void {
  db.prepare('DELETE FROM part_cache WHERE local_path = ?').run(localPath);
}

// ---- backups ----
export function insertBackup(
  db: Db,
  b: { messageId: number | null; botId: string | null; fileName: string; size: number },
): number {
  const res = db
    .prepare('INSERT INTO backups (message_id, bot_id, file_name, size, created_at) VALUES (?,?,?,?,?)')
    .run(b.messageId, b.botId, b.fileName, b.size, Date.now());
  return Number(res.lastInsertRowid);
}

export function listBackups(db: Db): BackupRow[] {
  return db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as BackupRow[];
}
