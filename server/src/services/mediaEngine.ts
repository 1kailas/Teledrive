import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';
import type { MediaTools } from './media.js';
import type { Db } from '../db/index.js';
import type { FileRow, PartRow } from '../types.js';

const execFileP = promisify(execFile);

export interface MediaCodecProfile {
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number;
  bitrate?: number;
  channels?: number;
  hasSubtitles: boolean;
  subtitleCount: number;
  isWebCompatible: boolean;
  needsVideoTranscode: boolean;
  needsAudioTranscode: boolean;
}

const WEB_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const WEB_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const WEB_CONTAINERS = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'mp4', 'webm', 'ogg']);

/**
 * Probes deep media codec profile to determine if browser can play natively
 * or if it needs audio/video transmuxing.
 */
export async function analyzeMedia(filePath: string, tools: MediaTools): Promise<MediaCodecProfile> {
  if (!tools.ffprobe) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const isWeb = ['mp4', 'webm', 'mp3', 'm4a', 'wav'].includes(ext);
    return {
      container: ext,
      isWebCompatible: isWeb,
      needsVideoTranscode: false,
      needsAudioTranscode: false,
      hasSubtitles: false,
      subtitleCount: 0,
    };
  }

  const { stdout } = await execFileP(
    tools.ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      channels?: number;
    }[];
  };

  const container = parsed.format?.format_name ?? path.extname(filePath).slice(1);
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const subStreams = parsed.streams?.filter((s) => s.codec_type === 'subtitle') ?? [];

  const videoCodec = videoStream?.codec_name?.toLowerCase();
  const audioCodec = audioStream?.codec_name?.toLowerCase();

  const isContainerWeb = [...WEB_CONTAINERS].some((c) => container.includes(c));
  const isVideoWeb = !videoCodec || WEB_VIDEO_CODECS.has(videoCodec);
  const isAudioWeb = !audioCodec || WEB_AUDIO_CODECS.has(audioCodec);

  const isWebCompatible = isContainerWeb && isVideoWeb && isAudioWeb;
  const needsVideoTranscode = Boolean(videoCodec && !WEB_VIDEO_CODECS.has(videoCodec));
  const needsAudioTranscode = Boolean(audioCodec && !WEB_AUDIO_CODECS.has(audioCodec));

  return {
    container,
    videoCodec,
    audioCodec,
    width: videoStream?.width,
    height: videoStream?.height,
    duration: parseFloat(parsed.format?.duration ?? '0') || undefined,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : undefined,
    channels: audioStream?.channels,
    hasSubtitles: subStreams.length > 0,
    subtitleCount: subStreams.length,
    isWebCompatible,
    needsVideoTranscode,
    needsAudioTranscode,
  };
}

/**
 * Creates an on-the-fly streaming transmux pipeline.
 * If video is already H.264, it uses -c:v copy (zero CPU re-encoding overhead).
 * Audio is converted to AAC 192k for universal browser decoding.
 * Output is piped directly as fragmented MP4 (playable as it streams).
 */
export function createTransmuxStream(
  sourcePath: string,
  startTime = 0,
  tools: MediaTools,
): { stream: Readable; proc: import('node:child_process').ChildProcess } | null {
  if (!tools.ffmpeg) return null;

  const args: string[] = ['-hide_banner', '-loglevel', 'error'];

  if (startTime > 0) {
    args.push('-ss', String(startTime));
  }

  args.push(
    '-i', sourcePath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );

  const proc = spawn(tools.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stderr?.on('data', (chunk: Buffer) => {
    // Keep internal log of ffmpeg errors if needed
    const msg = chunk.toString();
    if (msg.includes('Error')) {
      console.warn('[transmuxStream error]', msg.trim());
    }
  });

  return { stream: proc.stdout, proc };
}

/**
 * Offline full transmux to high-performance faststart MP4.
 */
export async function transmuxToFaststartMp4(
  sourcePath: string,
  outputPath: string,
  tools: MediaTools,
  profile?: MediaCodecProfile,
): Promise<void> {
  if (!tools.ffmpeg) throw new Error('ffmpeg is required for media conversion');

  const vCodec = profile?.needsVideoTranscode ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '22'] : ['-c:v', 'copy'];
  const aCodec = profile?.needsAudioTranscode ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];

  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    ...vCodec,
    ...aCodec,
    '-movflags', '+faststart',
    outputPath,
  ];

  await execFileP(tools.ffmpeg, args, { timeout: 3600_000 });
}

/**
 * Extracts embedded subtitle stream from video to WebVTT format.
 */
export async function extractSubtitlesToVtt(
  sourcePath: string,
  outputVttPath: string,
  tools: MediaTools,
  streamIndex = 0,
): Promise<boolean> {
  if (!tools.ffmpeg) return false;
  try {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', sourcePath,
      '-map', `0:s:${streamIndex}`,
      '-f', 'webvtt',
      outputVttPath,
    ];
    await execFileP(tools.ffmpeg, args, { timeout: 30_000 });
    return fs.existsSync(outputVttPath) && fs.statSync(outputVttPath).size > 0;
  } catch {
    return false;
  }
}

interface CatalogPart {
  partIndex: number;
  size: number;
  telegramFileId?: string;
  botId?: string;
}

interface CatalogItem {
  id: string;
  name: string;
  category: 'video' | 'audio';
  mimeType: string;
  size: number;
  duration: number | null;
  hasThumbnail: boolean;
  updatedAt: number;
  artist: string;
  album: string;
  description: string;
  format?: string;
  parts?: CatalogPart[];
}

/** Public Bot API cannot serve files larger than 20 MiB via getFile. */
const PUBLIC_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function metadataOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function extensionOf(name: string): string | undefined {
  const extension = name.split('.').pop();
  return extension && extension !== name ? extension.toUpperCase() : undefined;
}

function mapParts(value: unknown): CatalogPart[] {
  if (!Array.isArray(value)) return [];

  const byIndex = new Map<number, CatalogPart>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const partIndex = typeof raw.partIndex === 'number'
      ? raw.partIndex
      : typeof raw.part_index === 'number'
        ? raw.part_index
        : typeof raw.idx === 'number' ? raw.idx : Number.NaN;
    const size = typeof raw.size === 'number' ? raw.size : Number.NaN;
    if (!Number.isInteger(partIndex) || partIndex < 0 || !Number.isFinite(size) || size <= 0) continue;

    const telegramFileId = [raw.telegramFileId, raw.telegram_file_id, raw.tg_file_id]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    const botId = [raw.botId, raw.bot_id]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);

    byIndex.set(partIndex, {
      partIndex,
      size,
      ...(telegramFileId ? { telegramFileId: telegramFileId.trim() } : {}),
      ...(botId ? { botId: botId.trim() } : {}),
    });
  }
  return [...byIndex.values()].sort((a, b) => a.partIndex - b.partIndex);
}

function hasPlayableParts(parts: CatalogPart[] | undefined): boolean {
  if (!parts || parts.length === 0) return false;
  const indices = new Set(parts.map((part) => part.partIndex));
  if (indices.size !== parts.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (!indices.has(index)) return false;
  }
  return parts.every((part) =>
    Boolean(part.telegramFileId)
    && part.size > 0
    && part.size <= PUBLIC_DOWNLOAD_LIMIT,
  );
}

function readExistingCatalog(catalogPath: string): CatalogItem[] {
  if (!fs.existsSync(catalogPath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
    const rawItems: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
        ? (parsed as { items: unknown[] }).items
        : [];

    // Older catalogs stored episodes inside series. Flatten them so they remain
    // available as standalone films after series support was removed.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const series = (parsed as { series?: unknown[] }).series;
      if (Array.isArray(series)) {
        for (const entry of series) {
          const seasons = (entry as { seasons?: unknown[] } | null)?.seasons;
          if (!Array.isArray(seasons)) continue;
          for (const season of seasons) {
            const episodes = (season as { episodes?: unknown[] } | null)?.episodes;
            if (Array.isArray(episodes)) rawItems.push(...episodes);
          }
        }
      }
    }

    const items: CatalogItem[] = [];
    for (const value of rawItems) {
      if (!value || typeof value !== 'object') continue;
      const raw = value as Record<string, unknown>;
      const id = textOf(raw.id).trim();
      const name = textOf(raw.name).trim();
      const category = raw.category === 'audio' ? 'audio' : raw.category === 'video' ? 'video' : null;
      if (!id || !name || !category) continue;

      const parts = mapParts(raw.parts);
      const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0;
      items.push({
        id,
        name,
        category,
        mimeType: textOf(raw.mimeType, category === 'video' ? 'video/mp4' : 'audio/mpeg'),
        size: size > 0 ? size : parts.reduce((sum, part) => sum + part.size, 0),
        duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : null,
        hasThumbnail: raw.hasThumbnail === true || raw.has_thumbnail === true || raw.has_thumbnail === 1,
        updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
        artist: textOf(raw.artist),
        album: textOf(raw.album),
        description: textOf(raw.description),
        format: textOf(raw.format) || extensionOf(name),
        ...(parts.length > 0 ? { parts } : {}),
      });
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Refreshes the standalone streaming catalog from the server's TeleDrive
 * library. Every ready video/audio file becomes a standalone item regardless
 * of its folder. Series are deliberately not generated; videos belong under
 * Movies & Films in the web app.
 */
export function syncTeleDriveToCatalog(db: Db, catalogPath: string): number {
  try {
    const existingItems = readExistingCatalog(catalogPath);
    const existingById = new Map(existingItems.map((item) => [item.id, item]));

    const files = db.prepare(`
      SELECT *
      FROM files
      WHERE category IN ('video', 'audio')
        AND status = 'ready'
        AND trashed_at IS NULL
      ORDER BY updated_at DESC
    `).all() as FileRow[];

    const items: CatalogItem[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);

      const existing = existingById.get(file.id);
      const sourceParts = file.blob_id
        ? (db.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC')
          .all(file.blob_id) as PartRow[]).map((part) => ({
            partIndex: part.idx,
            size: part.size,
            ...(part.tg_file_id ? { telegramFileId: part.tg_file_id } : {}),
            ...(part.bot_id ? { botId: part.bot_id } : {}),
          }))
        : [];

      // Keep a verified cloud edition when desktop uploads used oversized parts.
      const parts = !hasPlayableParts(sourceParts) && hasPlayableParts(existing?.parts)
        ? existing!.parts!
        : sourceParts;
      const metadata = metadataOf(file.metadata);
      const category = file.category === 'audio' ? 'audio' : 'video';
      const partSize = parts.reduce((sum, part) => sum + part.size, 0);

      items.push({
        id: file.id,
        name: file.name,
        category,
        mimeType: file.mime_type || (category === 'video' ? 'video/mp4' : 'audio/mpeg'),
        size: partSize > 0 ? partSize : file.size,
        duration: file.duration && file.duration > 0 ? file.duration : existing?.duration ?? null,
        hasThumbnail: Boolean(file.has_thumbnail) || existing?.hasThumbnail === true,
        updatedAt: file.updated_at,
        artist: textOf(metadata.artist, existing?.artist ?? ''),
        album: textOf(metadata.album, existing?.album ?? ''),
        description: file.description || existing?.description || '',
        format: extensionOf(file.name) ?? existing?.format,
        ...(parts.length > 0 ? { parts } : {}),
      });
    }

    // Desktop uploads are not written to this server's SQLite database. Keep
    // real entries that already have uploaded parts so a server-side sync does
    // not erase the desktop library from the hosted catalog.
    for (const existing of existingItems) {
      if (seen.has(existing.id)) continue;
      seen.add(existing.id);
      if (existing.parts && existing.parts.length > 0) items.push(existing);
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));

    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, `${JSON.stringify({ items, series: [] }, null, 2)}\n`);
    return items.length;
  } catch (err) {
    console.warn('[syncTeleDriveToCatalog error]', (err as Error).message);
    return 0;
  }
}
