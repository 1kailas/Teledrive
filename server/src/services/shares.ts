import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { getFile } from '../db/repos/files.js';
import { getFolder, subtreeFolderIds } from '../db/repos/folders.js';
import { getShareByToken } from '../db/repos/shares.js';
import type { ShareRow } from '../types.js';
import { hmacSha256Hex, safeEqual } from '../util.js';
import { gone, notFound } from '../http/errors.js';
import { hashPassword, verifyPassword } from '../http/auth.js';

export type ShareStatus = 'active' | 'expired' | 'exhausted' | 'revoked';

export function shareStatus(share: ShareRow, now = Date.now()): ShareStatus {
  if (share.revoked_at) return 'revoked';
  if (share.expires_at && share.expires_at < now) return 'expired';
  if (share.max_downloads != null && share.download_count >= share.max_downloads) return 'exhausted';
  return 'active';
}

/** Resolve a share token or throw 404/410. */
export function requireActiveShare(ctx: AppContext, token: string): ShareRow {
  const share = getShareByToken(ctx.db, token);
  if (!share) throw notFound('share not found');
  const status = shareStatus(share);
  if (status === 'revoked') throw gone('share revoked');
  if (status === 'expired') throw gone('share expired');
  if (status === 'exhausted') throw gone('download limit reached');
  return share;
}

export async function createShare(
  ctx: AppContext,
  input: {
    fileId?: string;
    folderId?: string;
    password?: string;
    expiresAt?: number;
    maxDownloads?: number;
    allowDownload?: boolean;
  },
): Promise<ShareRow> {
  const { db } = ctx;
  if (!input.fileId && !input.folderId) throw notFound('fileId or folderId required');
  if (input.fileId) {
    const f = getFile(db, input.fileId);
    if (!f || f.trashed_at) throw notFound('file not found');
  } else {
    const f = getFolder(db, input.folderId!);
    if (!f || f.trashed_at) throw notFound('folder not found');
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare(
    `INSERT INTO shares (id, token, file_id, folder_id, password_hash, expires_at, max_downloads, allow_download, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    token,
    input.fileId ?? null,
    input.folderId ?? null,
    input.password ? await hashPassword(input.password) : null,
    input.expiresAt ?? null,
    input.maxDownloads ?? null,
    input.allowDownload === false ? 0 : 1,
    Date.now(),
  );
  return getShareByToken(db, token)!;
}

// ---- public access ----

export function shareUnlockCookie(share: ShareRow): string {
  return `td_share_${share.id}`;
}

export function shareCookieValue(secret: string, share: ShareRow): string {
  return hmacSha256Hex(secret, `${share.id}:${share.password_hash}`);
}

export function isShareUnlocked(ctx: AppContext, share: ShareRow, cookieValue: string | undefined): boolean {
  if (!share.password_hash) return true;
  if (!cookieValue) return false;
  return safeEqual(cookieValue, shareCookieValue(ctx.config.sessionSecret, share));
}

export function verifySharePassword(share: ShareRow, password: string): Promise<boolean> {
  if (!share.password_hash) return Promise.resolve(false);
  return verifyPassword(password, share.password_hash);
}

/** Verify a folder is inside a folder share's subtree (or is the root). */
export function folderInShare(db: import('../db/index.js').Db, share: ShareRow, folderId: string): boolean {
  if (!share.folder_id) return false;
  if (folderId === share.folder_id) return true;
  return subtreeFolderIds(db, share.folder_id).includes(folderId);
}

/** Verify a file is inside the share: file share = exact match; folder share = subtree. */
export function fileInShare(db: import('../db/index.js').Db, share: ShareRow, fileId: string): boolean {
  const file = getFile(db, fileId);
  if (!file || file.trashed_at) return false;
  if (share.file_id) return share.file_id === fileId;
  if (!share.folder_id) return false;
  if (!file.folder_id) return false;
  return folderInShare(db, share, file.folder_id);
}

export function shareTokenHmac(secret: string, payloadB64: string): string {
  return hmacSha256Hex(secret, payloadB64);
}
