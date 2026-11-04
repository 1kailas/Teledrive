import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** "name.ext" -> "name (1).ext", "name (2).ext", ... until not taken (case-insensitive). */
export function uniqueName(requested: string, takenLower: Set<string>): string {
  if (!takenLower.has(requested.toLowerCase())) return requested;
  const dot = requested.lastIndexOf('.');
  const base = dot > 0 ? requested.slice(0, dot) : requested;
  const ext = dot > 0 ? requested.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
}

/** Make a string safe to use as a single file name (temp files, Telegram basename). */
export function sanitizeFileName(name: string, maxLen = 140): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '.')
    .trim();
  const final = cleaned.length > 0 ? cleaned : 'file';
  return final.length > maxLen ? final.slice(0, maxLen) : final;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'h',
  'cpp', 'cc', 'cxx', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'json', 'yaml',
  'yml', 'toml', 'md', 'markdown', 'html', 'htm', 'css', 'scss', 'less', 'sql', 'sh', 'bash',
  'zsh', 'ps1', 'lua', 'r', 'dart', 'vue', 'svelte', 'xml', 'ini', 'cfg', 'conf', 'env',
]);
const ARCHIVE_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'jar', 'war', 'iso', 'cab', 'lz4',
]);
const DOC_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'odt', 'ods', 'odp', 'rtf',
  'csv', 'tsv', 'epub', 'mobi', 'pages', 'numbers', 'key', 'tex',
]);

export function categorize(mimeType: string, extension: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (ARCHIVE_EXTS.has(extension) || mime.includes('zip') || mime.includes('compressed') || mime === 'application/x-tar') {
    return 'archive';
  }
  if (CODE_EXTS.has(extension)) return 'code';
  if (DOC_EXTS.has(extension) || mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
  return 'other';
}

/** Pipe a Readable into a writable fs handle at a byte offset; resolves after fsync. */
export async function writeStreamAt(
  stream: Readable,
  path: string,
  offset: number,
  expected: number,
): Promise<void> {
  // O_CREAT without O_TRUNC: two concurrent first slices of a fresh part must
  // not truncate each other's data.
  const handle = await fs.promises.open(path, fs.constants.O_RDWR | fs.constants.O_CREAT);
  try {
    let written = 0;
    let position = offset;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await handle.write(buf, off, buf.length - off, position);
        off += bytesWritten;
        position += bytesWritten;
        written += bytesWritten;
      }
    }
    if (written !== expected) {
      throw new Error(`short write: expected ${expected} bytes, wrote ${written}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function streamToBuffer(stream: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        stream.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
