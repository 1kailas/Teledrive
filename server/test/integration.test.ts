import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import yauzl from 'yauzl';
import {
  makeEnv, apiFetch, login, uploadBytes, downloadAll,
  TOKEN1, TOKEN2, ADMIN_PASSWORD, testConfig,
  type TestEnv,
} from './helpers.js';
import { openDb } from '../src/db/index.js';
import { createContext, Scheduler } from '../src/bootstrap.js';
import { buildApp } from '../src/http/app.js';
import { recoverUploads } from '../src/services/uploads.js';
import { PartCache } from '../src/services/partCache.js';
import { BotPool } from '../src/telegram/botPool.js';
import { pino } from 'pino';
import { startMockBotApi } from '../src/dev/mockBotApi.js';
import type { PartRow } from '../src/types.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
}, 90_000);
afterAll(async () => {
  await env.cleanup();
}, 90_000);

describe('auth', () => {
  it('rejects wrong password, accepts right password, enforces CSRF', async () => {
    const bad = await fetch(`${env.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'nope-nope-nope' }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${env.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    expect(good.status).toBe(200);
    expect(good.headers.get('set-cookie')).toContain('td_session=');

    // CSRF: POST without X-Requested-With -> 403
    const noCsrf = await fetch(`${env.base}/api/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: env.cookie },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noCsrf.status).toBe(403);

    // unauthenticated
    const noAuth = await fetch(`${env.base}/api/drive`);
    expect(noAuth.status).toBe(401);
  });
});

describe('upload + download round trip', () => {
  it('uploads 5.3 MiB out-of-order, downloads identical bytes with ranges', async () => {
    const data = crypto.randomBytes(Math.floor(5.3 * 1024 * 1024));
    const { fileId } = await uploadBytes(env, data, { name: 'random.bin' });

    const full = await downloadAll(env, fileId);
    expect(full.status).toBe(200);
    expect(full.body.equals(data)).toBe(true);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('etag')).toBeTruthy();

    // range across the part boundary (partSize = 2 MiB)
    const start = 2 * 1024 * 1024 - 100;
    const end = 2 * 1024 * 1024 + 100;
    const ranged = await downloadAll(env, fileId, { range: `bytes=${start}-${end}` });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(data.subarray(start, end + 1))).toBe(true);
    expect(ranged.headers.get('content-range')).toBe(`bytes ${start}-${end}/${data.length}`);

    // suffix range
    const suffix = await downloadAll(env, fileId, { range: 'bytes=-512' });
    expect(suffix.status).toBe(206);
    expect(suffix.body.equals(data.subarray(data.length - 512))).toBe(true);

    // unsatisfiable
    const bad = await downloadAll(env, fileId, { range: `bytes=${data.length + 5}-` });
    expect(bad.status).toBe(416);
  }, 60_000);

  it('rejects incomplete complete with missing slice list', async () => {
    const data = crypto.randomBytes(600 * 1024);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', {
      name: 'incomplete.bin', size: data.length,
    });
    const upload = (await create.json()) as { id: string };
    const res = await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { missing: unknown[] } } };
    expect(body.error.details.missing.length).toBeGreaterThan(0);
    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${upload.id}`);
  });
});

describe('bot pool', () => {
  it('distributes parts across both bots', async () => {
    const data = crypto.randomBytes(Math.floor(4.5 * 1024 * 1024)); // 3 parts
    const { fileId } = await uploadBytes(env, data, { name: 'multi-bot.bin' });
    const file = env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string };
    const bots = env.db
      .prepare('SELECT DISTINCT bot_id FROM parts WHERE blob_id = ?')
      .all(file.blob_id) as { bot_id: string }[];
    expect(bots.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('downloads via owner fallback when the owner bot is gone', async () => {
    const data = crypto.randomBytes(700 * 1024);
    const { fileId } = await uploadBytes(env, data, { name: 'fallback.bin' });
    // rebuild the pool with only TOKEN2
    const config2 = { ...env.config, botTokens: [TOKEN2] };
    const pool2 = new BotPool(config2, env.db, pino({ level: 'silent' }), null);
    await pool2.init();
    expect(pool2.healthyCount()).toBe(1);
    env.ctx.pool = pool2;
    env.ctx.cache = new PartCache(env.config, env.db, pool2, pino({ level: 'silent' }));

    const res = await downloadAll(env, fileId);
    expect(res.status).toBe(200);
    expect(res.body.equals(data)).toBe(true);

    // parts that belonged to bot 1 got reassigned to bot 2
    const parts = env.db
      .prepare(`SELECT p.* FROM parts p JOIN files f ON f.blob_id = p.blob_id WHERE f.id = ?`)
      .all(fileId) as PartRow[];
    expect(parts.every((p) => p.bot_id === TOKEN2.split(':')[0])).toBe(true);

    // restore the original pool for later tests
    const pool = new BotPool(env.config, env.db, pino({ level: 'silent' }), null);
    await pool.init();
    env.ctx.pool = pool;
    env.ctx.cache = new PartCache(env.config, env.db, pool, pino({ level: 'silent' }));
  }, 60_000);
});

describe('media', () => {
  it('generates a webp thumbnail for a PNG', async () => {
    const png = await sharp({
      create: { width: 640, height: 320, channels: 3, background: { r: 200, g: 20, b: 20 } },
    })
      .png()
      .toBuffer();
    const { fileId } = await uploadBytes(env, png, { name: 'pic.png', mimeType: 'image/png' });
    const f = env.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as {
      has_thumbnail: number; width: number; height: number;
    };
    expect(f.has_thumbnail).toBe(1);
    expect(f.width).toBe(640);
    expect(f.height).toBe(320);
    const res = await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe('webp');
  }, 60_000);
});

describe('folders', () => {
  it('create/rename/move; descendant move rejected; relativePath creates folders', async () => {
    const mk = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'parent' });
    const parent = ((await mk.json()) as { folder: { id: string } }).folder;
    const mkChild = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'child', parentId: parent.id });
    const child = ((await mkChild.json()) as { folder: { id: string } }).folder;

    // duplicate name -> 409
    const dup = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'child', parentId: parent.id });
    expect(dup.status).toBe(409);

    // rename
    const ren = await apiFetch(env.base, env.cookie, 'PATCH', `/api/folders/${child.id}`, { name: 'renamed' });
    expect(ren.status).toBe(200);
    expect(((await ren.json()) as { folder: { name: string } }).folder.name).toBe('renamed');

    // move parent into its own child -> 400
    const bad = await apiFetch(env.base, env.cookie, 'PATCH', `/api/folders/${parent.id}`, { parentId: child.id });
    expect(bad.status).toBe(400);

    // relativePath upload creates nested folders
    const { fileId } = await uploadBytes(env, Buffer.from('x'), {
      name: 'deep.txt',
      relativePath: 'auto/nested/deep.txt',
      folderId: parent.id,
    });
    const drive = await apiFetch(env.base, env.cookie, 'GET', '/api/drive');
    const f = env.db.prepare('SELECT folder_id FROM files WHERE id = ?').get(fileId) as { folder_id: string };
    const nested = env.db.prepare('SELECT name, parent_id FROM folders WHERE id = ?').get(f.folder_id) as { name: string };
    expect(nested.name).toBe('nested');
    void drive;
  }, 60_000);
});

describe('blob refcount + deletions', () => {
  it('copy keeps blob; deleting last reference enqueues telegram deletions', async () => {
    const data = crypto.randomBytes(700 * 1024);
    const { fileId } = await uploadBytes(env, data, { name: 'ref.bin' });

    const copy = await apiFetch(env.base, env.cookie, 'POST', `/api/files/${fileId}/copy`, {});
    expect(copy.status).toBe(200);
    const copyId = ((await copy.json()) as { file: { id: string } }).file.id;

    // delete the original -> blob still referenced by copy -> no deletions
    await apiFetch(env.base, env.cookie, 'POST', '/api/items/delete', { fileIds: [fileId] });
    const pending0 = env.db.prepare('SELECT COUNT(*) c FROM tg_deletions').get() as { c: number };
    // no deletion rows for this blob's message ids
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(copyId) as { blob_id: string }).blob_id;
    const stillExists = env.db.prepare('SELECT id FROM blobs WHERE id = ?').get(blobId);
    expect(stillExists).toBeTruthy();

    // delete the copy -> deletions enqueued
    await apiFetch(env.base, env.cookie, 'POST', '/api/items/delete', { fileIds: [copyId] });
    const pending1 = (env.db.prepare('SELECT COUNT(*) c FROM tg_deletions').get() as { c: number }).c;
    expect(pending1).toBeGreaterThan(pending0.c);
    const blobGone = env.db.prepare('SELECT id FROM blobs WHERE id = ?').get(blobId);
    expect(blobGone).toBeUndefined();

    // scheduler job deletes them in the mock
    const scheduler = new Scheduler(env.ctx);
    await scheduler.runJob('tgDeletions');
    const left = (env.db.prepare('SELECT COUNT(*) c FROM tg_deletions').get() as { c: number }).c;
    expect(left).toBe(0);
  }, 60_000);
});

describe('trash', () => {
  it('trash folder with nested items -> restore -> all back; empty -> gone', async () => {
    const mk = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'trashme' });
    const folder = ((await mk.json()) as { folder: { id: string } }).folder;
    const { fileId } = await uploadBytes(env, Buffer.from('zzz'), { name: 'inner.txt', folderId: folder.id });

    await apiFetch(env.base, env.cookie, 'POST', '/api/items/trash', { folderIds: [folder.id] });
    const trashed = env.db.prepare('SELECT trashed_at FROM files WHERE id = ?').get(fileId) as { trashed_at: number };
    expect(trashed.trashed_at).toBeTruthy();

    const trash = await apiFetch(env.base, env.cookie, 'GET', '/api/trash');
    const trashBody = (await trash.json()) as { folders: { id: string }[]; files: { id: string }[] };
    expect(trashBody.folders.some((f) => f.id === folder.id)).toBe(true);

    await apiFetch(env.base, env.cookie, 'POST', '/api/items/restore', { folderIds: [folder.id] });
    const back = env.db.prepare('SELECT trashed_at FROM files WHERE id = ?').get(fileId) as { trashed_at: number | null };
    expect(back.trashed_at).toBeNull();
    const folderBack = env.db.prepare('SELECT trashed_at FROM folders WHERE id = ?').get(folder.id) as { trashed_at: number | null };
    expect(folderBack.trashed_at).toBeNull();

    // trash again then empty
    await apiFetch(env.base, env.cookie, 'POST', '/api/items/trash', { folderIds: [folder.id] });
    await apiFetch(env.base, env.cookie, 'DELETE', '/api/trash');
    const gone = env.db.prepare('SELECT id FROM folders WHERE id = ?').get(folder.id);
    expect(gone).toBeUndefined();
    const fileGone = env.db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
    expect(fileGone).toBeUndefined();
  }, 60_000);
});

describe('shares', () => {
  it('password unlock, download limit, subtree restriction', async () => {
    const data = crypto.randomBytes(300 * 1024);
    const { fileId } = await uploadBytes(env, data, { name: 'shared.bin' });

    // file share with password + maxDownloads=1
    const mk = await apiFetch(env.base, env.cookie, 'POST', '/api/shares', {
      fileId, password: 'secret123', maxDownloads: 1,
    });
    const { share } = (await mk.json()) as { share: { token: string } };
    const pub = (p: string, init?: RequestInit) => fetch(`${env.base}${p}`, init);

    // metadata: locked
    let meta = await pub(`/api/public/shares/${share.token}`);
    let metaBody = (await meta.json()) as { requiresPassword: boolean; unlocked: boolean };
    expect(metaBody.requiresPassword).toBe(true);
    expect(metaBody.unlocked).toBe(false);

    // content before unlock -> 401
    const locked = await pub(`/api/public/shares/${share.token}/files/${fileId}/content`);
    expect(locked.status).toBe(401);

    // unlock (wrong pw -> 401)
    const wrong = await pub(`/api/public/shares/${share.token}/unlock`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nah' }),
    });
    expect(wrong.status).toBe(401);
    const unlock = await pub(`/api/public/shares/${share.token}/unlock`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret123' }),
    });
    expect(unlock.status).toBe(200);
    const shareCookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0]!;

    // download 1 ok (with ?download=1), second -> 410
    const dl1 = await pub(`/api/public/shares/${share.token}/files/${fileId}/content?download=1`, {
      headers: { cookie: shareCookie },
    });
    expect(dl1.status).toBe(200);
    expect(Buffer.from(await dl1.arrayBuffer()).equals(data)).toBe(true);
    const dl2 = await pub(`/api/public/shares/${share.token}/files/${fileId}/content?download=1`, {
      headers: { cookie: shareCookie },
    });
    expect(dl2.status).toBe(410);
  }, 60_000);

  it('folder share cannot access files outside the subtree', async () => {
    const mk = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'shared-root' });
    const root = ((await mk.json()) as { folder: { id: string } }).folder;
    const { fileId: insideId } = await uploadBytes(env, Buffer.from('in'), { name: 'in.txt', folderId: root.id });
    const { fileId: outsideId } = await uploadBytes(env, Buffer.from('out'), { name: 'out.txt' });

    const mkShare = await apiFetch(env.base, env.cookie, 'POST', '/api/shares', { folderId: root.id });
    const { share } = (await mkShare.json()) as { share: { token: string } };

    const inside = await fetch(`${env.base}/api/public/shares/${share.token}/files/${insideId}/content`);
    expect(inside.status).toBe(200);
    const outside = await fetch(`${env.base}/api/public/shares/${share.token}/files/${outsideId}/content`);
    expect([403, 404]).toContain(outside.status);

    const listing = await fetch(`${env.base}/api/public/shares/${share.token}/folders/${root.id}`);
    expect(listing.status).toBe(200);
    const lb = (await listing.json()) as { files: { id: string }[] };
    expect(lb.files.some((f) => f.id === insideId)).toBe(true);
  }, 60_000);
});

describe('search', () => {
  it('finds by partial name; excludes trashed', async () => {
    await uploadBytes(env, Buffer.from('q'), { name: 'uniquely-named-search-target.txt' });
    const res = await apiFetch(env.base, env.cookie, 'GET', '/api/search?q=uniquely-named');
    const body = (await res.json()) as { files: { name: string }[] };
    expect(body.files.some((f) => f.name === 'uniquely-named-search-target.txt')).toBe(true);

    const { fileId } = await uploadBytes(env, Buffer.from('q'), { name: 'trashed-search-target.txt' });
    await apiFetch(env.base, env.cookie, 'POST', '/api/items/trash', { fileIds: [fileId] });
    const res2 = await apiFetch(env.base, env.cookie, 'GET', '/api/search?q=trashed-search');
    const body2 = (await res2.json()) as { files: { name: string }[] };
    expect(body2.files.some((f) => f.name === 'trashed-search-target.txt')).toBe(false);
  }, 60_000);
});

describe('zip', () => {
  it('produces a zip with expected entries', async () => {
    const mk = await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'ziproot' });
    const root = ((await mk.json()) as { folder: { id: string } }).folder;
    const contents = Buffer.from('zip-inner-content');
    await uploadBytes(env, contents, { name: 'a.txt', folderId: root.id });
    await uploadBytes(env, contents, { name: 'b.txt', folderId: root.id });

    const mkZip = await apiFetch(env.base, env.cookie, 'POST', '/api/zip', { folderIds: [root.id] });
    const { url } = (await mkZip.json()) as { url: string };
    const res = await fetch(`${env.base}${url}`, { headers: { cookie: env.cookie } });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const names = await zipEntryNames(buf);
    expect(names.some((n) => n.endsWith('ziproot/a.txt'))).toBe(true);
    expect(names.some((n) => n.endsWith('ziproot/b.txt'))).toBe(true);
  }, 60_000);
});

describe('cancel + recovery', () => {
  it('cancel removes temp dir and rows', async () => {
    const data = crypto.randomBytes(1024);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'cancel.bin', size: data.length });
    const upload = (await create.json()) as { id: string; blobId?: string; fileId: string };
    const tmpDir = path.join(env.config.dataDir, 'tmp', 'uploads', upload.id);
    expect(fs.existsSync(tmpDir)).toBe(true);
    const res = await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${upload.id}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(tmpDir)).toBe(false);
    const row = env.db.prepare('SELECT id FROM uploads WHERE id = ?').get(upload.id);
    expect(row).toBeUndefined();
    const file = env.db.prepare('SELECT id FROM files WHERE id = ?').get(upload.fileId);
    expect(file).toBeUndefined();
  });

  it('recovery re-queues a part stuck in uploading', async () => {
    const data = crypto.randomBytes(1024);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'rec.bin', size: data.length });
    const upload = (await create.json()) as {
      id: string; fileId: string; parts: { idx: number; size: number }[];
    };
    // write all slices of part 0 manually
    const part = upload.parts[0]!;
    const sliceSize = env.config.sliceSize;
    for (let s = 0; s * sliceSize < part.size; s++) {
      const buf = data.subarray(s * sliceSize, Math.min(part.size, (s + 1) * sliceSize));
      const r = await apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${upload.id}/parts/0/slices/${s}`, buf, {
        'content-type': 'application/octet-stream',
      });
      expect(r.ok).toBe(true);
    }
    // fake a crash mid-upload
    env.db.prepare(`UPDATE parts SET status = 'uploading' WHERE blob_id = (SELECT blob_id FROM uploads WHERE id = ?)`).run(upload.id);
    const requeued = recoverUploads(env.ctx);
    expect(requeued.requeued).toBe(1);
    await env.ctx.queue.drain();
    const part2 = env.db
      .prepare(`SELECT status FROM parts WHERE blob_id = (SELECT blob_id FROM uploads WHERE id = ?) AND idx = 0`)
      .get(upload.id) as { status: string };
    expect(part2.status).toBe('stored');
    await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
    await env.ctx.queue.drain();
  }, 60_000);
});

describe('system endpoints', () => {
  it('health/config/system/stats respond', async () => {
    const health = await fetch(`${env.base}/api/health`);
    expect((await health.json() as { status: string }).status).toBe('ok');
    const cfg = await fetch(`${env.base}/api/config`);
    const cfgBody = (await cfg.json()) as { sliceSize: number; partSize: number };
    expect(cfgBody.sliceSize).toBe(env.config.sliceSize);
    const sys = await apiFetch(env.base, env.cookie, 'GET', '/api/system');
    const sysBody = (await sys.json()) as { botApi: { reachable: boolean }; bots: { healthy: boolean }[] };
    expect(sysBody.botApi.reachable).toBe(true);
    expect(sysBody.bots.filter((b) => b.healthy).length).toBe(2);
    const stats = await apiFetch(env.base, env.cookie, 'GET', '/api/stats');
    expect(stats.status).toBe(200);
  });
});

async function zipEntryNames(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err);
      const names: string[] = [];
      zipfile.on('entry', (e) => {
        names.push(e.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}
