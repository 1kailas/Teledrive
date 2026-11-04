import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { makeEnv, uploadBytes, downloadAll, apiFetch, type TestEnv } from './helpers.js';
import { backfillContentHashes, contentHashFor } from '../src/services/blobs.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
}, 90_000);
afterAll(async () => {
  await env?.cleanup();
}, 90_000);

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

interface StorageDTO {
  contentHash: string | null;
  verifiedAt: number | null;
  references: number;
  parts: { idx: number; size: number; sha256: string | null; botUsername: string | null; messageId: number | null; cached: boolean; fetching: unknown }[];
}

/** Minimal PCM WAV: `seconds` of silence, 8 kHz mono 16-bit. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('content fingerprint + duplicates', () => {
  it('identical uploads share a content hash; in-app copies cost nothing', async () => {
    const data = crypto.randomBytes(300 * 1024);
    const a = await uploadBytes(env, data, { name: 'dup-a.bin' });
    const b = await uploadBytes(env, data, { name: 'dup-b.bin' });
    const sa = await json<StorageDTO>(await apiFetch(env.base, env.cookie, 'GET', `/api/files/${a.fileId}/storage`));
    const sb = await json<StorageDTO>(await apiFetch(env.base, env.cookie, 'GET', `/api/files/${b.fileId}/storage`));
    expect(sa.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sa.contentHash).toBe(sb.contentHash);
    expect(sa.contentHash).toBe(contentHashFor(data.length, sa.parts.map((p) => p.sha256)));

    await json(await apiFetch(env.base, env.cookie, 'POST', `/api/files/${a.fileId}/copy`, {}));
    const dups = await json<{ wastedBytes: number; groups: { contentHash: string; storedCopies: number; wastedBytes: number; files: { id: string; path: string }[] }[] }>(
      await apiFetch(env.base, env.cookie, 'GET', '/api/duplicates'),
    );
    const g = dups.groups.find((x) => x.contentHash === sa.contentHash)!;
    expect(g.files).toHaveLength(3);
    expect(g.storedCopies).toBe(2); // the copy shares a's blob
    expect(g.wastedBytes).toBe(data.length);
    expect(dups.wastedBytes).toBeGreaterThanOrEqual(data.length);
  }, 60_000);

  it('backfills hashes for blobs created before the migration', async () => {
    const { fileId } = await uploadBytes(env, crypto.randomBytes(1000), { name: 'legacy.bin' });
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string }).blob_id;
    const before = (env.db.prepare('SELECT content_hash FROM blobs WHERE id = ?').get(blobId) as { content_hash: string }).content_hash;
    env.db.prepare('UPDATE blobs SET content_hash = NULL WHERE id = ?').run(blobId);
    expect(backfillContentHashes(env.db)).toBeGreaterThanOrEqual(1);
    const after = (env.db.prepare('SELECT content_hash FROM blobs WHERE id = ?').get(blobId) as { content_hash: string }).content_hash;
    expect(after).toBe(before);
  }, 30_000);
});

describe('storage, prefetch and integrity verification', () => {
  it('reports parts/bots/cache state, prefetches, verifies and detects corruption', async () => {
    const data = crypto.randomBytes(5 * 1024 * 1024 + 123); // 3 parts at 2 MiB
    const { fileId } = await uploadBytes(env, data, { name: 'big.bin' });

    let st = await json<StorageDTO>(await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}/storage`));
    expect(st.parts).toHaveLength(3);
    expect(st.references).toBe(1);
    for (const p of st.parts) {
      expect(p.messageId).toBeGreaterThan(0);
      expect(p.botUsername).toMatch(/^mock\d+_bot$/);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.cached).toBe(false);
    }

    const pre = await apiFetch(env.base, env.cookie, 'POST', `/api/files/${fileId}/prefetch`);
    expect(pre.status).toBe(202);
    expect(((await pre.json()) as { queued: number }).queued).toBe(3);
    for (let i = 0; i < 100; i++) {
      st = await json<StorageDTO>(await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}/storage`));
      if (st.parts.every((p) => p.cached)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(st.parts.every((p) => p.cached)).toBe(true);

    const ok = await json<{ ok: boolean; parts: { ok: boolean }[] }>(
      await apiFetch(env.base, env.cookie, 'POST', `/api/files/${fileId}/verify`),
    );
    expect(ok.ok).toBe(true);
    expect(ok.parts.every((p) => p.ok)).toBe(true);
    st = await json<StorageDTO>(await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}/storage`));
    expect(st.verifiedAt).toBeGreaterThan(0);

    // corrupt part 1 on disk (same size) -> verification must flag exactly that part
    const blobId = (env.db.prepare('SELECT blob_id FROM files WHERE id = ?').get(fileId) as { blob_id: string }).blob_id;
    const local = (env.db.prepare('SELECT local_path FROM part_cache WHERE blob_id = ? AND idx = 1').get(blobId) as { local_path: string }).local_path;
    const fd = fs.openSync(local, 'r+');
    fs.writeSync(fd, Buffer.from('CORRUPTED'), 0, 9, 100);
    fs.closeSync(fd);
    const bad = await json<{ ok: boolean; parts: { idx: number; ok: boolean }[] }>(
      await apiFetch(env.base, env.cookie, 'POST', `/api/files/${fileId}/verify`),
    );
    expect(bad.ok).toBe(false);
    expect(bad.parts.filter((p) => !p.ok).map((p) => p.idx)).toEqual([1]);
  }, 60_000);
});

describe('upload progress endpoint', () => {
  it('reports per-part pipeline state', async () => {
    const data = crypto.randomBytes(3 * 1024 * 1024); // 2 parts
    const create = await json<{ id: string; parts: { idx: number; offset: number; size: number; sliceCount: number }[] }>(
      await apiFetch(env.base, env.cookie, 'POST', '/api/uploads', { name: 'progress.bin', size: data.length }),
    );
    let prog = await json<{ status: string; serverNow: number; parts: { idx: number; status: string; phase: string | null }[] }>(
      await apiFetch(env.base, env.cookie, 'GET', `/api/uploads/${create.id}/progress`),
    );
    expect(prog.status).toBe('active');
    expect(prog.serverNow).toBeGreaterThan(0);
    expect(prog.parts.map((p) => p.status)).toEqual(['pending', 'pending']);

    // send only part 0
    const p0 = create.parts[0]!;
    for (let s = 0; s < p0.sliceCount; s++) {
      const start = p0.offset + s * env.config.sliceSize;
      const buf = data.subarray(start, Math.min(start + env.config.sliceSize, p0.offset + p0.size));
      await json(await apiFetch(env.base, env.cookie, 'PUT', `/api/uploads/${create.id}/parts/0/slices/${s}`, buf, { 'content-type': 'application/octet-stream' }));
    }
    await env.ctx.queue.drain();
    prog = await json(await apiFetch(env.base, env.cookie, 'GET', `/api/uploads/${create.id}/progress`));
    expect(prog.parts[0]!.status).toBe('stored');
    expect(prog.parts[0]!.phase).toBeNull();
    expect(prog.parts[1]!.status).toBe('pending');
    await apiFetch(env.base, env.cookie, 'DELETE', `/api/uploads/${create.id}`);
  }, 60_000);
});

describe('storage analyzer + tags', () => {
  it('computes recursive folder sizes and whole-tag search', async () => {
    const { folder: top } = await json<{ folder: { id: string } }>(await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'Analyzer' }));
    const { folder: sub } = await json<{ folder: { id: string } }>(await apiFetch(env.base, env.cookie, 'POST', '/api/folders', { name: 'Inner', parentId: top.id }));
    const f1 = await uploadBytes(env, crypto.randomBytes(1000), { name: 'one.bin', folderId: top.id });
    await uploadBytes(env, crypto.randomBytes(2000), { name: 'two.bin', folderId: sub.id });

    const root = await json<{ folders: { id: string; size: number; files: number; folders: number }[] }>(
      await apiFetch(env.base, env.cookie, 'GET', '/api/storage/folders'),
    );
    const a = root.folders.find((f) => f.id === top.id)!;
    expect(a).toMatchObject({ size: 3000, files: 2, folders: 1 });

    const inner = await json<{ folders: { id: string; size: number }[]; loose: { size: number; files: number }; breadcrumbs: { id: string }[] }>(
      await apiFetch(env.base, env.cookie, 'GET', `/api/storage/folders?parentId=${top.id}`),
    );
    expect(inner.folders).toEqual([expect.objectContaining({ id: sub.id, size: 2000 })]);
    expect(inner.loose).toEqual({ size: 1000, files: 1 });
    expect(inner.breadcrumbs.map((b) => b.id)).toEqual([top.id]);

    await json(await apiFetch(env.base, env.cookie, 'PATCH', `/api/files/${f1.fileId}`, { tags: ['holiday', 'foo_bar'] }));
    const tags = await json<{ tags: { tag: string; count: number }[] }>(await apiFetch(env.base, env.cookie, 'GET', '/api/tags'));
    expect(tags.tags).toEqual(expect.arrayContaining([{ tag: 'holiday', count: 1 }, { tag: 'foo_bar', count: 1 }]));

    const hit = await json<{ files: { id: string }[] }>(await apiFetch(env.base, env.cookie, 'GET', '/api/search?tag=holiday'));
    expect(hit.files.map((f) => f.id)).toEqual([f1.fileId]);
    // partial tags and LIKE wildcards must not match
    const miss = await json<{ files: unknown[] }>(await apiFetch(env.base, env.cookie, 'GET', '/api/search?tag=holi'));
    expect(miss.files).toHaveLength(0);
    const wild = await json<{ files: unknown[] }>(await apiFetch(env.base, env.cookie, 'GET', '/api/search?tag=foo%25'));
    expect(wild.files).toHaveLength(0);
  }, 60_000);
});

describe('built-in media metadata (no ffprobe)', () => {
  it('extracts audio duration and format from a WAV file', async () => {
    const { fileId } = await uploadBytes(env, wav(2), { name: 'tone.wav', mimeType: 'audio/wav' });
    const res = await json<{ file: { duration: number | null; metadata: Record<string, unknown> | null } }>(
      await apiFetch(env.base, env.cookie, 'GET', `/api/files/${fileId}`),
    );
    expect(res.file.duration).toBeCloseTo(2, 1);
    expect(res.file.metadata).toMatchObject({ sampleRate: 8000, channels: 1 });
    const dl = await downloadAll(env, fileId);
    expect(dl.status).toBe(200);
  }, 60_000);
});
