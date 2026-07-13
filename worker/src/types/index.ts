/**
 * TeleDrive Worker — Environment & Type Definitions
 *
 * Central type definitions for the Cloudflare Worker environment bindings
 * and shared interfaces used across all route handlers.
 */

// ============================================
// Cloudflare Bindings
// ============================================

export interface Env {
  /** Cloudflare D1 database binding */
  DB: D1Database;

  /** Telegram Bot Token (set via wrangler secret) */
  TELEGRAM_BOT_TOKEN: string;

  /** Telegram Chat ID — your user ID for Saved Messages */
  TELEGRAM_CHAT_ID: string;

  /** JWT secret key for authentication (optional now) */
  JWT_SECRET: string;

  /** Frontend URL for CORS */
  FRONTEND_URL: string;

  /** Maximum chunk size in bytes (default 45MB) */
  MAX_CHUNK_SIZE: string;

  /** Maximum parallel uploads */
  MAX_PARALLEL_UPLOADS: string;

  /** Current environment */
  ENVIRONMENT: string;
}

// ============================================
// User & Auth
// ============================================

export interface JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
}

// ============================================
// Database Models
// ============================================

export interface DBUser {
  id: string;
  email: string | null;
  telegram_chat_id: string;
  created_at: string;
  updated_at: string;
}

export interface DBFolder {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  is_trashed: number;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBFile {
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
  is_trashed: number;
  trashed_at: string | null;
  is_favorite: number;
  tags: string | null;
  upload_status: 'pending' | 'uploading' | 'complete' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface DBChunk {
  id: string;
  file_id: string;
  chunk_index: number;
  telegram_message_id: string | null;
  telegram_file_id: string | null;
  size: number;
  sha256_hash: string | null;
  upload_status: 'pending' | 'uploading' | 'complete' | 'failed';
  retry_count: number;
  created_at: string;
}

export interface DBUploadSession {
  id: string;
  file_id: string;
  user_id: string;
  total_chunks: number;
  completed_chunks: number;
  status: 'active' | 'paused' | 'complete' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface DBDownloadSession {
  id: string;
  file_id: string;
  user_id: string;
  total_chunks: number;
  completed_chunks: number;
  status: 'active' | 'paused' | 'complete' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface DBFavorite {
  id: string;
  user_id: string;
  file_id: string | null;
  folder_id: string | null;
  created_at: string;
}

export interface DBRecentFile {
  id: string;
  user_id: string;
  file_id: string;
  accessed_at: string;
}

export interface DBSetting {
  id: string;
  user_id: string;
  key: string;
  value: string | null;
}

// ============================================
// API Request / Response Types
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

export interface UploadInitRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
  folderId?: string;
  chunkCount: number;
  sha256Hash?: string;
}

export interface UploadInitResponse {
  fileId: string;
  sessionId: string;
  chunkSize: number;
  totalChunks: number;
}

export interface ChunkUploadResponse {
  chunkIndex: number;
  telegramMessageId: string;
  telegramFileId: string;
  status: string;
}

export interface FileDownloadInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkCount: number;
  chunks: Array<{
    index: number;
    size: number;
    telegramFileId: string;
  }>;
}

// ============================================
// Telegram API Types
// ============================================

export interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramMessage {
  message_id: number;
  document?: TelegramDocument;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ============================================
// Search & Filter Types
// ============================================

export interface SearchParams {
  query?: string;
  extension?: string;
  mimeType?: string;
  minSize?: number;
  maxSize?: number;
  fromDate?: string;
  toDate?: string;
  folderId?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'size' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

export interface StatsResponse {
  totalFiles: number;
  totalFolders: number;
  totalStorage: number;
  largestFiles: DBFile[];
  recentUploads: DBFile[];
  fileTypeDistribution: Record<string, number>;
}
