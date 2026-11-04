import { prep, type Db } from '../index.js';
import type { FolderRow } from '../../types.js';

export function getFolder(db: Db, id: string): FolderRow | undefined {
  return prep(db, 'SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
}

export function insertFolder(
  db: Db,
  f: { id: string; parentId: string | null; name: string; color?: string | null },
): FolderRow {
  const now = Date.now();
  db.prepare(
    'INSERT INTO folders (id, parent_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(f.id, f.parentId, f.name, f.color ?? null, now, now);
  return getFolder(db, f.id)!;
}

export function childFolders(db: Db, parentId: string | null, includeTrashed = false): FolderRow[] {
  const trash = includeTrashed ? '' : 'AND trashed_at IS NULL';
  return db
    .prepare(`SELECT * FROM folders WHERE parent_id IS ? ${trash} ORDER BY name COLLATE NOCASE`)
    .all(parentId) as FolderRow[];
}

/** Lower-cased names of non-trashed direct child folders. */
export function childFolderNames(db: Db, parentId: string | null): Set<string> {
  const rows = db
    .prepare('SELECT name FROM folders WHERE parent_id IS ? AND trashed_at IS NULL')
    .all(parentId) as { name: string }[];
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export function breadcrumbs(db: Db, folderId: string | null): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  let cur = folderId;
  let guard = 0;
  while (cur && guard++ < 1000) {
    const f = getFolder(db, cur);
    if (!f) break;
    out.unshift({ id: f.id, name: f.name });
    cur = f.parent_id;
  }
  return out;
}

/** All folder ids in the subtree rooted at folderId, including folderId itself. */
export function subtreeFolderIds(db: Db, folderId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
      ) SELECT id FROM sub`,
    )
    .all(folderId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function isDescendant(db: Db, ancestorId: string, id: string): boolean {
  return subtreeFolderIds(db, ancestorId).includes(id);
}

/** Non-trashed direct children count (folders + ready/processing files). */
export function childCount(db: Db, folderId: string): number {
  return (
    prep(
      db,
      `SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = ? AND trashed_at IS NULL)
            + (SELECT COUNT(*) FROM files WHERE folder_id = ? AND trashed_at IS NULL
               AND status IN ('ready','processing')) c`,
    ).get(folderId, folderId) as { c: number }
  ).c;
}

export interface FolderSize {
  id: string;
  name: string;
  color: string | null;
  size: number;
  files: number;
  folders: number;
}

/**
 * Recursive sizes of the direct child folders of `parentId` (null = root),
 * plus the loose files directly inside it. One query per call.
 */
export function childFolderSizes(db: Db, parentId: string | null): { folders: FolderSize[]; loose: { size: number; files: number } } {
  const folders = prep(
    db,
    `WITH RECURSIVE tree(root, id) AS (
       SELECT id, id FROM folders WHERE parent_id IS ? AND trashed_at IS NULL
       UNION ALL
       SELECT t.root, f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.trashed_at IS NULL
     )
     SELECT r.id, r.name, r.color,
            COALESCE(SUM(fl.size), 0) AS size,
            COUNT(fl.id) AS files,
            (SELECT COUNT(*) - 1 FROM tree t2 WHERE t2.root = r.id) AS folders
     FROM folders r
     JOIN tree t ON t.root = r.id
     LEFT JOIN files fl ON fl.folder_id = t.id AND fl.trashed_at IS NULL AND fl.status = 'ready'
     GROUP BY r.id
     ORDER BY size DESC`,
  ).all(parentId) as FolderSize[];
  const loose = prep(
    db,
    `SELECT COALESCE(SUM(size), 0) size, COUNT(*) files FROM files
     WHERE folder_id IS ? AND trashed_at IS NULL AND status = 'ready'`,
  ).get(parentId) as { size: number; files: number };
  return { folders, loose };
}

export function folderTree(db: Db): { id: string; parentId: string | null; name: string; color: string | null }[] {
  const rows = db
    .prepare('SELECT id, parent_id, name, color FROM folders WHERE trashed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all() as { id: string; parent_id: string | null; name: string; color: string | null }[];
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, color: r.color }));
}

/** Find a non-trashed child folder by (case-insensitive) name. */
export function findChildFolder(db: Db, parentId: string | null, name: string): FolderRow | undefined {
  return db
    .prepare(
      'SELECT * FROM folders WHERE parent_id IS ? AND name = ? COLLATE NOCASE AND trashed_at IS NULL',
    )
    .get(parentId, name) as FolderRow | undefined;
}
