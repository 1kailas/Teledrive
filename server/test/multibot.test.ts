import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { makeEnv, uploadBytes, downloadAll, apiFetch, TOKEN1, TOKEN2, type TestEnv } from './helpers.js';
import { loadConfig } from '../src/config.js';

const TOKEN3 = '3333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const envs: TestEnv[] = [];
afterAll(async () => {
  for (const e of envs) await e.cleanup();
}, 90_000);

const BASE = {
  TELEGRAM_CHANNEL_ID: '-1001234567890',
  ADMIN_PASSWORD: 'x'.repeat(12),
  SESSION_SECRET: 's'.repeat(40),
};

describe('multi-bot config', () => {
  it('dedupes duplicate tokens (also tolerates whitespace/newline separators) and defaults to auto concurrency', () => {
    const c = loadConfig({ ...BASE, TELEGRAM_BOT_TOKENS: `${TOKEN1},${TOKEN2}\n${TOKEN1} ${TOKEN3}` });
    expect(c.botTokens).toEqual([TOKEN1, TOKEN2, TOKEN3]);
    expect(c.warnings.join(' ')).toContain('duplicate bot 1111111:***');
    expect(c.warnings.join(' ')).not.toContain('AAAA');
    expect(c.telegramUploadConcurrency).toBe(0);
    expect(c.partSize).toBe(512 * 1024 * 1024);
  });
});

describe('multi-bot upload scheduling', () => {
  it('scales upload slots with healthy bots and spreads parts across all of them', async () => {
    const env = await makeEnv({ tokens: [TOKEN1, TOKEN2, TOKEN3], overrides: { TELEGRAM_UPLOAD_CONCURRENCY: '0', BOT_MAX_CONCURRENT_UPLOADS: '1' } });
    envs.push(env);
    expect(env.ctx.pool.effectiveUploadConcurrency()).toBe(3);
    const data = crypto.randomBytes(6 * 1024 * 1024 + 7); // 4 parts at 2 MiB
    const { fileId } = await uploadBytes(env, data, { name: 'spread.bin' });
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string }).blob_id;
    const bots = new Set((env.db.prepare('SELECT bot_id FROM parts WHERE blob_id = ?').all(blobId) as { bot_id: string }[]).map((r) => r.bot_id));
    expect(bots.size).toBe(3);
    expect((await downloadAll(env, fileId)).body.equals(data)).toBe(true);
  }, 60_000);

  it('a rate-limited bot is put on cooldown and the part moves to another bot immediately', async () => {
    // bot 1 answers every sendDocument with a 60s flood-wait
    const env = await makeEnv({ faults: [{ method: 'sendDocument', status: 429, every: 1, retryAfter: 60, botId: '1111111' }] });
    envs.push(env);
    const t0 = Date.now();
    const data = crypto.randomBytes(5 * 1024 * 1024); // 3 parts
    const { fileId } = await uploadBytes(env, data, { name: 'flood.bin' });
    expect(Date.now() - t0).toBeLessThan(15_000); // did not sleep out the 60s flood-wait
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string }).blob_id;
    const rows = env.db.prepare('SELECT bot_id, attempts FROM parts WHERE blob_id = ?').all(blobId) as { bot_id: string; attempts: number }[];
    expect(rows.every((r) => r.bot_id === '2222222')).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true); // switching bots is not a failure
    expect(env.ctx.pool.entry('1111111')!.cooldownUntil).toBeGreaterThan(Date.now());
    const sys = (await (await apiFetch(env.base, env.cookie, 'GET', '/api/system')).json()) as { bots: { botId: string; coolingDownSec: number }[]; uploadSlots: number };
    expect(sys.bots.find((b) => b.botId === '1111111')!.coolingDownSec).toBeGreaterThan(30);
    expect((await downloadAll(env, fileId)).body.equals(data)).toBe(true);
  }, 60_000);

  it('a bot that loses access (401/403) is disabled and remaining bots carry the upload', async () => {
    const env = await makeEnv({ faults: [{ method: 'sendDocument', status: 403, every: 1, botId: '1111111', description: 'Forbidden: bot was kicked from the channel chat' }] });
    envs.push(env);
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const { fileId } = await uploadBytes(env, data, { name: 'kicked.bin' });
    expect(env.ctx.pool.entry('1111111')!.healthy).toBe(false);
    expect(env.ctx.pool.entry('1111111')!.lastError).toContain('kicked');
    expect((await downloadAll(env, fileId)).body.equals(data)).toBe(true);
  }, 60_000);
});

describe('parallel download look-ahead', () => {
  it('a full download fetches upcoming parts concurrently and returns identical bytes', async () => {
    const env = await makeEnv({ tokens: [TOKEN1, TOKEN2, TOKEN3], overrides: { DOWNLOAD_PARALLEL_PARTS: '3' } });
    envs.push(env);
    const data = crypto.randomBytes(8 * 1024 * 1024 + 99); // 5 parts
    const { fileId } = await uploadBytes(env, data, { name: 'parallel.bin' });
    const before = env.mock.calls.get('getFile') ?? 0;
    const res = await downloadAll(env, fileId);
    expect(res.body.equals(data)).toBe(true);
    expect((env.mock.calls.get('getFile') ?? 0) - before).toBeGreaterThanOrEqual(5);
    // every part is now cached locally
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string }).blob_id;
    const cached = (env.db.prepare('SELECT COUNT(*) c FROM part_cache WHERE blob_id = ?').get(blobId) as { c: number }).c;
    expect(cached).toBe(5);
  }, 60_000);
});
