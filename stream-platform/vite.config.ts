import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { posterSvg } from './src/poster.ts';
import { cleanTitle } from './src/title.ts';

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

    // Load from catalog.json if available
    const catalogJsonPath = path.join(__dirname, 'public/catalog.json');
    if (fs.existsSync(catalogJsonPath)) {
      try {
        const raw = fs.readFileSync(catalogJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const parsedItems = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
        for (const it of parsedItems) {
          if (it.id && !seenIds.has(it.id)) {
            seenIds.add(it.id);
            list.push({
              id: it.id,
              name: it.name || 'Untitled',
              category: it.category as 'video' | 'audio',
              mimeType: it.mimeType || (it.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
              size: Number(it.size) || 0,
              duration: typeof it.duration === 'number' ? it.duration : null,
              hasThumbnail: Boolean(it.hasThumbnail) || Boolean(findThumbnail(it.id)),
              updatedAt: Number(it.updatedAt) || Date.now(),
              artist: typeof it.artist === 'string' ? it.artist : '',
              album: typeof it.album === 'string' ? it.album : '',
              description: typeof it.description === 'string' ? it.description : '',
            });
          }
        }
      } catch (e) {
        console.error('[Stream Dev Plugin] Error reading catalog.json:', e);
      }
    }

    if (fs.existsSync(teledriveJsonPath)) {
      try {
        const raw = fs.readFileSync(teledriveJsonPath, 'utf8');
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

    ];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;

      // Match MP4 counterpart if available
      const mp4ByName = path.join(dir, item.name.replace(/\.[^.]+$/, '.mp4'));
      if (fs.existsSync(mp4ByName)) return mp4ByName;

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
            const item = getCatalog().find((entry) => entry.id === id);
            if (!item) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Artwork unavailable' }));
              return;
            }
            const audio = item.category === 'audio';
            const subtitle = audio
              ? [item.artist, item.album].filter(Boolean).join(' · ')
              : 'Private library';
            const svg = posterSvg({
              seed: item.id,
              title: cleanTitle(item.name) || 'Untitled',
              subtitle,
              label: audio ? 'Album' : 'Film',
              category: item.category,
              shape: audio ? 'square' : 'wide',
            });
            res.writeHead(200, {
              'Content-Type': 'image/svg+xml; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
            });
            res.end(svg);
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

          const isDownload = parsedUrl.searchParams.get('download') === '1';

          // If downloading, ALWAYS send the full original file as an attachment
          if (isDownload) {
            streamLocalStaticFile(resolvedPath, item.name, true);
            return;
          }

          // Check if an already converted MP4 counterpart exists and has completed faststart (moov atom)
          const mp4Candidate = resolvedPath.replace(/\.mkv$/i, '.mp4');
          if (mp4Candidate !== resolvedPath && fs.existsSync(mp4Candidate)) {
            try {
              const fd = fs.openSync(mp4Candidate, 'r');
              const buf = Buffer.alloc(32768);
              const readBytes = fs.readSync(fd, buf, 0, 32768, 0);
              fs.closeSync(fd);
              if (readBytes > 100 && buf.includes('moov')) {
                // Completed faststart MP4 available! Stream directly with HTTP 206 Range requests
                streamLocalStaticFile(mp4Candidate, item.name.replace(/\.mkv$/i, '.mp4'), false, 'video/mp4');
                return;
              }
            } catch {}
          }

          // If file is already MP4 or WebM (browser-native)
          const lowerName = resolvedPath.toLowerCase();
          if (lowerName.endsWith('.mp4') || lowerName.endsWith('.webm')) {
            streamLocalStaticFile(resolvedPath, item.name, false, lowerName.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
            return;
          }

          // For MKV files with multi-channel EAC3 / DTS audio:
          // Stream the actual movie on-the-fly using ffmpeg transmuxing (copying video, converting audio to AAC)
          const ffmpegHome = path.join(process.env.HOME || '/home/Kailasnath', '.local/bin/ffmpeg');
          const ffmpegBin = fs.existsSync(ffmpegHome) ? ffmpegHome : 'ffmpeg';

          if (lowerName.endsWith('.mkv')) {
            const timeParam = parseFloat(parsedUrl.searchParams.get('t') ?? '0') || 0;
            const args = [
              '-hide_banner',
              '-loglevel', 'error',
              ...(timeParam > 0 ? ['-ss', String(timeParam)] : []),
              '-i', resolvedPath,
              '-map', '0:v:0',
              '-map', '0:a:0',
              '-c:v', 'copy',
              '-c:a', 'aac',
              '-b:a', '192k',
              '-f', 'mp4',
              '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
              'pipe:1',
            ];

            res.writeHead(200, {
              'Content-Type': 'video/mp4',
              'Cache-Control': 'no-cache, no-store',
              'Access-Control-Allow-Origin': '*',
              'X-Content-Type-Options': 'nosniff',
            });

            const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
            proc.stdout.pipe(res);

            req.on('close', () => {
              proc.kill('SIGKILL');
            });
            return;
          }

          function streamLocalStaticFile(filePath: string, fileName: string, asDownload = false, customMime?: string) {
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;
            const mimeType = asDownload
              ? 'application/octet-stream'
              : (customMime || item.mimeType || 'video/mp4');

            const dispositionHeaders: Record<string, string> = {};
            if (asDownload) {
              dispositionHeaders['Content-Disposition'] = `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
            }

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
                'Content-Length': String(chunkSize),
                'Content-Type': mimeType,
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                ...dispositionHeaders,
              });
              fs.createReadStream(filePath, { start, end }).pipe(res);
            } else {
              res.writeHead(200, {
                'Content-Length': String(fileSize),
                'Content-Type': mimeType,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                ...dispositionHeaders,
              });
              fs.createReadStream(filePath).pipe(res);
            }
          }

          streamLocalStaticFile(resolvedPath, item.name, false, item.mimeType || 'video/mp4');
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
