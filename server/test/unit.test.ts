import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError, clampPartSizeMb, maxPartSizeMbFor } from '../src/config.js';
import { planParts, sliceCount, sliceLength } from '../src/services/uploads.js';
import { parseRangeHeader, rangeToSegments } from '../src/services/streaming.js';
import { uniqueName, sanitizeFileName, categorize } from '../src/util.js';
import { parsePathMap, toLocal, toRemote } from '../src/telegram/pathMap.js';
import { ftsQuery } from '../src/services/search.js';
import { hashPasswordSync, verifyPassword } from '../src/http/auth.js';
import { createZipToken, verifyZipToken } from '../src/services/zip.js';
import type { PartRow } from '../src/types.js';

const VALID: Record<string, string> = {
  TELEGRAM_BOT_TOKENS: '1111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  TELEGRAM_CHANNEL_ID: '-1001234567890',
  ADMIN_PASSWORD: 'long-enough-password',
  SESSION_SECRET: 'x'.repeat(40),
};

describe('config validation', () => {
  it('accepts a valid config', () => {
    const c = loadConfig(VALID);
    expect(c.partSize).toBe(512 * 1024 * 1024);
    expect(c.botTokens).toHaveLength(1);
  });

  it('supports fractional MB for byte-level test sizes', () => {
    const c = loadConfig({ ...VALID, PART_SIZE_MB: '2', UPLOAD_SLICE_SIZE_MB: '0.5' });
    expect(c.partSize).toBe(2 * 1024 * 1024);
    expect(c.sliceSize).toBe(512 * 1024);
  });

  it('clamps part sizes for the public Bot API but allows large local parts', () => {
    expect(maxPartSizeMbFor('https://api.telegram.org')).toBe(45);
    expect(maxPartSizeMbFor('http://127.0.0.1:8081')).toBe(2000);
    expect(clampPartSizeMb(512, 'https://api.telegram.org')).toBe(45);
    expect(clampPartSizeMb(1, 'http://127.0.0.1:8081')).toBe(5);
    expect(clampPartSizeMb(5000, 'http://127.0.0.1:8081')).toBe(2000);

    const cloud = loadConfig({ ...VALID, TELEGRAM_BOT_API_URL: 'https://api.telegram.org', PART_SIZE_MB: '512' });
    expect(cloud.partSize).toBe(45 * 1024 * 1024);
    expect(cloud.warnings.join(' ')).toContain('45 MB');
  });

  it('fails fast listing all errors', () => {
    try {
      loadConfig({
        TELEGRAM_BOT_TOKENS: 'bogus-token',
        TELEGRAM_CHANNEL_ID: '12345',
        SESSION_SECRET: 'short',
        PART_SIZE_MB: '3000',
      });
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err).toBeInstanceOf(ConfigError);
      const msg = err.message;
      expect(msg).toContain('TELEGRAM_BOT_TOKENS');
      expect(msg).toContain('TELEGRAM_CHANNEL_ID');
      expect(msg).toContain('ADMIN_PASSWORD');
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).toContain('PART_SIZE_MB');
    }
  });
});

describe('part planning', () => {
  const P = 1000;
  it('splits into sizes and offsets', () => {
    const parts = planParts(2500, P);
    expect(parts).toEqual([
      { idx: 0, offset: 0, size: 1000 },
      { idx: 1, offset: 1000, size: 1000 },
      { idx: 2, offset: 2000, size: 500 },
    ]);
  });
  it('exact multiple gives no trailing sliver', () => {
    const parts = planParts(3000, P);
    expect(parts).toHaveLength(3);
    expect(parts[2]!.size).toBe(1000);
  });
  it('zero-byte file has zero parts', () => {
    expect(planParts(0, P)).toEqual([]);
  });
});

describe('slice planning', () => {
  it('computes counts and lengths', () => {
    expect(sliceCount(4, 2)).toBe(2);
    expect(sliceCount(5, 2)).toBe(3);
    expect(sliceLength(5, 2, 0)).toBe(2);
    expect(sliceLength(5, 2, 2)).toBe(1);
    expect(sliceLength(5, 2, 3)).toBe(0);
  });
});

describe('range parsing + segments', () => {
  const parts = [
    { blob_id: 'b', idx: 0, offset: 0, size: 1000 },
    { blob_id: 'b', idx: 1, offset: 1000, size: 1000 },
    { blob_id: 'b', idx: 2, offset: 2000, size: 500 },
  ] as PartRow[];
  const size = 2500;

  it('no header', () => expect(parseRangeHeader(undefined, size)).toBeNull());
  it('open range', () => {
    expect(parseRangeHeader('bytes=100-', size)).toEqual({ start: 100, end: 2499 });
  });
  it('suffix range', () => {
    expect(parseRangeHeader('bytes=-500', size)).toEqual({ start: 2000, end: 2499 });
  });
  it('suffix larger than file', () => {
    expect(parseRangeHeader('bytes=-9999', size)).toEqual({ start: 0, end: 2499 });
  });
  it('out of bounds is invalid (416)', () => {
    expect(parseRangeHeader('bytes=2500-', size)).toBe('invalid');
    expect(parseRangeHeader('bytes=600-200', size)).toBe('invalid');
    expect(parseRangeHeader('garbage', size)).toBe('invalid');
  });
  it('cross-part segments', () => {
    const segs = rangeToSegments(parts, 500, 1500);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: 500, end: 999 });
    expect(segs[1]).toMatchObject({ start: 0, end: 500 });
  });
  it('last byte', () => {
    const segs = rangeToSegments(parts, 2499, 2499);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ start: 499, end: 499 });
  });
});

describe('uniqueName', () => {
  it('appends (1), (2)…', () => {
    const taken = new Set(['name.ext', 'name (1).ext']);
    expect(uniqueName('name.ext', taken)).toBe('name (2).ext');
    expect(uniqueName('free.txt', taken)).toBe('free.txt');
    expect(uniqueName('noext', new Set(['noext']))).toBe('noext (1)');
  });
  it('is case-insensitive', () => {
    expect(uniqueName('NAME.ext', new Set(['name.ext']))).toBe('NAME (1).ext');
  });
});

describe('pathMap', () => {
  it('round-trips remote/local prefixes', () => {
    const m = parsePathMap('/remote=/local')!;
    expect(toRemote(m, '/local/a/b.bin')).toBe('/remote/a/b.bin');
    expect(toLocal(m, '/remote/a/b.bin')).toBe('/local/a/b.bin');
    expect(toRemote(m, '/other/x')).toBe('/other/x');
  });
  it('null map is identity', () => {
    expect(toRemote(null, '/a')).toBe('/a');
    expect(toLocal(null, '/a')).toBe('/a');
  });
});

describe('fts sanitizer', () => {
  it('quotes terms with prefix match', () => {
    expect(ftsQuery('hello world')).toBe('"hello"* "world"*');
  });
  it('strips FTS syntax chars', () => {
    expect(ftsQuery('a"b* (c)')).toBe('"a"* "b"* "c"*');
  });
  it('empty input', () => {
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('"*')).toBeNull();
  });
});

describe('scrypt password', () => {
  it('hash/verify round-trip', async () => {
    const h = hashPasswordSync('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('fails closed on malformed, out-of-range, or absurd hashes', async () => {
    const cases = [
      '',
      'plaintext',
      'scrypt$32768$8$1$c2FsdA==', // missing field
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==', // wrong algorithm
      'scrypt$3$8$1$c2FsdA==$aGFzaA==', // N is not a power of two
      'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==', // N above the cap
      'scrypt$32768$0$1$c2FsdA==$aGFzaA==', // r out of range
      'scrypt$32768$8$0$c2FsdA==$aGFzaA==', // p out of range
      'scrypt$32768$8$1$***$aGFzaA==', // invalid base64 salt
      'scrypt$32768$8$1$c2FsdA==$aA==', // hash too short
    ];
    for (const encoded of cases) {
      await expect(verifyPassword('whatever', encoded)).resolves.toBe(false);
    }
  });
});

describe('zip token HMAC', () => {
  const secret = 's'.repeat(40);
  it('verify ok + wrong secret fails', () => {
    const t = createZipToken(secret, ['a'], ['b']);
    const p = verifyZipToken(secret, t);
    expect(p.fileIds).toEqual(['a']);
    expect(p.folderIds).toEqual(['b']);
    expect(() => verifyZipToken('other-secret-value-that-is-long', t)).toThrow();
  });
  it('expired token fails', () => {
    const t = createZipToken(secret, [], ['f']);
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(() => verifyZipToken(secret, t)).toThrow(/expired/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('sanitizeFileName + categorize', () => {
  it('sanitizes hostile names', () => {
    expect(sanitizeFileName('a/b\\c:d.txt')).toBe('a_b_c_d.txt');
    expect(sanitizeFileName('')).toBe('file');
  });
  it('categorizes', () => {
    expect(categorize('image/png', 'png')).toBe('image');
    expect(categorize('application/octet-stream', 'ts')).toBe('code');
    expect(categorize('application/octet-stream', 'zip')).toBe('archive');
    expect(categorize('application/pdf', 'pdf')).toBe('document');
    expect(categorize('application/octet-stream', 'bin')).toBe('other');
  });
});
