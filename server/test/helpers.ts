import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { createContext } from '../src/bootstrap.js';
import { recoverUploads } from '../src/services/uploads.js';
import { buildApp } from '../src/http/app.js';
import { startMockBotApi, type MockBotApi, type MockFault } from '../src/dev/mockBotApi.js';
import type { AppContext } from '../src/context.js';
import type { FastifyInstance } from 'fastify';

export const TOKEN1 = '1111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const TOKEN2 = '2222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const ADMIN_PASSWORD = 'test-admin-pass';

export interface TestEnv {
  dataDir: string;
  mock: MockBotApi;
  config: AppConfig;
  db: Db;
  ctx: AppContext;
  app: FastifyInstance;
  base: string;
  cookie: string;
  cleanup: () => Promise<void>;
}

export interface MakeEnvOpts {
  tokens?: string[];
  faults?: MockFault[];
  overrides?: Record<string, string>;
  login?: boolean;
}

export function testConfig(dataDir: string, mockPort: number, mockDir: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    TELEGRAM_BOT_API_URL: `http://127.0.0.1:${mockPort}`,
    TELEGRAM_BOT_API_DIR: mockDir,
    TELEGRAM_BOT_TOKENS: `${TOKEN1},${TOKEN2}`,
    TELEGRAM_CHANNEL_ID: '-1001234567890',
    ADMIN_PASSWORD,
    SESSION_SECRET: 's'.repeat(40),
    PART_SIZE_MB: '2',
    UPLOAD_SLICE_SIZE_MB: '0.5',
    TELEGRAM_UPLOAD_CONCURRENCY: '4',
    BOT_MAX_CONCURRENT_UPLOADS: '2',
    CACHE_MAX_GB: '1',
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}

export async function makeEnv(opts: MakeEnvOpts = {}): Promise<TestEnv> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teledrive-test-'));
  const mockDir = path.join(dataDir, 'mock-bot-api');
  const mock = await startMockBotApi({ dir: mockDir, faults: opts.faults ?? [] });
  const overrides = { ...(opts.overrides ?? {}) };
  if (opts.tokens) overrides['TELEGRAM_BOT_TOKENS'] = opts.tokens.join(',');
  const config = testConfig(dataDir, mock.port, mockDir, overrides);
  const db = openDb(config.dataDir);
  const logger = pino({ level: 'silent' });
  const ctx = createContext(config, db, logger);
  await ctx.pool.init();
  recoverUploads(ctx);
  const app = await buildApp(ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  let cookie = '';
  if (opts.login !== false) {
    cookie = await login(base);
  }

  const cleanup = async () => {
    try { app.server.closeAllConnections?.(); } catch {}
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await Promise.race([mock.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    try { db.close(); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };
  return { dataDir, mock, config, db, ctx, app, base, cookie, cleanup };
}

export async function apiFetch(
  base: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    'x-requested-with': 'teledrive',
    ...headers,
  };
  if (cookie) h['cookie'] = cookie;
  let b: string | Buffer | undefined;
  if (body instanceof Buffer) b = body;
  else if (body !== undefined) {
    b = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return fetch(`${base}${path}`, { method, headers: h, body: b as import('undici-types').BodyInit });
}

export async function login(base: string, password = ADMIN_PASSWORD): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0]!;
}

export function sliceCount(partSize: number, sliceSize: number): number {
  return Math.max(1, Math.ceil(partSize / sliceSize));
}

/** Upload a buffer through the slice protocol; returns the FileDTO after completion+ready. */
export async function uploadBytes(
  env: TestEnv,
  data: Buffer,
  opts: { name: string; mimeType?: string; folderId?: string | null; relativePath?: string; onConflict?: string } ,
): Promise<{ fileId: string; uploadId: string; file: Record<string, unknown> }> {
  const create = await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', {
    name: opts.name,
    size: data.length,
    mimeType: opts.mimeType,
    folderId: opts.folderId ?? null,
    relativePath: opts.relativePath,
    onConflict: opts.onConflict,
  });
  if (!create.ok) throw new Error(`create upload failed: ${create.status} ${await create.text()}`);
  const upload = (await create.json()) as {
    id: string;
    fileId: string;
    parts: { idx: number; offset: number; size: number; sliceCount: number }[];
  };

  // send all slices, out of order, concurrently; duplicate one slice
  const jobs: Promise<Response>[] = [];
  let duplicated = false;
  for (const part of upload.parts) {
    const order = [...Array(part.sliceCount).keys()].reverse();
    for (const s of order) {
      const start = part.offset + s * env.config.sliceSize;
      const len = Math.min(env.config.sliceSize, part.offset + part.size - start);
      const buf = data.subarray(start, start + len);
      const send = () =>
        apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${upload.id}/parts/${part.idx}/slices/${s}`, buf, {
          'content-type': 'application/octet-stream',
        });
      jobs.push(send());
      if (!duplicated && s === 0) {
        jobs.push(send());
        duplicated = true;
      }
    }
  }
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (!r.ok) throw new Error(`slice failed: ${r.status} ${await r.text()}`);
  }

  const complete = await apiFetch(env.base, env.cookie, 'POST', `/api/uploads/${upload.id}/complete`);
  if (!complete.ok) throw new Error(`complete failed: ${complete.status} ${await complete.text()}`);

  await env.ctx.queue.drain();
  const file = await waitForReady(env, upload.fileId);
  return { fileId: upload.fileId, uploadId: upload.id, file };
}

export async function waitForReady(env: TestEnv, fileId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const res = await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}`);
    const body = (await res.json()) as { file: { status: string } };
    if (body.file.status === 'ready') return body as unknown as Record<string, unknown>;
    if (body.file.status === 'failed') throw new Error('file failed');
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ready');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function downloadAll(env: TestEnv, fileId: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(`${env.base}/api/files/${fileId}/content`, {
    headers: { cookie: env.cookie, ...headers },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: res.headers };
}
