import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CatalogFile {
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
}

function localStreamDevPlugin(): Plugin {
  const teledriveJsonPath = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive.json';
  const teledriveDbJsonPath = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive-db.json';
  const extractedVideosDir = '/mnt/c/Users/Kailasnath T/Videos/extracted_videos';
  const audioDir = path.join(__dirname, 'public/audio');

  function findThumbnail(id: string): { path: string; mime: string } | null {
    const thumbDirs = [
      '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/thumbnails',
      path.resolve(__dirname, '../data/thumbnails'),
    ];
    for (const dir of thumbDirs) {
      if (!fs.existsSync(dir)) continue;
      const candidates = [
        { p: path.join(dir, `${id}.webp`), mime: 'image/webp' },
        { p: path.join(dir, `${id}.png`), mime: 'image/png' },
        { p: path.join(dir, `${id}.jpg`), mime: 'image/jpeg' },
        { p: path.join(dir, id.slice(0, 2), `${id}.webp`), mime: 'image/webp' },
      ];
      for (const c of candidates) {
        if (fs.existsSync(c.p)) return { path: c.p, mime: c.mime };
      }
    }
    return null;
  }

  function getCatalog(): (CatalogFile & { filePath?: string })[] {
    const list: (CatalogFile & { filePath?: string })[] = [];
    const seenIds = new Set<string>();

    const dbPaths = [teledriveJsonPath, teledriveDbJsonPath];
    for (const p of dbPaths) {
      if (!fs.existsSync(p)) continue;
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const db = JSON.parse(raw) as { files?: Record<string, unknown>[] };
        for (const f of db.files || []) {
          if ((f.category === 'video' || f.category === 'audio') && !f.trashed_at) {
            const id = String(f.id);
            if (seenIds.has(id)) continue;
            seenIds.add(id);

            const hasThumb = Boolean(f.has_thumbnail) || Boolean(findThumbnail(id));
            let meta: Record<string, unknown> = {};
            if (typeof f.metadata === 'string') {
              try { meta = JSON.parse(f.metadata); } catch {}
            } else if (f.metadata && typeof f.metadata === 'object') {
              meta = f.metadata as Record<string, unknown>;
            }

            list.push({
              id,
              name: String(f.name ?? 'Untitled'),
              category: f.category as 'video' | 'audio',
              mimeType: String(f.mime_type || (f.category === 'video' ? 'video/mp4' : 'audio/mpeg')),
              size: Number(f.size) || 0,
              duration: typeof f.duration === 'number' ? f.duration : null,
              hasThumbnail: hasThumb,
              updatedAt: Number(f.updated_at) || Date.now(),
              artist: typeof meta.artist === 'string' ? meta.artist : '',
              album: typeof meta.album === 'string' ? meta.album : '',
              description: typeof f.description === 'string' ? f.description : '',
            });
          }
        }
      } catch (e) {
        console.error('[Stream Dev Plugin] Error reading database:', e);
      }
    }

    // Audio tracks for the music room
    const audio1Path = path.join(audioDir, 'ambient_dreamscape.wav');
    if (fs.existsSync(audio1Path)) {
      const id = 'a1111111-1111-4111-a111-111111111111';
      if (!seenIds.has(id)) {
        seenIds.add(id);
        const stat = fs.statSync(audio1Path);
        list.push({
          id,
          name: 'Ambient Dreamscape.wav',
          category: 'audio',
          mimeType: 'audio/wav',
          size: stat.size,
          duration: 30,
          hasThumbnail: false,
          updatedAt: stat.mtimeMs,
          artist: 'TeleDrive Soundscapes',
          album: 'Folio Studio Sessions',
          description: 'Multi-harmonic ambient progression streamed directly in high fidelity.',
          filePath: audio1Path,
        });
      }
    }

    const audio2Path = path.join(audioDir, 'midnight_lofi.wav');
    if (fs.existsSync(audio2Path)) {
      const id = 'b2222222-2222-4222-b222-222222222222';
      if (!seenIds.has(id)) {
        seenIds.add(id);
        const stat = fs.statSync(audio2Path);
        list.push({
          id,
          name: 'Midnight Lo-Fi.wav',
          category: 'audio',
          mimeType: 'audio/wav',
          size: stat.size,
          duration: 24,
          hasThumbnail: false,
          updatedAt: stat.mtimeMs,
          artist: 'Aurora Node',
          album: 'TeleDrive Cloud',
          description: 'Warm nocturnal chords with subtle stereo panning and gentle acoustic decay.',
          filePath: audio2Path,
        });
      }
    }

    return list;
  }

  function resolveMediaFile(item: CatalogFile & { filePath?: string }): string | null {
    if (item.filePath && fs.existsSync(item.filePath)) return item.filePath;
    const searchDirs = [
      '/mnt/c/Users/Kailasnath T/Videos/extracted_videos',
      '/mnt/c/Users/Kailasnath T/Videos',
      '/mnt/c/Users/Kailasnath T/Downloads',
      '/mnt/c/Users/Kailasnath T/Desktop',
      '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/vault/files',
      '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/cache',
      audioDir,
    ];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const directByName = path.join(dir, item.name);
      if (fs.existsSync(directByName)) return directByName;
      const directById = path.join(dir, item.id);
      if (fs.existsSync(directById)) return directById;
    }
    return null;
  }

  return {
    name: 'teledrive-stream-dev-plugin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
        const pathname = parsedUrl.pathname;

        if (pathname === '/api/catalog') {
          const type = parsedUrl.searchParams.get('type') ?? 'all';
          const query = (parsedUrl.searchParams.get('q') ?? '').trim().toLowerCase();

          const allItems = getCatalog();
          const filtered = allItems.filter((item) => {
            if (type !== 'all' && item.category !== type) return false;
            if (query) {
              const text = `${item.name} ${item.artist} ${item.album} ${item.description}`.toLowerCase();
              if (!text.includes(query)) return false;
            }
            return true;
          });

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, private',
          });
          res.end(JSON.stringify({ items: filtered }));
          return;
        }

        const artMatch = /^\/api\/art\/([^/]+)$/.exec(pathname);
        if (artMatch) {
          const id = artMatch[1];
          const thumb = findThumbnail(id);
          if (!thumb) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Artwork unavailable' }));
            return;
          }
          res.writeHead(200, {
            'Content-Type': thumb.mime,
            'Cache-Control': 'public, max-age=3600',
          });
          fs.createReadStream(thumb.path).pipe(res);
          return;
        }

        const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(pathname);
        if (mediaMatch) {
          const id = mediaMatch[1];
          const catalog = getCatalog();
          const item = catalog.find((x) => x.id === id);
          if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Media not found' }));
            return;
          }

          const resolvedPath = resolveMediaFile(item);
          if (!resolvedPath) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Media content file not available on disk' }));
            return;
          }

          const stat = fs.statSync(resolvedPath);
          const fileSize = stat.size;
          const range = req.headers.range;
          const mimeType = item.mimeType || 'video/mp4';

          if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            let start = parseInt(parts[0], 10);
            let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (isNaN(start)) {
              start = fileSize - end;
              end = fileSize - 1;
            }
            if (isNaN(end) || end >= fileSize) {
              end = fileSize - 1;
            }

            if (start > end || start >= fileSize || start < 0) {
              res.writeHead(416, {
                'Content-Range': `bytes */${fileSize}`,
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ error: 'Range Not Satisfiable' }));
              return;
            }

            const chunkSize = end - start + 1;
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize,
              'Content-Type': mimeType,
              'Cache-Control': 'no-cache',
              'X-Content-Type-Options': 'nosniff',
            });
            fs.createReadStream(resolvedPath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Length': fileSize,
              'Content-Type': mimeType,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache',
              'X-Content-Type-Options': 'nosniff',
            });
            fs.createReadStream(resolvedPath).pipe(res);
          }
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [localStreamDevPlugin()],
  server: {
    port: 5174,
    host: '0.0.0.0',
    strictPort: true,
  },
  build: { outDir: 'dist' },
});
