import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { getBlob, getFile, partsByBlob } from '../db/repos/files.js';
import { getUpload } from '../db/repos/uploads.js';
import { breadcrumbs } from '../db/repos/folders.js';
import { logActivity } from '../db/repos/misc.js';
import { notFound, conflict } from '../http/errors.js';
import type { FileRow, PartRow } from '../types.js';
import { sha256File } from '../util.js';

function botUsername(ctx: AppContext, botId: string | null): string | null {
  return botId ? ctx.pool.entry(botId)?.username ?? null : null;
}

/**
 * Live server-side state of an upload's parts. `estRate` is the measured
 * throughput of the sending bot (bytes/s) so the client can animate an
 * estimate — the local Bot API itself reports no progress for sendDocument.
 */
export function uploadProgress(ctx: AppContext, uploadId: string): Record<string, unknown> {
  const upload = getUpload(ctx.db, uploadId);
  if (!upload) throw notFound('upload not found');
  const file = getFile(ctx.db, upload.file_id);
  const parts = partsByBlob(ctx.db, upload.blob_id).map((p) => {
    const active = ctx.queue.activeInfo(p.blob_id, p.idx);
    const botId = active?.botId ?? p.bot_id;
    return {
      idx: p.idx,
      size: p.size,
      status: p.status,
      phase: active?.phase ?? null,
      startedAt: active?.startedAt ?? null,
      queuePosition: p.status === 'received' ? ctx.queue.queuePosition(p.blob_id, p.idx) : 0,
      botId,
      botUsername: botUsername(ctx, botId),
      estRate: active?.phase === 'sending' ? ctx.pool.estimatedRate(botId, 'up') : null,
      attempts: p.attempts,
      lastError: p.last_error,
      nextAttemptAt: p.next_attempt_at,
    };
  });
  return {
    id: upload.id,
    fileId: upload.file_id,
    status: upload.status,
    fileStatus: file?.status ?? null,
    serverNow: Date.now(),
    parts,
  };
}

/** Where a file's bytes live: parts, owning bots, channel messages, cache + fetch state. */
export function fileStorage(ctx: AppContext, file: FileRow): Record<string, unknown> {
  const blob = file.blob_id ? getBlob(ctx.db, file.blob_id) : undefined;
  const refs = file.blob_id
    ? (ctx.db.prepare('SELECT COUNT(*) c FROM files WHERE blob_id = ?').get(file.blob_id) as { c: number }).c
    : 0;
  const parts = blob
    ? partsByBlob(ctx.db, blob.id).map((p) => {
        const fetching = ctx.cache.fetchInfo(p.blob_id, p.idx);
        const botId = fetching?.botId ?? p.bot_id;
        return {
          idx: p.idx,
          offset: p.offset,
          size: p.size,
          status: p.status,
          sha256: p.sha256,
          botId: p.bot_id,
          botUsername: botUsername(ctx, p.bot_id),
          messageId: p.message_id,
          cached: p.status === 'stored' && ctx.cache.isCached(p.blob_id, p.idx, p.size),
          fetching: fetching
            ? { startedAt: fetching.startedAt, estRate: ctx.pool.estimatedRate(botId, 'down') }
            : null,
        };
      })
    : [];
  return {
    fileId: file.id,
    size: file.size,
    contentHash: blob?.content_hash ?? null,
    verifiedAt: blob?.verified_at ?? null,
    partSize: blob?.part_size ?? null,
    references: refs,
    serverNow: Date.now(),
    parts,
  };
}

/** Warm the local cache for every part of a file (sequentially, in the background). */
export function prefetchFile(ctx: AppContext, file: FileRow): number {
  if (file.status !== 'ready' || !file.blob_id) throw conflict('file is not ready');
  const parts = partsByBlob(ctx.db, file.blob_id).filter(
    (p) => p.status === 'stored' && !ctx.cache.isCached(p.blob_id, p.idx, p.size),
  );
  void (async () => {
    for (const p of parts) {
      try {
        await ctx.cache.ensureLocal(p);
      } catch (e) {
        ctx.logger.warn({ fileId: file.id, idx: p.idx, err: (e as Error).message }, 'prefetch failed');
        return;
      }
    }
  })();
  return parts.length;
}

export interface VerifyResult {
  ok: boolean;
  checkedAt: number;
  parts: { idx: number; ok: boolean; expected: string | null; actual: string | null; error?: string }[];
}

/**
 * End-to-end integrity check: fetch every part from Telegram (via the local
 * Bot API cache) and compare its sha256 with the hash recorded at upload.
 */
export async function verifyFile(ctx: AppContext, file: FileRow): Promise<VerifyResult> {
  if (file.status !== 'ready' || !file.blob_id) throw conflict('file is not ready');
  const blobId = file.blob_id;
  const results: VerifyResult['parts'] = [];
  for (const p of partsByBlob(ctx.db, blobId)) {
    try {
      const local = await ctx.cache.ensureLocal(p);
      ctx.cache.ref(local);
      try {
        const actual = await sha256File(local);
        results.push({ idx: p.idx, ok: !p.sha256 || actual === p.sha256, expected: p.sha256, actual });
      } finally {
        ctx.cache.unref(local);
      }
    } catch (e) {
      results.push({ idx: p.idx, ok: false, expected: p.sha256, actual: null, error: (e as Error).message });
    }
  }
  const ok = results.every((r) => r.ok);
  const checkedAt = Date.now();
  if (ok) ctx.db.prepare('UPDATE blobs SET verified_at = ? WHERE id = ?').run(checkedAt, blobId);
  logActivity(ctx.db, {
    action: ok ? 'verify' : 'verify-failed',
    itemType: 'file',
    itemId: file.id,
    itemName: file.name,
    details: JSON.stringify({ parts: results.length, failed: results.filter((r) => !r.ok).map((r) => r.idx) }),
  });
  return { ok, checkedAt, parts: results };
}

export interface DuplicateGroup {
  contentHash: string;
  size: number;
  /** Distinct Telegram copies; copies made inside TeleDrive share one blob and cost nothing. */
  storedCopies: number;
  wastedBytes: number;
  files: (FileRow & { path: string })[];
}

/** Groups of non-trashed files with identical content. */
export function findDuplicates(db: Db): { groups: DuplicateGroup[]; wastedBytes: number } {
  const rows = db
    .prepare(
      `SELECT f.*, b.content_hash AS content_hash FROM files f JOIN blobs b ON b.id = f.blob_id
       WHERE f.trashed_at IS NULL AND f.status = 'ready' AND b.content_hash IN (
         SELECT b2.content_hash FROM files f2 JOIN blobs b2 ON b2.id = f2.blob_id
         WHERE f2.trashed_at IS NULL AND f2.status = 'ready' AND b2.content_hash IS NOT NULL AND f2.size > 0
         GROUP BY b2.content_hash HAVING COUNT(*) > 1
       )
       ORDER BY f.size DESC, b.content_hash, f.created_at`,
    )
    .all() as (FileRow & { content_hash: string })[];
  const byHash = new Map<string, (FileRow & { content_hash: string })[]>();
  for (const r of rows) {
    const list = byHash.get(r.content_hash) ?? [];
    list.push(r);
    byHash.set(r.content_hash, list);
  }
  const groups: DuplicateGroup[] = [...byHash.entries()].map(([hash, files]) => {
    const storedCopies = new Set(files.map((f) => f.blob_id)).size;
    const size = files[0]!.size;
    return {
      contentHash: hash,
      size,
      storedCopies,
      wastedBytes: (storedCopies - 1) * size,
      files: files.map((f) => ({ ...f, path: breadcrumbs(db, f.folder_id).map((b) => b.name).join('/') })),
    };
  });
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || b.size - a.size);
  return { groups, wastedBytes: groups.reduce((a, g) => a + g.wastedBytes, 0) };
}

/** All tags in use with their file counts. */
export function listTags(db: Db): { tag: string; count: number }[] {
  const rows = db
    .prepare(`SELECT tags FROM files WHERE trashed_at IS NULL AND status = 'ready' AND tags <> ''`)
    .all() as { tags: string }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags.split(',').map((s) => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export type { PartRow };
