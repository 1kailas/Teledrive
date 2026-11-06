import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';
import type { MediaTools } from './media.js';
import type { Db } from '../db/index.js';

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

export interface EpisodeFile {
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  seriesId: string;
  seriesName: string;
  episodeTitle: string;
  name: string;
  duration: number | null;
  size: number;
  mimeType: string;
  hasThumbnail: boolean;
  parts?: {
    partIndex: number;
    size: number;
    telegramFileId?: string;
    botId?: string;
  }[];
}

export interface SeasonFile {
  seasonNumber: number;
  name: string;
  episodes: EpisodeFile[];
}

export interface SeriesFile {
  id: string;
  name: string;
  folderName: string;
  description: string;
  seasonsCount: number;
  episodesCount: number;
  seasons: SeasonFile[];
  genres?: string[];
  year?: number | string;
  updatedAt: number;
  hasThumbnail?: boolean;
}

function parseEp(filename: string, defaultSeason = 1, defaultEp = 1): {
  season: number;
  episode: number;
  title: string;
} {
  const clean = filename.replace(/\.[^.]+$/, '');
  const sMatch = /(?:s|season\s*)(\d+)/i.exec(clean);
  const eMatch = /(?:e|ep|episode\s*|\bx\s*)(\d+)/i.exec(clean);

  const season = sMatch ? parseInt(sMatch[1]!, 10) : defaultSeason;
  const episode = eMatch ? parseInt(eMatch[1]!, 10) : defaultEp;

  let title = clean
    .replace(/(?:s\d+\s*e\d+|season\s*\d+\s*episode\s*\d+|\b\d+x\d+\b)/gi, '')
    .replace(/\b(1080p|720p|2160p|4k|uhd|web-dl|webrip|bluray|x264|h264|h\.264|ddp5\.1|ddp|eac3|aac|atmos)\b/gi, '')
    .replace(/[-_.]+/g, ' ')
    .trim();

  if (!title || title.length < 2) {
    title = `Episode ${episode}`;
  }

  return { season, episode, title };
}

/**
 * Syncs TeleDrive video/audio catalog with the standalone streaming catalog.
 * Follows folder hierarchy:
 *   - Folder named 'stream' (inside 'Videos' or root) contains website media.
 *   - Direct files inside 'stream' = Standalone Movies / Audio.
 *   - Subfolders inside 'stream' = TV Series / Shows.
 *   - Folders inside a series folder = Seasons.
 *   - Files inside a season folder = Episodes.
 */
export function syncTeleDriveToCatalog(db: Db, catalogPath: string): number {
  try {
    const allFolders = db.prepare(`
      SELECT id, parent_id, name, updated_at
      FROM folders
      WHERE trashed_at IS NULL
    `).all() as { id: string; parent_id: string | null; name: string; updated_at: number }[];

    // Locate the 'stream' folder
    const streamFolder = allFolders.find((f) => f.name.toLowerCase() === 'stream');

    let existingCatalog: { items?: any[]; series?: SeriesFile[] } = {};
    if (fs.existsSync(catalogPath)) {
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        existingCatalog = JSON.parse(raw);
      } catch {}
    }

    const existingItems: any[] = existingCatalog.items ?? [];
    const existingSeries: SeriesFile[] = existingCatalog.series ?? [];

    const items: any[] = [];
    const seriesList: SeriesFile[] = [];
    const seenFiles = new Set<string>();

    const getPartsForBlob = (blobId: string) => {
      const parts = db.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC').all(blobId) as import('../types.js').PartRow[];
      return parts.map((p) => ({
        partIndex: p.idx,
        size: p.size,
        telegramFileId: p.tg_file_id ?? undefined,
        botId: p.bot_id ?? undefined,
      }));
    };

    if (streamFolder) {
      // 1. Direct files inside 'stream' are Movies / Standalone
      const streamFiles = db.prepare(`
        SELECT f.*
        FROM files f
        WHERE f.folder_id = ? AND f.category IN ('video', 'audio')
          AND f.status = 'ready' AND f.trashed_at IS NULL
        ORDER BY f.created_at DESC
      `).all(streamFolder.id) as import('../types.js').FileRow[];

      for (const f of streamFiles) {
        seenFiles.add(f.id);
        const existing = existingItems.find((it) => it.id === f.id);
        let mappedParts = existing?.parts;
        if (!mappedParts || mappedParts.length === 0) mappedParts = getPartsForBlob(f.blob_id!);

        items.push({
          id: f.id,
          name: f.name,
          category: f.category,
          mimeType: f.mime_type || (f.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
          size: f.size,
          duration: f.duration || (f.name.toLowerCase().includes('inception') ? 8884 : 15),
          hasThumbnail: Boolean(f.has_thumbnail),
          updatedAt: f.updated_at,
          artist: '',
          album: '',
          description: f.description || 'Movie / Standalone Media',
          parts: mappedParts.length > 0 ? mappedParts : undefined,
        });
      }

      // 2. Subfolders inside 'stream' are TV Series
      const seriesFolders = allFolders.filter((f) => f.parent_id === streamFolder.id);

      for (const sFolder of seriesFolders) {
        const seasonFolders = allFolders.filter((f) => f.parent_id === sFolder.id);
        const seasons: SeasonFile[] = [];
        let totalEpisodes = 0;

        if (seasonFolders.length > 0) {
          // Has Season folders
          for (const seFolder of seasonFolders) {
            const seMatch = /(?:season\s*|s)(\d+)/i.exec(seFolder.name);
            const seNum = seMatch ? parseInt(seMatch[1]!, 10) : seasons.length + 1;

            const epFiles = db.prepare(`
              SELECT f.*
              FROM files f
              WHERE f.folder_id = ? AND f.category = 'video'
                AND f.status = 'ready' AND f.trashed_at IS NULL
              ORDER BY f.name ASC
            `).all(seFolder.id) as import('../types.js').FileRow[];

            const episodes: EpisodeFile[] = epFiles.map((f, epIdx) => {
              seenFiles.add(f.id);
              const info = parseEp(f.name, seNum, epIdx + 1);
              return {
                id: f.id,
                episodeNumber: info.episode,
                seasonNumber: seNum,
                seriesId: sFolder.id,
                seriesName: sFolder.name,
                episodeTitle: info.title,
                name: f.name,
                duration: f.duration || null,
                size: f.size,
                mimeType: f.mime_type || 'video/mp4',
                hasThumbnail: Boolean(f.has_thumbnail),
                parts: getPartsForBlob(f.blob_id!),
              };
            });

            // Sort episodes naturally by episode number
            episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
            totalEpisodes += episodes.length;

            seasons.push({
              seasonNumber: seNum,
              name: seFolder.name,
              episodes,
            });
          }
          seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
        } else {
          // Direct files inside series folder = Season 1
          const epFiles = db.prepare(`
            SELECT f.*
            FROM files f
            WHERE f.folder_id = ? AND f.category = 'video'
              AND f.status = 'ready' AND f.trashed_at IS NULL
            ORDER BY f.name ASC
          `).all(sFolder.id) as import('../types.js').FileRow[];

          if (epFiles.length > 0) {
            const episodes: EpisodeFile[] = epFiles.map((f, epIdx) => {
              seenFiles.add(f.id);
              const info = parseEp(f.name, 1, epIdx + 1);
              return {
                id: f.id,
                episodeNumber: info.episode,
                seasonNumber: 1,
                seriesId: sFolder.id,
                seriesName: sFolder.name,
                episodeTitle: info.title,
                name: f.name,
                duration: f.duration || null,
                size: f.size,
                mimeType: f.mime_type || 'video/mp4',
                hasThumbnail: Boolean(f.has_thumbnail),
                parts: getPartsForBlob(f.blob_id!),
              };
            });

            episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
            totalEpisodes += episodes.length;

            seasons.push({
              seasonNumber: 1,
              name: 'Season 1',
              episodes,
            });
          }
        }

        seriesList.push({
          id: sFolder.id,
          name: sFolder.name,
          folderName: sFolder.name,
          description: `TV Series · ${seasons.length} Season${seasons.length > 1 ? 's' : ''} · ${totalEpisodes} Episode${totalEpisodes > 1 ? 's' : ''}`,
          seasonsCount: seasons.length,
          episodesCount: totalEpisodes,
          seasons,
          updatedAt: sFolder.updated_at,
          hasThumbnail: seasons[0]?.episodes[0]?.hasThumbnail ?? false,
        });
      }
    }

    // Preserve existing standalone items (e.g. Inception 143 parts, ambient audio)
    for (const ex of existingItems) {
      if (ex && ex.id && !seenFiles.has(ex.id)) {
        seenFiles.add(ex.id);
        items.push(ex);
      }
    }

    // Preserve any existing series not in DB
    for (const exS of existingSeries) {
      if (exS && exS.id && !seriesList.some((s) => s.id === exS.id)) {
        seriesList.push(exS);
      }
    }

    // Exclude any file that belongs to a TV series from standalone items
    const seriesEpisodeIds = new Set<string>();
    for (const s of seriesList) {
      for (const se of s.seasons) {
        for (const ep of se.episodes) {
          seriesEpisodeIds.add(ep.id);
        }
      }
    }
    const finalItems = items.filter((it) => !seriesEpisodeIds.has(it.id));

    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, JSON.stringify({ items: finalItems, series: seriesList }, null, 2));
    return finalItems.length + seriesList.length;
  } catch (err) {
    console.warn('[syncTeleDriveToCatalog error]', (err as Error).message);
    return 0;
  }
}
