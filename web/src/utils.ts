import { Image, Video, Music, FileText, Archive, FileCode, File as FileIcon, Folder } from 'lucide-react';
import type { FileDTO, FolderDTO } from './api';

export function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10));
  return `${(n / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
export function fmtDate(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = Date.now();
  if (now - ms < 86400_000 && d.getDate() === new Date().getDate())
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function fmtDuration(s: number | null): string {
  if (s == null) return '';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export const CATEGORY_COLORS: Record<string, string> = {
  image: '#10b981', video: '#f59e0b', audio: '#8b5cf6', document: '#3b82f6',
  archive: '#a16207', code: '#0ea5e9', other: '#6b7280',
};

/** Relative storage usage per category (Telegram storage has no quota). */
export function categoryUsage(byCategory: { category: string; size: number }[]): { category: string; size: number; percent: number }[] {
  const total = byCategory.reduce((sum, item) => sum + Math.max(0, item.size), 0);
  if (total <= 0) return [];
  return byCategory
    .filter((item) => item.size > 0)
    .map((item) => ({ category: item.category, size: item.size, percent: (item.size / total) * 100 }))
    .sort((a, b) => b.size - a.size);
}
function parseVttTimestamp(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function vttTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}

/** Shift every cue window in a WebVTT file, keeping cue settings intact. */
export function shiftVttTimings(vtt: string, offsetSeconds: number): string {
  if (!offsetSeconds) return vtt;
  return vtt.replace(
    /^((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}\.\d{3})/gm,
    (match, start: string, end: string) => {
      const startTime = parseVttTimestamp(start);
      const endTime = parseVttTimestamp(end);
      if (startTime === null || endTime === null) return match;
      return `${vttTimestamp(startTime + offsetSeconds)} --> ${vttTimestamp(endTime + offsetSeconds)}`;
    },
  );
}

/** True when a keystroke belongs to a form field or rich-text editor. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

export const CATEGORY_LABELS: Record<string, string> = {
  image: 'Images', video: 'Videos', audio: 'Audio', document: 'Documents',
  archive: 'Archives', code: 'Code', other: 'Other',
};
export function categoryIcon(cat: string) {
  switch (cat) {
    case 'image': return Image;
    case 'video': return Video;
    case 'audio': return Music;
    case 'document': return FileText;
    case 'archive': return Archive;
    case 'code': return FileCode;
    default: return FileIcon;
  }
}
export { Folder as FolderIcon };

const EXT_LABELS: Record<string, string> = {
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image', heic: 'HEIC image',
  mp4: 'MP4 video', mkv: 'MKV video', webm: 'WebM video', mov: 'MOV video', avi: 'AVI video',
  mp3: 'MP3 audio', flac: 'FLAC audio', wav: 'WAV audio', ogg: 'OGG audio', m4a: 'M4A audio',
  pdf: 'PDF', doc: 'Word document', docx: 'Word document', xls: 'Excel spreadsheet', xlsx: 'Excel spreadsheet', ppt: 'PowerPoint', pptx: 'PowerPoint',
  txt: 'Plain text', md: 'Markdown', csv: 'CSV', json: 'JSON', log: 'Log file',
  zip: 'ZIP archive', rar: 'RAR archive', '7z': '7-Zip archive', tar: 'TAR archive', gz: 'GZip archive',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', c: 'C', cpp: 'C++',
  html: 'HTML', css: 'CSS', xml: 'XML', yaml: 'YAML', yml: 'YAML', sql: 'SQL', sh: 'Shell script',
  exe: 'Executable', dmg: 'Disk image', iso: 'ISO image', epub: 'eBook', db: 'Database', bin: 'Binary file',
};
export function typeLabel(catOrExt: { category?: string; ext?: string }): string {
  const ext = (catOrExt.ext ?? '').toLowerCase();
  if (EXT_LABELS[ext]) return EXT_LABELS[ext]!;
  const cat = catOrExt.category ?? 'other';
  return { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', archive: 'Archive', code: 'Code file', other: 'File' }[cat] ?? 'File';
}
export function relDate(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
export function sortItems<T extends { name: string; size?: number; updatedAt: number; category?: string }>(
  items: T[], by: 'name' | 'updatedAt' | 'size' | 'type', dir: 'asc' | 'desc',
): T[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (by) {
      case 'name': return a.name.localeCompare(b.name, undefined, { numeric: true }) * m;
      case 'size': return ((a.size ?? 0) - (b.size ?? 0)) * m;
      case 'type': return ((a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name)) * m;
      default: return (a.updatedAt - b.updatedAt) * m;
    }
  });
}

export type Item = { kind: 'file'; data: FileDTO } | { kind: 'folder'; data: FolderDTO };
export function itemId(i: Item) { return i.data.id; }
export function itemName(i: Item) { return i.data.name; }

export function isTextEditable(f: FileDTO): boolean {
  return f.category === 'code' || f.mimeType.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(f.extension);
}
export function cmLanguageExt(ext: string): string[] {
  if (['js', 'jsx', 'ts', 'tsx', 'json', 'mjs', 'cjs'].includes(ext)) return ['javascript'];
  if (['py'].includes(ext)) return ['python'];
  if (['md', 'markdown'].includes(ext)) return ['markdown'];
  return [];
}
