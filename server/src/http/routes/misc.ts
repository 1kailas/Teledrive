import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { listActivity, listBackups, setSetting } from '../../db/repos/misc.js';
import { emptyTrash, listTrash } from '../../services/trash.js';
import { search, suggest } from '../../services/search.js';
import { stats } from '../../services/stats.js';
import { retryFailedParts, systemInfo } from '../../services/system.js';
import { runBackup, markBackupDone } from '../../services/backup.js';
import {
  applyUploadSettings,
  parseUploadSettings,
  persistUploadSettings,
  uploadSettingsSnapshot,
  UPLOAD_SETTING_KEYS,
} from '../../services/settings.js';
import { toFileDTO, toFolderDTO } from '../dto.js';
import { badRequest } from '../errors.js';
import { createGzip } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const SETTINGS_ALLOWLIST = new Set([
  'theme', 'viewMode', 'sort', 'sortOrder', 'gridSize', 'sidebarCollapsed', 'language', 'accentColor',
  'cardSize', 'nameDisplay', 'uploadConflict',
]);

const UPLOAD_SETTING_SET = new Set<string>(UPLOAD_SETTING_KEYS);

export function registerMiscRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // ---- trash ----
  app.get('/api/trash', async () => {
    const { folders, files, totalSize } = listTrash(ctx);
    return {
      folders: folders.map((f) => toFolderDTO(db, f)),
      files: files.map((f) => toFileDTO(db, f)),
      totalSize,
    };
  });

  app.delete('/api/trash', async () => {
    const n = emptyTrash(ctx);
    return { ok: true, affected: n };
  });

  // ---- search ----
  app.get('/api/search', async (req) => {
    const q = req.query as Record<string, string>;
    const result = search(db, {
      q: q['q'],
      category: q['category'],
      minSize: q['minSize'] ? Number(q['minSize']) : undefined,
      maxSize: q['maxSize'] ? Number(q['maxSize']) : undefined,
      from: q['from'] ? Number(q['from']) : undefined,
      to: q['to'] ? Number(q['to']) : undefined,
      folderId: q['folderId'],
      starred: q['starred'] === 'true' || q['starred'] === '1',
      tag: q['tag'] || undefined,
      sort: q['sort'],
      order: q['order'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    });
    return {
      files: result.files.map((f) => ({ ...toFileDTO(db, f), path: f.path })),
      folders: result.folders.map((f) => toFolderDTO(db, f)),
      total: result.total,
    };
  });

  app.get('/api/search/suggest', async (req) => {
    const q = (req.query as Record<string, string>)['q'] ?? '';
    return { suggestions: q ? suggest(db, q) : [] };
  });

  // ---- stats / activity ----
  app.get('/api/stats', async () => {
    const s = stats(db, ctx.pool);
    return { ...s, largestFiles: (s['largestFiles'] as import('../../types.js').FileRow[]).map((f) => toFileDTO(db, f)) };
  });

  app.get('/api/activity', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '100', 10) || 100, 500);
    const before = q['before'] ? parseInt(q['before'], 10) : undefined;
    return { activity: listActivity(db, limit, before) };
  });

  // ---- system ----
  app.get('/api/system', async () => systemInfo(ctx));

  app.post('/api/system/retry-failed', async () => {
    const { uploads, parts } = retryFailedParts(ctx);
    return { ok: true, retried: uploads, parts };
  });

  app.post('/api/system/clear-cache', async () => {
    const freedBytes = ctx.cache.clearAll();
    return { ok: true, freedBytes };
  });

  // ---- settings (UI prefs + upload tuning) ----
  app.get('/api/settings', async () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      if (!SETTINGS_ALLOWLIST.has(r.key)) continue;
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    // Upload tuning lives in the live config (persisted separately so invalid
    // or stale values can never be served back to the UI).
    Object.assign(out, uploadSettingsSnapshot(ctx.config));
    return { settings: out };
  });

  app.patch('/api/settings', async (req) => {
    const body = z.record(z.string(), z.unknown()).safeParse(req.body);
    if (!body.success) throw badRequest('settings object required');

    const prefs: Record<string, unknown> = {};
    const uploadPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.data)) {
      if (UPLOAD_SETTING_SET.has(k)) {
        uploadPatch[k] = v;
        continue;
      }
      if (!SETTINGS_ALLOWLIST.has(k)) throw badRequest(`setting key "${k}" not allowed`);
      prefs[k] = v;
    }

    // Validate every upload value before writing anything, then persist all
    // preference and tuning keys in one transaction so a bad value cannot
    // leave half of the patch applied.
    let nextUpload;
    try {
      nextUpload = parseUploadSettings(ctx.config, uploadPatch);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    db.transaction(() => {
      for (const [k, v] of Object.entries(prefs)) setSetting(db, k, JSON.stringify(v));
      persistUploadSettings(db, nextUpload);
    })();

    let upload = uploadSettingsSnapshot(ctx.config);
    if (Object.keys(nextUpload).length > 0) {
      applyUploadSettings(ctx.config, nextUpload);
      upload = uploadSettingsSnapshot(ctx.config);
      ctx.bus.emit('settings.upload', upload);
    }
    return { ok: true, upload };
  });

  // ---- backups ----
  app.get('/api/backups', async () => {
    const rows = listBackups(db).map((b) => ({
      id: b.id,
      messageId: b.message_id,
      botId: b.bot_id,
      fileName: b.file_name,
      size: b.size,
      createdAt: b.created_at,
    }));
    return { backups: rows };
  });

  app.post('/api/backups', async () => {
    const result = await runBackup(ctx);
    if (result) markBackupDone(ctx);
    return { backup: result };
  });

  app.get('/api/backups/download', async (req, reply) => {
    const tmpDb = path.join(os.tmpdir(), `teledrive-backup-dl-${process.pid}-${Date.now()}.db`);
    const tmpGz = `${tmpDb}.gz`;
    try {
      await db.backup(tmpDb);
      await pipeline(fs.createReadStream(tmpDb), createGzip({ level: 6 }), fs.createWriteStream(tmpGz));
      const size = fs.statSync(tmpGz).size;
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Disposition', `attachment; filename="teledrive-backup-${new Date().toISOString().slice(0, 10)}.db.gz"`);
      reply.header('Content-Length', String(size));
      const stream = fs.createReadStream(tmpGz);
      stream.on('close', () => {
        fs.rmSync(tmpDb, { force: true });
        fs.rmSync(tmpGz, { force: true });
      });
      return reply.send(stream);
    } catch (e) {
      fs.rmSync(tmpDb, { force: true });
      fs.rmSync(tmpGz, { force: true });
      throw e;
    }
  });

  // ---- server-sent events ----
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const off = ctx.bus.onAny((event, payload) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch { /* closed */ }
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': hb\n\n');
      } catch { /* closed */ }
    }, 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
    return reply;
  });
}
