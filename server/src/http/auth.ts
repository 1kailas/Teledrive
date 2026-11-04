import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  createSession,
  deleteSession,
  getSetting,
  sessionByTokenHash,
  touchSession,
} from '../db/repos/misc.js';
import type { SessionRow } from '../types.js';
import { safeEqual, sha256Hex } from '../util.js';

// scrypt parameters: N=2^15 needs ~32 MiB; give maxmem headroom.
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEYLEN = 64;

const scryptP = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Async (non-blocking) scrypt hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptP(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Sync variant kept for tests and contexts where sync is fine. */
export function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = await scryptP(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Verify a login/change attempt against settings hash -> env hash -> env plain. */
export async function verifyAdminPassword(
  db: Db,
  config: { adminPassword: string; adminPasswordHash: string },
  password: string,
): Promise<boolean> {
  const stored = getSetting(db, 'password_hash');
  if (stored) return verifyPassword(password, stored);
  if (config.adminPasswordHash) return verifyPassword(password, config.adminPasswordHash);
  // constant-time compare on sha256 digests so lengths always match
  return safeEqual(sha256Hex(password), sha256Hex(config.adminPassword));
}

export function newSession(ctx: AppContext, ip?: string, userAgent?: string): { sessionId: string; token: string } {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  createSession(ctx.db, {
    id,
    tokenHash: sha256Hex(token),
    expiresAt: Date.now() + ctx.config.sessionTtlMs,
    ip,
    userAgent,
  });
  return { sessionId: id, token };
}

export function sessionFromToken(ctx: AppContext, token: string | undefined): SessionRow | null {
  if (!token) return null;
  const row = sessionByTokenHash(ctx.db, sha256Hex(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(ctx.db, row.id);
    return null;
  }
  touchSession(ctx.db, row.id, Date.now());
  return row;
}
