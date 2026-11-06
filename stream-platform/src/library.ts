export interface MediaPart {
  partIndex: number;
  size: number;
  telegramFileId?: string;
  botId?: string;
}

export interface MediaItem {
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
  partsCount?: number;
  parts?: MediaPart[];
  audioTracks?: { id: string; label: string; language?: string }[];
}

export interface EpisodeItem extends MediaItem {
  episodeNumber: number;
  seasonNumber: number;
  seriesId: string;
  seriesName: string;
  episodeTitle: string;
}

export interface SeasonItem {
  seasonNumber: number;
  name: string;
  episodes: EpisodeItem[];
}

export interface SeriesItem {
  id: string;
  name: string;
  folderName: string;
  description: string;
  seasonsCount: number;
  episodesCount: number;
  seasons: SeasonItem[];
  genres?: string[];
  year?: number | string;
  updatedAt: number;
  hasThumbnail?: boolean;
}

export interface CatalogData {
  items: MediaItem[];
  series?: SeriesItem[];
}

export function parseEpisodeInfo(filename: string, defaultSeason = 1, defaultEp = 1): {
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

export const artwork = (item: MediaItem) => item.hasThumbnail ? `/api/art/${item.id}` : undefined;

const RELEASE_MARKER = /\b(?:2160p|1440p|1080p|720p|480p|4k|uhd|hdr10\+?|dolby.?vision|web[- .]?dl|webrip|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|remux|x264|x265|h[ .]?264|h[ .]?265|hevc|avc|10bit|8bit|proper|repack)\b/i;

/**
 * Turn release-style file names into presentable titles. Names that do not
 * look like scene releases are left untouched so punctuation in real titles
 * survives.
 */
export function cleanTitle(filename: string): string {
  const raw = filename.replace(/\.[^.]+$/, '') || filename;
  if (!RELEASE_MARKER.test(raw)) return raw;

  const normalized = raw.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const releaseYear = /\b(?:19|20)\d{2}\b(?=\s*(?:2160p|1440p|1080p|720p|480p|4k|uhd|hdr|dolby|web[- .]?dl|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|remux|x26[45]|h[ .]?26[45]|hevc|avc|repack|proper|nf|amzn|dsnp|hmax|atvp|pcok|hulu|itunes))\b/i.exec(normalized);
  const marker = RELEASE_MARKER.exec(normalized);
  const cutoff = releaseYear?.index ?? marker?.index ?? normalized.length;
  const cleaned = normalized
    .slice(0, cutoff)
    .replace(/\s*[\(\[](?:19|20)\d{2}[\)\]]\s*$/, '')
    .replace(/[\s\-–—]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned.length >= 2 ? cleaned : raw;
}

export const titleOf = (item: MediaItem) => cleanTitle(item.name) || item.name;
export const artistOf = (item: MediaItem) => item.artist || item.album || 'Your music library';

export const formatOf = (item: MediaItem): string => {
  if (item.format) return item.format.toUpperCase();
  const ext = item.name.split('.').pop() ?? '';
  return ext ? ext.toUpperCase() : item.category === 'video' ? 'VIDEO' : 'AUDIO';
};

export const sizeOf = (bytes: number | null | undefined): string => {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

export const timeOf = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const time = Math.floor(seconds);
  return time >= 3600
    ? `${Math.floor(time / 3600)}:${String(Math.floor(time % 3600 / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`
    : `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;
};

export function detectMime(fileName: string, category: 'video' | 'audio' = 'video'): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mov: 'video/quicktime',
    qt: 'video/quicktime',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    mts: 'video/mp2t',
    flv: 'video/x-flv',
    '3gp': 'video/3gpp',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    weba: 'audio/webm',
  };
  return map[ext] ?? (category === 'video' ? 'video/mp4' : 'audio/mpeg');
}

const KEY = 'folio:watchlist';
const POSITION_KEY = 'folio:positions';
const AUDIO_PREF_KEY = 'folio:audio_pref';

function readObject<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}

export const getWatchlist = () => readObject<string[]>(KEY, []).filter((id) => typeof id === 'string').slice(0, 200);
export const saveWatchlist = (ids: string[]) => localStorage.setItem(KEY, JSON.stringify(ids.slice(0, 200)));
export const getPositions = () => readObject<Record<string, number>>(POSITION_KEY, {});
export function savePosition(id: string, seconds: number | null) {
  const positions = getPositions();
  if (seconds === null) delete positions[id];
  else positions[id] = Math.floor(seconds);
  const recent = Object.entries(positions).slice(-100);
  localStorage.setItem(POSITION_KEY, JSON.stringify(Object.fromEntries(recent)));
}

export type AudioProfile = 'flat' | 'dialogue' | 'night' | 'bass' | 'boost150' | 'boost200';

export interface AudioPreferences {
  profile: AudioProfile;
  speed: number;
  monoDownmix: boolean;
}

export const getAudioPrefs = (): AudioPreferences =>
  readObject<AudioPreferences>(AUDIO_PREF_KEY, { profile: 'flat', speed: 1.0, monoDownmix: false });

export const saveAudioPrefs = (prefs: AudioPreferences) =>
  localStorage.setItem(AUDIO_PREF_KEY, JSON.stringify(prefs));
