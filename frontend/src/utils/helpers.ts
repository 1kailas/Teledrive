/**
 * TeleDrive Frontend — Utility Functions
 *
 * File formatting, size conversion, date formatting, etc.
 */

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Format speed (bytes per second) to human-readable string.
 */
export function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + '/s';
}

/**
 * Format seconds to human-readable duration.
 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Format a date string to a localized relative or absolute time.
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Get a color for a file extension.
 */
export function getExtensionColor(ext: string | null): string {
  if (!ext) return '#94a3b8';
  const colors: Record<string, string> = {
    // Images
    jpg: '#f59e0b', jpeg: '#f59e0b', png: '#22c55e', gif: '#a855f7',
    svg: '#ec4899', webp: '#06b6d4', bmp: '#f97316', ico: '#8b5cf6',
    // Videos
    mp4: '#ef4444', mkv: '#ef4444', avi: '#ef4444', mov: '#ef4444',
    wmv: '#ef4444', flv: '#ef4444', webm: '#ef4444',
    // Audio
    mp3: '#8b5cf6', wav: '#8b5cf6', flac: '#8b5cf6', aac: '#8b5cf6',
    ogg: '#8b5cf6', wma: '#8b5cf6',
    // Documents
    pdf: '#ef4444', doc: '#3b82f6', docx: '#3b82f6', xls: '#22c55e',
    xlsx: '#22c55e', ppt: '#f97316', pptx: '#f97316',
    // Code
    js: '#f59e0b', ts: '#3b82f6', jsx: '#06b6d4', tsx: '#06b6d4',
    py: '#22c55e', html: '#ef4444', css: '#8b5cf6', json: '#f59e0b',
    // Archives
    zip: '#6366f1', rar: '#6366f1', '7z': '#6366f1', tar: '#6366f1',
    gz: '#6366f1',
    // Text
    txt: '#94a3b8', md: '#94a3b8', csv: '#22c55e', log: '#94a3b8',
  };
  return colors[ext.toLowerCase()] || '#94a3b8';
}

/**
 * Get a file type category from MIME type or extension.
 */
export function getFileCategory(mimeType: string | null, ext: string | null): string {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.startsWith('text/')) return 'text';
  }
  if (ext) {
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'];
    const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
    const codeExts = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'h', 'go', 'rs', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat'];
    const textExts = ['txt', 'md', 'csv', 'log', 'ini', 'cfg', 'env'];

    const e = ext.toLowerCase();
    if (imageExts.includes(e)) return 'image';
    if (videoExts.includes(e)) return 'video';
    if (audioExts.includes(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (codeExts.includes(e)) return 'code';
    if (textExts.includes(e)) return 'text';
  }
  return 'file';
}

/**
 * Generate a unique ID.
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Chunk size constant (45 MB).
 */
export const CHUNK_SIZE = 45 * 1024 * 1024;

/**
 * Compute SHA-256 hash of an ArrayBuffer.
 */
export async function sha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
