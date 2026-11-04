// API client + DTO types mirroring the server.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? { 'x-requested-with': 'teledrive' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let code = 'ERROR', message = res.statusText, details: unknown;
    try {
      const j = await res.json();
      code = j?.error?.code ?? code;
      message = j?.error?.message ?? message;
      details = j?.error?.details;
    } catch { /* */ }
    if (res.status === 401 && !location.pathname.startsWith('/s/')) {
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(res.status, code, message, details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const get = <T>(p: string) => req<T>('GET', p);
export const post = <T>(p: string, b?: unknown) => req<T>('POST', p, b);
export const patch = <T>(p: string, b?: unknown) => req<T>('PATCH', p, b);
export const del = <T>(p: string) => req<T>('DELETE', p);

export interface FileDTO {
  id: string; folderId: string | null; name: string; extension: string; mimeType: string;
  category: string; size: number; status: string; description: string; tags: string[];
  starred: boolean; hasThumbnail: boolean; thumbnailUrl: string | null;
  width: number | null; height: number | null; duration: number | null;
  metadata: Record<string, unknown> | null; takenAt: number | null; partCount: number;
  createdAt: number; updatedAt: number; lastAccessedAt: number | null; trashedAt: number | null;
}
export interface FolderDTO {
  id: string; parentId: string | null; name: string; color: string | null;
  starred: boolean; createdAt: number; updatedAt: number; trashedAt: number | null; childCount: number;
}
export interface DriveResponse {
  folder: FolderDTO | null; breadcrumbs: { id: string; name: string }[];
  folders: FolderDTO[]; files: FileDTO[]; totalFiles: number;
}
export interface UploadPartDTO { idx: number; offset: number; size: number; sliceCount: number; status: string; receivedSlices: number[] }
export interface UploadDTO { id: string; fileId: string; name: string; size: number; partSize: number; sliceSize: number; status: string; parts: UploadPartDTO[] }
export interface UploadListItem { id: string; fileId: string; name: string; size: number; status: string; clientKey: string; progress: { partsReceived: number; partsTotal: number; slicesReceived: number; slicesTotal: number }; createdAt: number; expiresAt: number }
export interface ShareDTO { id: string; token: string; url: string; fileId: string | null; folderId: string | null; itemName: string | null; itemType: 'file' | 'folder'; status: string; requiresPassword: boolean; expiresAt: number | null; maxDownloads: number | null; downloadCount: number; viewCount: number; allowDownload: boolean; createdAt: number; revokedAt: number | null }
export interface Config { version: string; partSize: number; effectivePartSizeMb: number; partSizeMaxMb: number; isLocalBotApi: boolean; isLocalStorage?: boolean; storageMode?: 'telegram'; sliceSize: number; uploadConcurrency: number; telegramUploadConcurrency: number; botMaxConcurrentUploads: number; maxFileSize: number; trashRetentionDays: number; features: { ffmpeg: boolean; pdf: boolean; localVault?: boolean } }
export interface SystemInfo { version: string; uptimeSec: number; botApi: { url: string; reachable: boolean; latencyMs: number | null; error?: string | null }; channel: { id: string; title: string | null }; bots: { botId: string; username: string | null; healthy: boolean; lastError: string | null; inFlight: number }[]; disk: { dataDir: string; used?: number; free: number; total: number }; cache: { usedBytes: number; maxBytes: number; files: number }; tools: { ffmpeg: boolean; ffprobe: boolean; pdftoppm: boolean }; queue: { receivedParts: number; uploadingParts: number; failedParts: number; pendingDeletions: number }; lastBackup: { fileName: string; createdAt: number; size: number } | null }
export interface Stats { totalSize: number; fileCount: number; folderCount: number; trashSize: number; trashCount: number; byCategory: { category: string; count: number; size: number }[]; uploadsByDay: { day: string; count: number; size: number }[]; largestFiles: FileDTO[]; bots: { botId: string; username: string | null; healthy: boolean; partsUploaded: number; bytesUploaded: number }[] }
export interface PublicShareInfo { type: 'file' | 'folder'; name: string | null; requiresPassword: boolean; unlocked: boolean; expiresAt: number | null; allowDownload: boolean; file?: { id: string; name: string; extension: string; size: number; mimeType: string; category: string; hasThumbnail: boolean; width: number | null; height: number | null; duration: number | null; description: string }; folder?: { id: string; name: string } }
export interface PublicFolderListing { folder: { id: string; name: string }; breadcrumbs: { id: string; name: string }[]; folders: { id: string; name: string }[]; files: PublicShareInfo['file'][]; allowDownload: boolean }
export interface TreeFolder { id: string; parentId: string | null; name: string; color: string | null }
export interface Backup { id: number | string; messageId: number | null; botId: string | null; fileName: string; size: number; createdAt: number }
export interface SessionInfo { id: string; createdAt: number; lastSeenAt: number; expiresAt: number; ip: string | null; userAgent: string | null; current: boolean }
export interface ActivityItem { id: number; action: string; itemType: string | null; itemId: string | null; itemName: string | null; details: unknown; createdAt: number }
export interface SearchResult { files: (FileDTO & { path: string })[]; folders: FolderDTO[]; total: number }

export type PartPhase = 'hashing' | 'media' | 'waiting-bot' | 'sending';
export interface UploadProgressPart {
  idx: number; size: number; status: string; phase: PartPhase | null; startedAt: number | null;
  queuePosition: number; botId: string | null; botUsername: string | null; estRate: number | null;
  attempts: number; lastError: string | null; nextAttemptAt: number | null;
}
export interface UploadProgress { id: string; fileId: string; status: string; fileStatus: string | null; serverNow: number; parts: UploadProgressPart[] }

export interface StoragePart {
  idx: number; offset: number; size: number; status: string; sha256: string | null;
  botId: string | null; botUsername: string | null; messageId: number | null; cached: boolean;
  fetching: { startedAt: number; estRate: number | null } | null;
}
export interface FileStorage {
  fileId: string; size: number; contentHash: string | null; verifiedAt: number | null;
  partSize: number | null; references: number; serverNow: number; parts: StoragePart[];
}
export interface VerifyResult { ok: boolean; checkedAt: number; parts: { idx: number; ok: boolean; expected: string | null; actual: string | null; error?: string }[] }
export interface DuplicateGroup { contentHash: string; size: number; storedCopies: number; wastedBytes: number; files: (FileDTO & { path: string })[] }
export interface FolderSize { id: string; name: string; color: string | null; size: number; files: number; folders: number }
export interface FolderSizes { parentId: string | null; breadcrumbs: { id: string; name: string }[]; folders: FolderSize[]; loose: { size: number; files: number } }
export interface VaultIssue { fileId: string; name: string; partIndex: number; problem: 'missing' | 'size' | 'invalid' | string; expected: number; actual: number }
export interface VaultVerification {
  ok: boolean; checkedAt: number; checkedFiles: number; checkedParts: number; remoteParts: number;
  missingParts: number; sizeMismatches: number; orphanFiles: number; orphanBytes: number;
  totalLocalBytes: number; issues: VaultIssue[];
}

export const api = { get, post, patch, del };
