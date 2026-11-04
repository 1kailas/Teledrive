import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeEnv, apiFetch, testConfig, uploadBytes, type TestEnv } from './helpers.js';
import { applyPersistedSettings } from '../src/services/settings.js';
import { BotApiClient } from '../src/telegram/botApi.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
}, 90_000);
afterAll(async () => {
  await env.cleanup();
}, 90_000);

describe('upload idempotency', () => {
  it('reuses an active session for a repeated clientKey', async () => {
    const body = {
      name: 'same-client-key.bin',
      size: 512 * 1024,
      clientKey: 'reliability-same-key|1',
    };
    const first = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', body);
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string; fileId: string; parts: unknown[] };

    const second = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', body);
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string; fileId: string; parts: unknown[] };
    expect(b.id).toBe(a.id);
    expect(b.fileId).toBe(a.fileId);
    expect(b.parts).toHaveLength(a.parts.length);
    expect(env.db.prepare('SELECT COUNT(*) c FROM uploads').get()).toMatchObject({ c: 1 });

    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${a.id}`);

    const third = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', body);
    expect(third.status).toBe(200);
    const c = (await third.json()) as { id: string };
    expect(c.id).not.toBe(a.id);
    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${c.id}`);
  }, 30_000);

  it('resumes a relativePath upload without duplicating its folder session', async () => {
    const body = {
      name: 'nested.txt',
      size: 128,
      relativePath: 'dedupe-root/nested/nested.txt',
      clientKey: 'reliability-nested-key|1',
    };
    const first = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', body);
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string; fileId: string };

    const second = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', body);
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string; fileId: string };
    expect(b.id).toBe(a.id);
    expect(b.fileId).toBe(a.fileId);

    const folders = env.db
      .prepare(`SELECT COUNT(*) c FROM folders WHERE name = 'nested' AND trashed_at IS NULL`)
      .get() as { c: number };
    expect(folders.c).toBe(1);
    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${a.id}`);
  }, 30_000);

  it('does not send a duplicate Telegram document for duplicated slices', async () => {
    const before = env.mock.calls.get('sendDocument') ?? 0;
    const data = crypto.randomBytes(Math.floor(env.config.partSize + 256 * 1024));
    const { fileId } = await uploadBytes(env, data, { name: 'no-duplicate-slices.bin' });
    const expectedParts = Math.ceil(data.length / env.config.partSize);
    expect(env.mock.calls.get('sendDocument')).toBe(before + expectedParts);
    expect(fileId).toBeTruthy();
  }, 60_000);
});

describe('upload settings', () => {
  it('persists, clamps, and rejects invalid tuning values', async () => {
    const patched = await apiFetch(env.base, env.cookie, 'PATCH', '/api/settings', {
      partSizeMb: 7,
      uploadConcurrency: 6,
      telegramUploadConcurrency: 3,
      botMaxConcurrentUploads: 3,
    });
    expect(patched.status).toBe(200);
    expect(env.config.partSize).toBe(7 * 1024 * 1024);
    expect(env.config.clientUploadConcurrency).toBe(6);
    expect(env.config.telegramUploadConcurrency).toBe(3);
    expect(env.config.botMaxConcurrentUploads).toBe(3);

    const settings = await apiFetch(env.base, env.cookie, 'GET', '/api/settings');
    const body = (await settings.json()) as {
      settings: {
        partSizeMb: number;
        effectivePartSizeMb: number;
        maxAllowedMb: number;
        uploadConcurrency: number;
        telegramUploadConcurrency: number;
        botMaxConcurrentUploads: number;
      };
    };
    expect(body.settings).toMatchObject({
      partSizeMb: 7,
      effectivePartSizeMb: 7,
      maxAllowedMb: 2000,
      uploadConcurrency: 6,
      telegramUploadConcurrency: 3,
      botMaxConcurrentUploads: 3,
    });

    // A fresh config (simulating a restart) picks the saved values back up.
    const restarted = testConfig(env.dataDir, env.mock.port, env.mock.dir);
    applyPersistedSettings(restarted, env.db);
    expect(restarted.partSize).toBe(7 * 1024 * 1024);
    expect(restarted.clientUploadConcurrency).toBe(6);
    expect(restarted.telegramUploadConcurrency).toBe(3);
    expect(restarted.botMaxConcurrentUploads).toBe(3);

    const clamped = await apiFetch(env.base, env.cookie, 'PATCH', '/api/settings', {
      partSizeMb: 1,
      uploadConcurrency: 999,
      telegramUploadConcurrency: -5,
      botMaxConcurrentUploads: 99,
    });
    expect(clamped.status).toBe(200);
    const clampedBody = (await clamped.json()) as {
      upload: { partSizeMb: number; uploadConcurrency: number; telegramUploadConcurrency: number; botMaxConcurrentUploads: number };
    };
    expect(clampedBody.upload).toMatchObject({
      partSizeMb: 5,
      uploadConcurrency: 32,
      telegramUploadConcurrency: 0,
      botMaxConcurrentUploads: 8,
    });
    expect(env.config.partSize).toBe(5 * 1024 * 1024);

    const invalid = await apiFetch(env.base, env.cookie, 'PATCH', '/api/settings', {
      uploadConcurrency: 'not-a-number',
    });
    expect(invalid.status).toBe(400);

    // Leave this test environment's normal defaults in place.
    await apiFetch(env.base, env.cookie, 'PATCH', '/api/settings', {
      partSizeMb: 5,
      uploadConcurrency: 4,
      telegramUploadConcurrency: 4,
      botMaxConcurrentUploads: 2,
    });
  }, 30_000);
});

describe('non-JSON Telegram errors', () => {
  it('preserves the HTTP status without retrying a permanent 4xx', async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls++;
      res.writeHead(413, { 'content-type': 'text/html' });
      res.end('<html><body>Request Entity Too Large</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new BotApiClient(`http://127.0.0.1:${port}`, '1111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    try {
      await expect(client.call('sendDocument')).rejects.toMatchObject({
        code: 413,
        message: expect.stringContaining('HTTP 413'),
      });
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });
});

describe('permanent Telegram rejection', () => {
  it('fails a too-large part once instead of retrying it forever', async () => {
    const bad = await makeEnv({
      faults: [{ method: 'sendDocument', status: 413, times: 100, description: 'Request Entity Too Large' }],
    });
    try {
      const data = Buffer.from('this document is rejected');
      const create = await apiFetch(bad.base, bad.cookie, 'POST', '/api/uploads', {
        name: 'too-large.bin',
        size: data.length,
      });
      expect(create.status).toBe(200);
      const upload = (await create.json()) as {
        id: string; fileId: string; parts: { idx: number; sliceCount: number }[];
      };
      const part = upload.parts[0]!;
      for (let s = 0; s < part.sliceCount; s++) {
        const start = s * bad.config.sliceSize;
        const buf = data.subarray(start, Math.min(data.length, start + bad.config.sliceSize));
        const res = await apiFetch(
          bad.base, bad.cookie, 'PUT',
          `/api/uploads/${upload.id}/parts/${part.idx}/slices/${s}`,
          buf,
          { 'content-type': 'application/octet-stream' },
        );
        expect(res.ok).toBe(true);
      }
      const complete = await apiFetch(bad.base, bad.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
      // The queue might already have failed the upload before /complete runs.
      expect([200, 409]).toContain(complete.status);
      await bad.ctx.queue.drain();

      const file = await apiFetch(bad.base, bad.cookie, 'GET', `/api/files/${upload.fileId}`);
      expect(((await file.json()) as { file: { status: string } }).file.status).toBe('failed');
      const partRow = bad.db
        .prepare('SELECT status, attempts, last_error FROM parts WHERE idx = 0')
        .get() as { status: string; attempts: number; last_error: string };
      expect(partRow.status).toBe('failed');
      expect(partRow.attempts).toBeGreaterThanOrEqual(5);
      expect(partRow.last_error).toMatch(/too large/i);
      // Exactly one Telegram attempt: a permanent 413 must not be retried.
      expect(bad.mock.calls.get('sendDocument')).toBe(1);
    } finally {
      await bad.cleanup();
    }
  }, 60_000);
});
