import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const outPath = path.resolve(__dirname, '../public/catalog.json');

const p1 = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive.json';
const p2 = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive-db.json';
const sqliteDbPath = path.resolve(rootDir, 'data/teledrive.db');

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
  parts?: CatalogPart[];
}

interface EpisodeItem extends CatalogItem {
  episodeNumber: number;
  seasonNumber: number;
  seriesId: string;
  seriesName: string;
  episodeTitle: string;
}

interface SeasonItem {
  seasonNumber: number;
  name: string;
  episodes: EpisodeItem[];
}

interface SeriesItem {
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

const items: CatalogItem[] = [];
let series: SeriesItem[] = [];
const seen = new Set<string>();

// Pre-load existing committed catalog items & series
if (fs.existsSync(outPath)) {
  try {
    const raw = fs.readFileSync(outPath, 'utf8');
    const existing = JSON.parse(raw) as { items?: CatalogItem[]; series?: SeriesItem[] } | CatalogItem[];
    const list = Array.isArray(existing) ? existing : (existing.items ?? []);
    if (!Array.isArray(existing) && Array.isArray(existing.series)) {
      series = existing.series;
    }
    for (const item of list) {
      if (item && item.id && !seen.has(item.id)) {
        if (item.name.toLowerCase().includes('inception')) {
          item.duration = 8884;
          item.description = "Dom Cobb is a skilled thief who steals valuable secrets from deep within the subconscious during the dream state. Feature film (2h 28m).";
        }
        seen.add(item.id);
        items.push(item);
      }
    }
  } catch {}
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

// Read teledrive.db if available locally
if (fs.existsSync(sqliteDbPath)) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const Database = require(path.resolve(rootDir, 'server/node_modules/better-sqlite3'));
    const db = new Database(sqliteDbPath, { readonly: true });

    const allFolders = db.prepare('SELECT id, parent_id, name, updated_at FROM folders WHERE trashed_at IS NULL').all();
    const streamFolder = allFolders.find((f: any) => f.name.toLowerCase() === 'stream');

    const getPartsForBlob = (blobId: string) => {
      const parts = db.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC').all(blobId);
      return parts.map((p: any) => ({
        partIndex: p.idx,
        size: p.size,
        telegramFileId: p.tg_file_id,
        botId: p.bot_id,
      }));
    };

    if (streamFolder) {
      // 1. Files directly in stream folder = Standalone Movies / Audio
      const streamFiles = db.prepare("SELECT * FROM files WHERE folder_id = ? AND category IN ('video', 'audio') AND trashed_at IS NULL AND status = 'ready'").all(streamFolder.id);
      for (const f of streamFiles) {
        seen.add(f.id);
        const existingIdx = items.findIndex((it) => it.id === f.id);
        const mappedParts = getPartsForBlob(f.blob_id);
        const entry: CatalogItem = {
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
        };
        if (existingIdx >= 0) items[existingIdx] = entry;
        else items.push(entry);
      }

      // 2. Subfolders inside stream folder = TV Series
      const seriesFolders = allFolders.filter((f: any) => f.parent_id === streamFolder.id);
      for (const sFolder of seriesFolders) {
        const seasonFolders = allFolders.filter((f: any) => f.parent_id === sFolder.id);
        const seasons: SeasonItem[] = [];
        let totalEpisodes = 0;

        if (seasonFolders.length > 0) {
          for (const seFolder of seasonFolders) {
            const seMatch = /(?:season\s*|s)(\d+)/i.exec(seFolder.name);
            const seNum = seMatch ? parseInt(seMatch[1]!, 10) : seasons.length + 1;
            const epFiles = db.prepare("SELECT * FROM files WHERE folder_id = ? AND category = 'video' AND trashed_at IS NULL AND status = 'ready' ORDER BY name ASC").all(seFolder.id);
            const episodes: EpisodeItem[] = epFiles.map((f: any, epIdx: number) => {
              seen.add(f.id);
              const info = parseEp(f.name, seNum, epIdx + 1);
              return {
                id: f.id,
                episodeNumber: info.episode,
                seasonNumber: seNum,
                seriesId: sFolder.id,
                seriesName: sFolder.name,
                episodeTitle: info.title,
                name: f.name,
                category: 'video',
                mimeType: f.mime_type || 'video/mp4',
                size: f.size,
                duration: f.duration || null,
                hasThumbnail: Boolean(f.has_thumbnail),
                updatedAt: f.updated_at,
                artist: '',
                album: '',
                description: f.description || '',
                parts: getPartsForBlob(f.blob_id),
              };
            });
            episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
            totalEpisodes += episodes.length;
            seasons.push({ seasonNumber: seNum, name: seFolder.name, episodes });
          }
          seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
        } else {
          const epFiles = db.prepare("SELECT * FROM files WHERE folder_id = ? AND category = 'video' AND trashed_at IS NULL AND status = 'ready' ORDER BY name ASC").all(sFolder.id);
          if (epFiles.length > 0) {
            const episodes: EpisodeItem[] = epFiles.map((f: any, epIdx: number) => {
              seen.add(f.id);
              const info = parseEp(f.name, 1, epIdx + 1);
              return {
                id: f.id,
                episodeNumber: info.episode,
                seasonNumber: 1,
                seriesId: sFolder.id,
                seriesName: sFolder.name,
                episodeTitle: info.title,
                name: f.name,
                category: 'video',
                mimeType: f.mime_type || 'video/mp4',
                size: f.size,
                duration: f.duration || null,
                hasThumbnail: Boolean(f.has_thumbnail),
                updatedAt: f.updated_at,
                artist: '',
                album: '',
                description: f.description || '',
                parts: getPartsForBlob(f.blob_id),
              };
            });
            episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
            totalEpisodes += episodes.length;
            seasons.push({ seasonNumber: 1, name: 'Season 1', episodes });
          }
        }

        const seriesIdx = series.findIndex((s) => s.id === sFolder.id);
        const sEntry: SeriesItem = {
          id: sFolder.id,
          name: sFolder.name,
          folderName: sFolder.name,
          description: `TV Series · ${seasons.length} Season${seasons.length > 1 ? 's' : ''} · ${totalEpisodes} Episode${totalEpisodes > 1 ? 's' : ''}`,
          seasonsCount: seasons.length,
          episodesCount: totalEpisodes,
          seasons,
          updatedAt: sFolder.updated_at,
          hasThumbnail: seasons[0]?.episodes[0]?.hasThumbnail ?? false,
        };
        if (seriesIdx >= 0) series[seriesIdx] = sEntry;
        else series.push(sEntry);
      }
    }

    // Also support root/general files if no stream folder or for standalone movies
    const rows = db.prepare("SELECT * FROM files WHERE category IN ('video', 'audio')").all();
    for (const f of rows) {
      if (seen.has(f.id)) continue;
      const parts = db.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC').all(f.blob_id);
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(f.metadata || '{}'); } catch {}
      const mappedParts = parts.map((p: any) => ({
        partIndex: p.idx,
        size: p.size,
        telegramFileId: p.tg_file_id,
        botId: p.bot_id,
      }));

      const existingIdx = items.findIndex((it) => it.id === f.id);
      const entry: CatalogItem = {
        id: f.id,
        name: f.name,
        category: f.category,
        mimeType: f.mime_type || (f.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
        size: f.size,
        duration: f.duration || (f.name.toLowerCase().includes('inception') ? 8884 : 15),
        hasThumbnail: Boolean(f.has_thumbnail),
        updatedAt: f.updated_at,
        artist: typeof meta.artist === 'string' ? meta.artist : '',
        album: typeof meta.album === 'string' ? meta.album : '',
        description: f.description || 'Direct Telegram Cloud Stream',
        parts: mappedParts.length > 0 ? mappedParts : undefined,
      };

      if (existingIdx >= 0) {
        // Do not overwrite Inception if it already has more than 51 parts (19.5MB cloud parts)
        const isInc = f.name.toLowerCase().includes('inception');
        const prevParts = items[existingIdx]?.parts?.length ?? 0;
        if (isInc && prevParts > 51) {
          // Keep existing 19.5MB parts
        } else {
          items[existingIdx] = { ...items[existingIdx], ...entry };
        }
      } else {
        seen.add(f.id);
        items.push(entry);
      }
    }
  } catch (e) {
    console.warn('SQLite export bypassed:', (e as Error).message);
  }
}

// Fallback to JSON databases
const jsonSources = [p2, p1];
for (const p of jsonSources) {
  if (!fs.existsSync(p)) continue;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const db = JSON.parse(raw);
    const files = db.files || [];
    const parts = db.parts || [];
    for (const f of files) {
      if (!['video', 'audio'].includes(f.category) || seen.has(f.id)) continue;
      seen.add(f.id);
      const fParts = parts.filter((pt: any) => pt.blob_id === f.blob_id);
      items.push({
        id: f.id,
        name: f.name,
        category: f.category,
        mimeType: f.mime_type || (f.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
        size: f.size,
        duration: f.duration || (f.name.toLowerCase().includes('inception') ? 8884 : null),
        hasThumbnail: Boolean(f.has_thumbnail),
        updatedAt: f.updated_at || Date.now(),
        artist: '',
        album: '',
        description: f.description || '',
        parts: fParts.map((pt: any) => ({
          partIndex: pt.part_index ?? pt.idx ?? 0,
          size: pt.size,
          telegramFileId: pt.telegram_file_id,
          botId: pt.bot_id,
        })),
      });
    }
  } catch {}
}

// Ensure audio tracks are present
if (!seen.has('a1111111-1111-4111-a111-111111111111')) {
  items.push({
    id: 'a1111111-1111-4111-a111-111111111111',
    name: 'Ambient Dreamscape.wav',
    category: 'audio',
    mimeType: 'audio/wav',
    size: 5292044,
    duration: 30,
    hasThumbnail: false,
    updatedAt: Date.now(),
    artist: 'TeleDrive Soundscapes',
    album: 'Folio Studio Sessions',
    description: 'Multi-harmonic ambient progression streamed directly in high fidelity.',
  });
}

if (!seen.has('b2222222-2222-4222-b222-222222222222')) {
  items.push({
    id: 'b2222222-2222-4222-b222-222222222222',
    name: 'Midnight Lo-Fi.wav',
    category: 'audio',
    mimeType: 'audio/wav',
    size: 4233644,
    duration: 24,
    hasThumbnail: false,
    updatedAt: Date.now(),
    artist: 'Aurora Node',
    album: 'TeleDrive Cloud',
    description: 'Warm nocturnal chords with subtle stereo panning and gentle acoustic decay.',
  });
}

// Check for completed 19.5MB cloud parts for Inception
const progressPath = path.resolve(__dirname, '../data/inception-upload-progress.json');
if (fs.existsSync(progressPath)) {
  try {
    const pData = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    if (Array.isArray(pData) && pData.length > 51) {
      const incItem = items.find((it) => it.name.toLowerCase().includes('inception'));
      if (incItem) {
        incItem.name = 'Inception.2010.1080p.NF.WEB-DL.English.H.264.mp4';
        incItem.mimeType = 'video/mp4';
        incItem.size = 2914735596;
        incItem.duration = 8884;
        incItem.description = 'Dom Cobb is a skilled thief who steals valuable secrets from deep within the subconscious during the dream state. Full-length feature film (2h 28m).';
        incItem.parts = pData.sort((a: any, b: any) => a.partIndex - b.partIndex);
      }
    }
  } catch {}
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

// Ensure episodes belonging to TV series do not duplicate into standalone items
const seriesEpisodeIds = new Set<string>();
for (const s of series) {
  for (const se of s.seasons) {
    for (const ep of se.episodes) {
      seriesEpisodeIds.add(ep.id);
    }
  }
}
const finalItems = items.filter((it) => !seriesEpisodeIds.has(it.id));

fs.writeFileSync(outPath, JSON.stringify({ items: finalItems, series }, null, 2));
console.log(`Exported ${finalItems.length} media items and ${series.length} series to ${outPath}`);
