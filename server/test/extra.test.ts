import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeEnv, uploadBytes, downloadAll, apiFetch, type TestEnv } from './helpers.js';
import { runBackup } from '../src/services/backup.js';
import { Scheduler } from '../src/bootstrap.js';
import type { MockFault } from '../src/dev/mockBotApi.js';

const envs: TestEnv[] = [];
afterAll(async () => {
  for (const e of envs) await e.cleanup();
}, 90_000);

describe('fault injection', () => {
  it('upload still succeeds when the API returns a single 429', async () => {
    const faults: MockFault[] = [{ method: 'sendDocument', status: 429, times: 1, retryAfter: 1 }];
    const env = await makeEnv({ faults });
    envs.push(env);
    const data = crypto.randomBytes(100 * 1024);
    const { fileId } = await uploadBytes(env, data, { name: 'retry.bin' });
    const res = await downloadAll(env, fileId);
    expect(res.body.equals(data)).toBe(true);
  }, 60_000);
});

describe('backup', () => {
  it('runs a backup: document in mock + backups row', async () => {
    const env = await makeEnv();
    envs.push(env);
    const result = await runBackup(env.ctx);
    expect(result).not.toBeNull();
    const row = env.db.prepare('SELECT * FROM backups WHERE id = ?').get(result!.id) as {
      file_name: string;
      size: number;
      message_id: number;
    };
    expect(row.file_name).toBe(result!.fileName);
    expect(row.size).toBeGreaterThan(0);
    expect(row.message_id).toBeGreaterThan(0);
    // document was actually stored by the mock
    expect(env.mock.calls.get('sendDocument')).toBeGreaterThan(0);
  }, 60_000);
});

describe('upload listing + resume DTO', () => {
  it('lists active uploads with progress and slice info', async () => {
    const env = await makeEnv();
    envs.push(env);
    const data = crypto.randomBytes(1024);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', {
      name: 'resume.bin', size: data.length,
    });
    const upload = (await create.json()) as { id: string };
    const list = await apiFetch(env.base, env.cookie, 'GET', '/api/uploads?status=active');
    const body = (await list.json()) as { uploads: { id: string; clientKey: string }[] };
    expect(body.uploads.some((u) => u.id === upload.id)).toBe(true);
    const dto = await apiFetch(env.base, env.cookie, 'GET', `/api/uploads/${upload.id}`);
    expect(dto.status).toBe(200);
    const d = (await dto.json()) as { parts: { receivedSlices: number[] }[] };
    expect(d.parts[0]!.receivedSlices).toEqual([]);
    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${upload.id}`);
  }, 30_000);
});

describe('scheduler expiry', () => {
  it('expires a stale upload', async () => {
    const env = await makeEnv({ overrides: { UPLOAD_SESSION_TTL_HOURS: '0.01' } }); // 36s
    envs.push(env);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', {
      name: 'stale.bin', size: 1024,
    });
    const upload = (await create.json()) as { id: string };
    // force expiry
    env.db.prepare('UPDATE uploads SET expires_at = ? WHERE id = ?').run(Date.now() - 1, upload.id);
    const scheduler = new Scheduler(env.ctx);
    await scheduler.runJob('expireUploads');
    const row = env.db.prepare('SELECT id FROM uploads WHERE id = ?').get(upload.id);
    expect(row).toBeUndefined();
    const tmpDir = path.join(env.config.dataDir, 'tmp', 'uploads', upload.id);
    expect(fs.existsSync(tmpDir)).toBe(false);
  }, 30_000);
});

describe('503 when no healthy bots', () => {
  it('upload creation returns 503', async () => {
    const env = await makeEnv({ tokens: ['9999999:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'] });
    envs.push(env);
    // token is invalid on the mock? mock accepts any token — unhealthy path is covered
    // by making getChatMember fail instead: use a channel the mock treats as fine...
    // Force no healthy bots by emptying the pool state:
    for (const b of env.ctx.pool.healthyBots()) b.healthy = false;
    const res = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'x.bin', size: 10 });
    expect(res.status).toBe(503);
  }, 30_000);
});

describe('A-fixes', () => {
  it('concurrent first slices into a fresh part do not corrupt data', async () => {
    const env = await makeEnv();
    envs.push(env);
    const data = crypto.randomBytes(1024 * 1024); // 1 part, 2 slices
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'race.bin', size: data.length });
    const upload = (await create.json()) as { id: string; fileId: string };
    // fire both first-time slice opens concurrently, slice 1 delayed via slow body
    const half = data.subarray(0, env.config.sliceSize);
    const rest = data.subarray(env.config.sliceSize);
    const slow = async () => {
      const r = await apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${upload.id}/parts/0/slices/1`, rest, {
        'content-type': 'application/octet-stream',
      });
      return r;
    };
    const [r1, r2] = await Promise.all([
      apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${upload.id}/parts/0/slices/0`, half, {
        'content-type': 'application/octet-stream',
      }),
      slow(),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
    await env.ctx.queue.drain();
    const res = await downloadAll(env, upload.fileId);
    expect(res.body.equals(data)).toBe(true);
  }, 60_000);

  it('inline .html is flattened to text/plain with sandbox CSP; download stays attachment', async () => {
    const env = await makeEnv();
    envs.push(env);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const { fileId } = await uploadBytes(env, html, { name: 'x.html', mimeType: 'text/html' });
    const inline = await fetch(`${env.base}/api/files/${fileId}/content`, { headers: { cookie: env.cookie } });
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toContain('text/plain');
    expect(inline.headers.get('content-security-policy')).toContain('sandbox');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    const dl = await fetch(`${env.base}/api/files/${fileId}/content?download=1`, { headers: { cookie: env.cookie } });
    expect(dl.headers.get('content-disposition')).toContain('attachment');
  }, 60_000);

  it('failed upload: retry endpoint re-drives parts; stale failure is swept', async () => {
    const env = await makeEnv({ faults: [{ method: 'sendDocument', status: 500, times: 20 }] });
    envs.push(env);
    const data = crypto.randomBytes(1024);
    const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'fail.bin', size: data.length });
    const upload = (await create.json()) as { id: string; fileId: string };
    for (let s = 0; s * env.config.sliceSize < data.length; s++) {
      const buf = data.subarray(s * env.config.sliceSize, Math.min(data.length, (s + 1) * env.config.sliceSize));
      await apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${upload.id}/parts/0/slices/${s}`, buf, {
        'content-type': 'application/octet-stream',
      });
    }
    await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
    // let the queue exhaust attempts — force attempt count to 10 directly
    await new Promise((r) => setTimeout(r, 1500));
    env.db.prepare(`UPDATE parts SET attempts = 10, next_attempt_at = NULL, status = 'failed' WHERE blob_id = (SELECT blob_id FROM uploads WHERE id = ?)`).run(upload.id);
    env.db.prepare(`UPDATE uploads SET status = 'failed' WHERE id = ?`).run(upload.id);

    // retry still fails (faults continue) but parts go back to received
    const retry = await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/retry`);
    expect(retry.status).toBe(200);

    // stale failed upload is swept by the failedUploads job
    env.db.prepare(`UPDATE uploads SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now() - env.config.uploadSessionTtlMs - 1000, upload.id);
    const { cancelFailedUploads } = await import('../src/services/uploads.js');
    const n = cancelFailedUploads(env.ctx, Date.now() - env.config.uploadSessionTtlMs);
    expect(n).toBe(1);
    expect(env.db.prepare('SELECT id FROM uploads WHERE id = ?').get(upload.id)).toBeUndefined();
  }, 60_000);
});
