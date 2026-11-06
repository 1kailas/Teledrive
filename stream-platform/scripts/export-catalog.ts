import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

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

const items: CatalogItem[] = [];
const seen = new Set<string>();

// Read teledrive.db if available
if (fs.existsSync(sqliteDbPath)) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const Database = require(path.resolve(rootDir, 'server/node_modules/better-sqlite3'));
    const db = new Database(sqliteDbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM files WHERE category IN (\'video\', \'audio\')').all();
    for (const f of rows) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const parts = db.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC').all(f.blob_id);
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(f.metadata || '{}'); } catch {}
      items.push({
        id: f.id,
        name: f.name,
        category: f.category,
        mimeType: f.mime_type || (f.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
        size: f.size,
        duration: f.duration || 15,
        hasThumbnail: Boolean(f.has_thumbnail),
        updatedAt: f.updated_at,
        artist: typeof meta.artist === 'string' ? meta.artist : '',
        album: typeof meta.album === 'string' ? meta.album : '',
        description: f.description || 'Direct Telegram Cloud Stream',
        parts: parts.map((p: any) => ({
          partIndex: p.idx,
          size: p.size,
          telegramFileId: p.tg_file_id,
          botId: p.bot_id,
        })),
      });
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
        duration: f.duration || null,
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

// Audio tracks
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

const outPath = path.resolve(__dirname, '../public/catalog.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ items }, null, 2));
console.log(`Exported ${items.length} media items to ${outPath}`);
