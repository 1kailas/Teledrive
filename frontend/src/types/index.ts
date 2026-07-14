/**
 * TeleDrive Frontend — Shared Type Definitions
 */

// ============================================
// File & Folder Types
// ============================================

export interface TDFile {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size: number;
  chunk_count: number;
  sha256_hash: string | null;
  thumbnail_msg_id: string | null;
  description: string | null;
  is_trashed: number;
  trashed_at: string | null;
  is_favorite: number;
  tags: string | null;
  upload_status: 'pending' | 'uploading' | 'complete' | 'failed';
  created_at: string;
  updated_at: string;
  // Search result extras
  name_highlighted?: string;
}

export interface TDFolder {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  is_trashed: number;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Breadcrumb {
  id: string;
  name: string;
}

// ============================================
// Upload Types
// ============================================

export interface UploadTask {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  folderId: string | null;
  status: 'queued' | 'hashing' | 'uploading' | 'paused' | 'complete' | 'failed' | 'cancelled';
  progress: number; // 0-100
  speed: number; // bytes per second
  eta: number; // seconds remaining
  uploadedBytes: number;
  totalChunks: number;
  completedChunks: number;
  sessionId: string | null;
  fileId: string | null;
  error: string | null;
  startedAt: number | null;
}

export interface DownloadTask {
  id: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: 'queued' | 'downloading' | 'paused' | 'assembling' | 'complete' | 'failed';
  progress: number;
  speed: number;
  eta: number;
  downloadedBytes: number;
  totalChunks: number;
  completedChunks: number;
  error: string | null;
}

export interface ChunkInfo {
  index: number;
  size: number;
  telegramFileId: string;
  sha256Hash?: string;
}

// ============================================
// Sharing Types
// ============================================

export interface ShareLink {
  id: string;
  file_id: string;
  user_id: string;
  token: string;
  password_hash: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  is_active: number;
  created_at: string;
  // Joined fields
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  extension?: string;
}

// ============================================
// Preview Types
// ============================================

export interface PreviewInfo {
  fileId: string;
  fileName: string;
  mimeType: string | null;
  size: number;
  previewType: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';
  canPreview: boolean;
  hasThumbnail: boolean;
}

// ============================================
// Search Types
// ============================================

export interface SearchSuggestion {
  text: string;
  type: 'file' | 'folder';
  extension: string | null;
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface StatsData {
  totalFiles: number;
  totalFolders: number;
  totalStorage: number;
  largestFiles: TDFile[];
  recentUploads: TDFile[];
  recentDownloads: TDFile[];
  fileTypeDistribution: Array<{
    extension: string;
    count: number;
    total_size: number;
  }>;
  largestFolders: Array<{
    id: string;
    name: string;
    total_size: number;
    file_count: number;
  }>;
}

export interface DownloadInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256Hash: string | null;
  chunkCount: number;
  chunks: ChunkInfo[];
}

// ============================================
// Auth Types
// ============================================

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
}

// ============================================
// Settings
// ============================================

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  viewMode: 'grid' | 'list';
  chunkSize: number;
  maxParallelUploads: number;
  [key: string]: string | number;
}

// ============================================
// UI State Types
// ============================================

export type ViewMode = 'grid' | 'list';
export type SortField = 'name' | 'size' | 'created_at' | 'updated_at' | 'extension';
export type SortOrder = 'asc' | 'desc';

export interface SortConfig {
  field: SortField;
  order: SortOrder;
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  item: TDFile | TDFolder | null;
  type: 'file' | 'folder' | null;
}

// ============================================
// Toast Types
// ============================================

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number; // ms, default 4000
}

// ============================================
// Helpers
// ============================================

export function isFile(item: TDFile | TDFolder): item is TDFile {
  return 'mime_type' in item;
}

export function isFolder(item: TDFile | TDFolder): item is TDFolder {
  return !('mime_type' in item);
}
