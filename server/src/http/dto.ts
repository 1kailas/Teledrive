import { prep, type Db } from '../db/index.js';
import { childCount } from '../db/repos/folders.js';
import type { FileDTO, FileRow, FolderDTO, FolderRow } from '../types.js';

export function toFileDTO(db: Db, f: FileRow): FileDTO {
  const partCount = f.blob_id
    ? ((prep(db, 'SELECT part_count c FROM blobs WHERE id = ?').get(f.blob_id) as { c: number } | undefined)?.c ?? 0)
    : 0;
  return {
    id: f.id,
    folderId: f.folder_id,
    name: f.name,
    extension: f.extension,
    mimeType: f.mime_type,
    category: f.category,
    size: f.size,
    status: f.status,
    description: f.description,
    tags: f.tags ? f.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    starred: !!f.starred,
    hasThumbnail: !!f.has_thumbnail,
    thumbnailUrl: f.has_thumbnail ? `/api/files/${f.id}/thumbnail?v=${f.updated_at}` : null,
    width: f.width,
    height: f.height,
    duration: f.duration,
    metadata: f.metadata ? (JSON.parse(f.metadata) as Record<string, unknown>) : null,
    takenAt: f.taken_at,
    partCount,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    lastAccessedAt: f.last_accessed_at,
    trashedAt: f.trashed_at,
  };
}

export function toFolderDTO(db: Db, f: FolderRow): FolderDTO {
  return {
    id: f.id,
    parentId: f.parent_id,
    name: f.name,
    color: f.color,
    starred: !!f.starred,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    trashedAt: f.trashed_at,
    childCount: childCount(db, f.id),
  };
}

export function toPublicFileDTO(f: FileRow): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    extension: f.extension,
    size: f.size,
    mimeType: f.mime_type,
    category: f.category,
    hasThumbnail: !!f.has_thumbnail,
    width: f.width,
    height: f.height,
    duration: f.duration,
    description: f.description,
  };
}
