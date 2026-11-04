import { ZipArchive } from 'archiver';
import { Readable } from 'node:stream';
import type { AppContext } from '../context.js';
import { partsByBlob } from '../db/repos/files.js';
import { getFile } from '../db/repos/files.js';
import { getFolder, subtreeFolderIds } from '../db/repos/folders.js';
import { hmacSha256Hex, safeEqual } from '../util.js';
import { createBlobStream } from './streaming.js';
import { badRequest } from '../http/errors.js';
import type { FileRow } from '../types.js';

const ZIP_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface ZipPayload {
  fileIds: string[];
  folderIds: string[];
  exp: number;
}

export function createZipToken(secret: string, fileIds: string[], folderIds: string[]): string {
  const payload: ZipPayload = { fileIds, folderIds, exp: Date.now() + ZIP_TOKEN_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmacSha256Hex(secret, b64);
  return `${b64}.${sig}`;
}

export function verifyZipToken(secret: string, token: string): ZipPayload {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw badRequest('invalid zip token');
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmacSha256Hex(secret, b64))) throw badRequest('invalid zip token');
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString()) as ZipPayload;
  if (!payload.exp || payload.exp < Date.now()) throw badRequest('zip token expired');
  return payload;
}

export interface ZipEntry {
  name: string; // path inside the archive
  file: FileRow;
}

/** Resolve fileIds + folderIds into archive entries preserving folder structure. */
export function collectZipEntries(
  db: import('../db/index.js').Db,
  fileIds: string[],
  folderIds: string[],
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();

  const pathOf = (folderId: string | null): string => {
    const parts: string[] = [];
    let cur = folderId;
    let guard = 0;
    while (cur && guard++ < 1000) {
      const f = getFolder(db, cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parent_id;
    }
    return parts.join('/');
  };

  const addFile = (file: FileRow, basePath: string): void => {
    if (seen.has(file.id)) return;
    if (file.trashed_at || file.status !== 'ready') return;
    seen.add(file.id);
    const name = basePath ? `${basePath}/${file.name}` : file.name;
    entries.push({ name, file });
  };

  for (const id of fileIds) {
    const file = getFile(db, id);
    if (file) addFile(file, pathOf(file.folder_id));
  }

  const addFolderRecursive = (folderId: string, basePath: string): void => {
    const files = db
      .prepare(`SELECT * FROM files WHERE folder_id = ? AND trashed_at IS NULL AND status = 'ready'`)
      .all(folderId) as FileRow[];
    for (const f of files) addFile(f, basePath);
    const subs = db
      .prepare(`SELECT * FROM folders WHERE parent_id = ? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE`)
      .all(folderId) as { id: string; name: string }[];
    for (const s of subs) addFolderRecursive(s.id, basePath ? `${basePath}/${s.name}` : s.name);
  };

  for (const id of folderIds) {
    const folder = getFolder(db, id);
    if (!folder || folder.trashed_at) continue;
    // include subtree; keep full path from root for top-level folders
    const base = pathOf(folder.parent_id);
    addFolderRecursive(id, base ? `${base}/${folder.name}` : folder.name);
  }

  // dedupe archive names
  const usedNames = new Map<string, number>();
  for (const e of entries) {
    const n = usedNames.get(e.name.toLowerCase()) ?? 0;
    usedNames.set(e.name.toLowerCase(), n + 1);
    if (n > 0) {
      const dot = e.name.lastIndexOf('.');
      const slash = e.name.lastIndexOf('/');
      const base = dot > slash ? e.name.slice(0, dot) : e.name;
      const ext = dot > slash ? e.name.slice(dot) : '';
      e.name = `${base} (${n})${ext}`;
    }
  }
  return entries;
}

/** Build a store-only zip stream of the entries. */
export function buildZipStream(ctx: AppContext, entries: ZipEntry[]): Readable {
  const total = entries.reduce((a, e) => a + e.file.size, 0);
  const archive = new ZipArchive({
    store: true,
    forceZip64: total > 4 * 1024 ** 3 || entries.some((e) => e.file.size >= 4 * 1024 ** 3),
    zlib: { level: 0 },
  });
  (async () => {
    for (const entry of entries) {
      const parts = partsByBlob(ctx.db, entry.file.blob_id!);
      const segments = parts.map((p) => ({ part: p, start: 0, end: p.size - 1 }));
      const stream = createBlobStream(ctx.cache, segments, {
        parts,
        prefetchAhead: ctx.config.prefetchNextPart ? Math.max(1, ctx.config.downloadParallelParts - 1) : 0,
        eager: true,
      });
      archive.append(stream, { name: entry.name });
    }
    await archive.finalize();
  })().catch((e) => archive.destroy(e));
  return archive;
}
