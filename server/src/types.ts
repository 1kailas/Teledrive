export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  starred: number;
  trashed_at: number | null;
  trash_root: number;
  created_at: number;
  updated_at: number;
}

export interface BlobRow {
  id: string;
  size: number;
  part_size: number;
  part_count: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  created_at: number;
  content_hash: string | null;
  verified_at: number | null;
}

export interface PartRow {
  blob_id: string;
  idx: number;
  offset: number;
  size: number;
  sha256: string | null;
  status: 'pending' | 'received' | 'uploading' | 'stored' | 'failed';
  bot_id: string | null;
  message_id: number | null;
  tg_file_id: string | null;
  tg_file_unique_id: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
}

export interface FileRow {
  id: string;
  folder_id: string | null;
  blob_id: string | null;
  name: string;
  extension: string;
  mime_type: string;
  category: string;
  size: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  description: string;
  tags: string;
  starred: number;
  has_thumbnail: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  metadata: string | null;
  taken_at: number | null;
  trashed_at: number | null;
  trash_root: number;
  last_accessed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UploadRow {
  id: string;
  file_id: string;
  blob_id: string;
  slice_size: number;
  client_key: string | null;
  on_conflict: string;
  target_name: string | null;
  part_basename: string;
  status: 'active' | 'processing' | 'complete' | 'failed' | 'cancelled';
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface ShareRow {
  id: string;
  token: string;
  file_id: string | null;
  folder_id: string | null;
  password_hash: string | null;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  view_count: number;
  allow_download: number;
  created_at: number;
  revoked_at: number | null;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface BotRow {
  bot_id: string;
  username: string | null;
  first_name: string | null;
  healthy: number;
  last_error: string | null;
  last_checked_at: number | null;
  parts_uploaded: number;
  bytes_uploaded: number;
}

export interface BackupRow {
  id: number;
  message_id: number | null;
  bot_id: string | null;
  file_name: string;
  size: number;
  created_at: number;
}

export interface FileDTO {
  id: string;
  folderId: string | null;
  name: string;
  extension: string;
  mimeType: string;
  category: string;
  size: number;
  status: string;
  description: string;
  tags: string[];
  starred: boolean;
  hasThumbnail: boolean;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  metadata: Record<string, unknown> | null;
  takenAt: number | null;
  partCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  trashedAt: number | null;
}

export interface FolderDTO {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  childCount: number;
}

export interface UploadPartDTO {
  idx: number;
  offset: number;
  size: number;
  sliceCount: number;
  status: string;
  receivedSlices: number[];
}

export interface UploadDTO {
  id: string;
  fileId: string;
  name: string;
  size: number;
  partSize: number;
  sliceSize: number;
  status: string;
  parts: UploadPartDTO[];
}
