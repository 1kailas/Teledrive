import type { Db } from '../db/index.js';
import type { FileRow, FolderRow } from '../types.js';
import { breadcrumbs, subtreeFolderIds } from '../db/repos/folders.js';

/**
 * Build a safe FTS5 MATCH expression: each whitespace-separated term becomes
 * a double-quoted prefix term ("term"*). Returns null when nothing usable.
 * Strips leading/trailing punctuation so terms like -foo, +bar, c++ don't cause FTS5 syntax errors.
 */
export function ftsQuery(q: string): string | null {
  const terms = q
    .replace(/["'*^:(){}[\]]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().replace(/^[^a-zA-Z0-9_\u00A0-\uFFFF]+|[^a-zA-Z0-9_\u00A0-\uFFFF]+$/g, ''))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

export interface SearchOpts {
  q?: string;
  category?: string;
  minSize?: number;
  maxSize?: number;
  from?: number;
  to?: number;
  folderId?: string;
  starred?: boolean;
  tag?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

const SORT_COLS: Record<string, string> = {
  name: 'f.name COLLATE NOCASE',
  size: 'f.size',
  createdAt: 'f.created_at',
  updatedAt: 'f.updated_at',
  type: 'f.extension COLLATE NOCASE',
};

export function search(db: Db, opts: SearchOpts): { files: (FileRow & { path: string })[]; folders: FolderRow[]; total: number } {
  const executeQuery = (useFtsMatch: boolean) => {
    const where: string[] = [`f.trashed_at IS NULL`, `f.status IN ('ready','processing')`];
    const params: unknown[] = [];

    const q = opts.q?.trim() ?? '';
    const fts = useFtsMatch && q.length >= 2 ? ftsQuery(q) : null;
    if (fts) {
      where.push(`f.rowid IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)`);
      params.push(fts);
    } else if (q.length >= 1) {
      where.push(`(f.name LIKE ? OR f.description LIKE ? OR f.tags LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    if (opts.category) {
      where.push('f.category = ?');
      params.push(opts.category);
    }
    if (opts.minSize != null) {
      where.push('f.size >= ?');
      params.push(opts.minSize);
    }
    if (opts.maxSize != null) {
      where.push('f.size <= ?');
      params.push(opts.maxSize);
    }
    if (opts.from != null) {
      where.push('f.created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to != null) {
      where.push('f.created_at <= ?');
      params.push(opts.to);
    }
    if (opts.starred) {
      where.push('f.starred = 1');
    }
    if (opts.tag) {
      where.push(`(',' || f.tags || ',') LIKE ? ESCAPE '\\'`);
      params.push(`%,${opts.tag.trim().replace(/[\\%_]/g, (c) => `\\${c}`)},%`);
    }
    if (opts.folderId) {
      const ids = subtreeFolderIds(db, opts.folderId);
      where.push(`f.folder_id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ids));
    }

    const whereSql = where.join(' AND ');
    const total = (
      db.prepare(`SELECT COUNT(*) c FROM files f WHERE ${whereSql}`).get(...params) as { c: number }
    ).c;

    const col = SORT_COLS[opts.sort ?? 'name'] ?? 'f.name COLLATE NOCASE';
    const dir = opts.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const files = db
      .prepare(`SELECT f.* FROM files f WHERE ${whereSql} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as FileRow[];

    return { files, total };
  };

  let result: { files: FileRow[]; total: number };
  try {
    result = executeQuery(true);
  } catch {
    // If FTS MATCH fails for any syntax/tokenizer reason, gracefully fall back to LIKE search
    result = executeQuery(false);
  }

  // Memoize breadcrumb paths to prevent N+1 queries for repeated folders
  const pathCache = new Map<string, string>();
  const getPath = (folderId: string | null): string => {
    if (!folderId) return '';
    const cached = pathCache.get(folderId);
    if (cached !== undefined) return cached;
    const p = breadcrumbs(db, folderId).map((b) => b.name).join('/');
    pathCache.set(folderId, p);
    return p;
  };

  const filesWithPath = result.files.map((f) => ({
    ...f,
    path: getPath(f.folder_id),
  }));

  const q = opts.q?.trim() ?? '';
  let folders: FolderRow[] = [];
  if (q.length >= 1) {
    folders = db
      .prepare(
        `SELECT * FROM folders WHERE trashed_at IS NULL AND name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 20`,
      )
      .all(`%${q}%`) as FolderRow[];
  }
  return { files: filesWithPath, folders, total: result.total };
}

export function suggest(db: Db, q: string): string[] {
  const like = `%${q}%`;
  const names = db
    .prepare(
      `SELECT name FROM files WHERE trashed_at IS NULL AND status = 'ready' AND name LIKE ?
       UNION
       SELECT name FROM folders WHERE trashed_at IS NULL AND name LIKE ?
       LIMIT 8`,
    )
    .all(like, like) as { name: string }[];
  return names.map((r) => r.name);
}
