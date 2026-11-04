import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { REPO_ROOT, type AppConfig } from '../config.js';
import { thumbnailPath } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { FileRow } from '../types.js';

const execFileP = promisify(execFile);
const MEDIA_TIMEOUT_MS = 60_000;

export interface MediaTools {
  ffmpeg: string | null;
  ffprobe: string | null;
  pdftoppm: string | null;
}

function which(bin: string, args: string[]): boolean {
  try {
    const r = spawnSync(bin, args, { timeout: 10_000, stdio: 'ignore' });
    return !r.error;
  } catch {
    return false;
  }
}

export function detectTools(config: AppConfig, logger: Logger): MediaTools {
  const ffmpeg = config.ffmpegPath || 'ffmpeg';
  const ffprobe = config.ffprobePath || 'ffprobe';
  const binPdftoppm = path.join(REPO_ROOT, 'bin', 'pdftoppm');
  const pdftoppm = which('pdftoppm', ['-v'])
    ? 'pdftoppm'
    : which(binPdftoppm, ['-v'])
      ? binPdftoppm
      : null;
  const tools: MediaTools = {
    ffmpeg: which(ffmpeg, ['-version']) ? ffmpeg : null,
    ffprobe: which(ffprobe, ['-version']) ? ffprobe : null,
    pdftoppm,
  };
  logger.info({ tools }, 'media tools detected');
  return tools;
}

export interface MediaResult {
  hasThumbnail: boolean;
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: number;
  metadata?: Record<string, unknown>;
}

interface FfprobeResult {
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    bit_rate?: string;
    avg_frame_rate?: string;
    duration?: string;
  }[];
}

async function ffprobeJson(ffprobe: string, file: string): Promise<FfprobeResult> {
  const { stdout } = await execFileP(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: MEDIA_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as FfprobeResult;
}

function parseFps(raw?: string): number | undefined {
  if (!raw) return undefined;
  const [n, d] = raw.split('/').map(Number);
  if (!n || !d) return undefined;
  return n / d;
}

function firstTag(tags: Record<string, string> | undefined, keys: string[]): string | undefined {
  if (!tags) return undefined;
  const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) if (lower[k]) return lower[k];
  return undefined;
}

function ensureThumbDir(dataDir: string, fileId: string): string {
  const p = thumbnailPath(dataDir, fileId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

async function sharpToThumb(src: string | Buffer, out: string, size: number): Promise<void> {
  await sharp(src)
    .rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toFile(out);
}

function exifMetadata(buf: Buffer | undefined): { takenAt?: number; meta: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  if (!buf || buf.length === 0) return { meta };
  try {
    const exif = exifReader(buf) as {
      image?: { Make?: string; Model?: string };
      exif?: {
        DateTimeOriginal?: Date;
        LensModel?: string;
        ISOSpeedRatings?: number;
        FNumber?: number;
        ExposureTime?: number;
        FocalLength?: number;
      };
      gps?: { GPSLatitude?: number[]; GPSLatitudeRef?: string; GPSLongitude?: number[]; GPSLongitudeRef?: string };
    };
    if (exif.image?.Make) meta.make = exif.image.Make;
    if (exif.image?.Model) meta.model = exif.image.Model;
    if (exif.exif?.LensModel) meta.lens = exif.exif.LensModel;
    if (exif.exif?.ISOSpeedRatings) meta.iso = exif.exif.ISOSpeedRatings;
    if (exif.exif?.FNumber) meta.fNumber = exif.exif.FNumber;
    if (exif.exif?.ExposureTime) meta.exposureTime = exif.exif.ExposureTime;
    if (exif.exif?.FocalLength) meta.focalLength = exif.exif.FocalLength;
    const lat = exif.gps?.GPSLatitude;
    const lon = exif.gps?.GPSLongitude;
    if (lat && lon) {
      const la = (lat[0] ?? 0) + (lat[1] ?? 0) / 60 + (lat[2] ?? 0) / 3600;
      const lo = (lon[0] ?? 0) + (lon[1] ?? 0) / 60 + (lon[2] ?? 0) / 3600;
      meta.gps = {
        lat: exif.gps?.GPSLatitudeRef === 'S' ? -la : la,
        lon: exif.gps?.GPSLongitudeRef === 'W' ? -lo : lo,
      };
    }
    const taken = exif.exif?.DateTimeOriginal;
    return { takenAt: taken ? taken.getTime() : undefined, meta };
  } catch {
    return { meta };
  }
}

async function extractImage(
  dataDir: string,
  file: FileRow,
  partPath: string,
  thumbSize: number,
): Promise<MediaResult> {
  const img = sharp(partPath);
  const info = await img.metadata();
  const out = ensureThumbDir(dataDir, file.id);
  await sharpToThumb(partPath, out, thumbSize);
  const { takenAt, meta } = exifMetadata(info.exif);
  return {
    hasThumbnail: true,
    width: info.width,
    height: info.height,
    ...(takenAt !== undefined ? { takenAt } : {}),
    metadata: { format: info.format, ...meta },
  };
}

function compact(meta: Record<string, unknown>): Record<string, unknown> {
  Object.keys(meta).forEach((k) => (meta[k] === undefined || meta[k] === null || meta[k] === '') && delete meta[k]);
  return meta;
}

/**
 * Pure-JS container/tag parser used when ffprobe/ffmpeg are not installed.
 * Covers MP3/FLAC/M4A/OGG/WAV tags + cover art and MP4/MKV/WebM duration and
 * dimensions (when the index is at the start of the part).
 */
async function extractWithMusicMetadata(
  dataDir: string,
  file: FileRow,
  partPath: string,
  thumbSize: number,
): Promise<MediaResult> {
  const mm = await import('music-metadata');
  const parsed = await mm.parseFile(partPath, { duration: false, skipCovers: file.category !== 'audio' });
  const { format, common } = parsed;
  const video = format.trackInfo?.find((t) => t.video)?.video;
  const metadata = compact({
    title: common.title,
    artist: common.artist,
    album: common.album,
    albumArtist: common.albumartist,
    genre: common.genre?.join(', '),
    year: common.year,
    track: common.track?.no ?? undefined,
    codec: format.codec,
    container: format.container,
    bitrate: format.bitrate ? Math.round(format.bitrate) : undefined,
    sampleRate: format.sampleRate,
    channels: format.numberOfChannels,
    lossless: format.lossless,
  });
  const result: MediaResult = {
    hasThumbnail: false,
    ...(format.duration ? { duration: format.duration } : {}),
    ...(video?.pixelWidth ? { width: video.pixelWidth, height: video.pixelHeight } : {}),
    metadata,
  };
  const cover = common.picture?.[0];
  if (cover?.data?.length) {
    const out = ensureThumbDir(dataDir, file.id);
    await sharpToThumb(Buffer.from(cover.data), out, thumbSize);
    result.hasThumbnail = true;
  }
  return result;
}

async function extractVideo(
  tools: MediaTools,
  dataDir: string,
  file: FileRow,
  partPath: string,
  thumbSize: number,
  isWholeFile: boolean,
): Promise<MediaResult> {
  if (!tools.ffprobe || !tools.ffmpeg) return extractWithMusicMetadata(dataDir, file, partPath, thumbSize);
  const probe = await ffprobeJson(tools.ffprobe, partPath);
  const video = probe.streams?.find((s) => s.codec_type === 'video');
  const duration = parseFloat(probe.format?.duration ?? video?.duration ?? '0') || undefined;
  const metadata: Record<string, unknown> = {
    codec: video?.codec_name,
    bitrate: probe.format?.bit_rate ? Number(probe.format.bit_rate) : undefined,
    fps: parseFps(video?.avg_frame_rate),
  };
  Object.keys(metadata).forEach((k) => metadata[k] === undefined && delete metadata[k]);
  // frame at min(10% duration, 5s) or 1s — requires a seekable file; part-0 of a
  // multi-part upload often has the moov atom at the end and will fail, which
  // is fine (no thumbnail).
  const seek = Math.max(0.1, Math.min((duration ?? 10) * 0.1, 5));
  const tmpPng = partPath + '.thumb.png';
  await execFileP(
    tools.ffmpeg,
    ['-y', '-ss', String(seek), '-i', partPath, '-frames:v', '1', '-f', 'image2', tmpPng],
    { timeout: MEDIA_TIMEOUT_MS },
  );
  const out = ensureThumbDir(dataDir, file.id);
  await sharpToThumb(tmpPng, out, thumbSize);
  fs.unlink(tmpPng, () => {});
  return {
    hasThumbnail: true,
    width: video?.width,
    height: video?.height,
    duration,
    metadata,
  };
}

async function extractAudio(
  tools: MediaTools,
  dataDir: string,
  file: FileRow,
  partPath: string,
  thumbSize: number,
): Promise<MediaResult> {
  if (!tools.ffprobe || !tools.ffmpeg) return extractWithMusicMetadata(dataDir, file, partPath, thumbSize);
  const probe = await ffprobeJson(tools.ffprobe, partPath);
  const duration = parseFloat(probe.format?.duration ?? '0') || undefined;
  const tags = probe.format?.tags;
  const metadata: Record<string, unknown> = {
    title: firstTag(tags, ['title']),
    artist: firstTag(tags, ['artist']),
    album: firstTag(tags, ['album']),
    genre: firstTag(tags, ['genre']),
    year: firstTag(tags, ['date', 'year']),
    bitrate: probe.format?.bit_rate ? Number(probe.format.bit_rate) : undefined,
  };
  Object.keys(metadata).forEach((k) => metadata[k] === undefined && delete metadata[k]);
  const result: MediaResult = { hasThumbnail: false, duration, metadata };
  const hasCover = probe.streams?.some((s) => s.codec_type === 'video');
  if (hasCover) {
    const tmpPng = partPath + '.cover.png';
    try {
      await execFileP(
        tools.ffmpeg,
        ['-y', '-i', partPath, '-map', '0:v:0', '-frames:v', '1', tmpPng],
        { timeout: MEDIA_TIMEOUT_MS },
      );
      const out = ensureThumbDir(dataDir, file.id);
      await sharpToThumb(tmpPng, out, thumbSize);
      result.hasThumbnail = true;
    } finally {
      fs.unlink(tmpPng, () => {});
    }
  }
  return result;
}

async function extractPdf(
  tools: MediaTools,
  dataDir: string,
  file: FileRow,
  partPath: string,
  thumbSize: number,
): Promise<MediaResult> {
  if (!tools.pdftoppm) return { hasThumbnail: false };
  const prefix = partPath + '.pdfpage';
  await execFileP(
    tools.pdftoppm,
    ['-png', '-f', '1', '-singlefile', '-scale-to', String(thumbSize * 2), partPath, prefix],
    { timeout: MEDIA_TIMEOUT_MS },
  );
  const png = `${prefix}.png`;
  const meta = await sharp(png).metadata();
  const out = ensureThumbDir(dataDir, file.id);
  await sharpToThumb(png, out, thumbSize);
  fs.unlink(png, () => {});
  return { hasThumbnail: true, width: meta.width, height: meta.height };
}

/**
 * Thumbnail + metadata extraction on part 0 of a file. Never throws —
 * failures are logged and reported as "no thumbnail".
 */
export async function extractMedia(opts: {
  config: AppConfig;
  tools: MediaTools;
  logger: Logger;
  file: FileRow;
  partPath: string;
  isWholeFile: boolean;
}): Promise<MediaResult> {
  const { config, tools, logger, file, partPath, isWholeFile } = opts;
  const ts = config.thumbnailSize;
  try {
    switch (file.category) {
      case 'image':
        // sharp needs the whole file for most formats
        if (!isWholeFile) return { hasThumbnail: false };
        return await extractImage(config.dataDir, file, partPath, ts);
      case 'video':
        return await extractVideo(tools, config.dataDir, file, partPath, ts, isWholeFile);
      case 'audio':
        // tag parsers need the whole file to report accurate durations
        if (!isWholeFile) return { hasThumbnail: false };
        return await extractAudio(tools, config.dataDir, file, partPath, ts);
      case 'document':
        if (file.extension === 'pdf') {
          return await extractPdf(tools, config.dataDir, file, partPath, ts);
        }
        return { hasThumbnail: false };
      default:
        return { hasThumbnail: false };
    }
  } catch (e) {
    logger.warn({ fileId: file.id, err: (e as Error).message }, 'media extraction failed');
    return { hasThumbnail: false };
  }
}

/** Apply a MediaResult to the files row. */
export function applyMediaResult(
  db: import('../db/index.js').Db,
  fileId: string,
  result: MediaResult,
): void {
  db.prepare(
    `UPDATE files SET has_thumbnail = ?, width = COALESCE(?, width), height = COALESCE(?, height),
       duration = COALESCE(?, duration), taken_at = COALESCE(?, taken_at),
       metadata = COALESCE(?, metadata), updated_at = ?
     WHERE id = ?`,
  ).run(
    result.hasThumbnail ? 1 : 0,
    result.width ?? null,
    result.height ?? null,
    result.duration ?? null,
    result.takenAt ?? null,
    result.metadata ? JSON.stringify(result.metadata) : null,
    Date.now(),
    fileId,
  );
}
