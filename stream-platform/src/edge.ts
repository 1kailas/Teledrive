import { posterSvg } from './poster';
import { cleanTitle } from './title';

export interface EdgeEnv {
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  TELEDRIVE_ORIGIN?: string;
  ORIGIN_CLIENT_ID?: string;
  ORIGIN_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  BOT_TOKENS?: string; // JSON or comma/newline/space separated bot tokens
  TELEGRAM_BOT_API_URL?: string;
  LOCAL_BOT_API_URL?: string;
  TELEGRAM_API_URL?: string;
  TELEDRIVE_CATALOG?: string; // JSON: CatalogFile[]
  CATALOG_JSON?: string;
  ALLOW_PUBLIC?: string;
  VIEWER_PASSWORD?: string;
  TELEDRIVE_KV?: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
  };
  ASSETS?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

type Fetcher = typeof fetch;
type AccessJwk = JsonWebKey & { kid?: string };

export type CatalogPart = {
  partIndex: number;
  size: number;
  telegramFileId?: string;
  botId?: string;
};

export type CatalogFile = {
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
  parts?: CatalogPart[];
  thumbnailTelegramFileId?: string;
  episodeNumber?: number;
  seasonNumber?: number;
  seriesId?: string;
  seriesName?: string;
  episodeTitle?: string;
};

export type SeasonFile = {
  seasonNumber: number;
  name: string;
  episodes: CatalogFile[];
};

export type SeriesFile = {
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
};

export type StandaloneCatalog = {
  items: CatalogFile[];
  series?: SeriesFile[];
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
let cachedKeys: { team: string; keys: AccessJwk[]; until: number } | undefined;
const filePathCache = new Map<string, { path: string; token: string; expires: number }>();
let cachedStandaloneCatalog: { data: StandaloneCatalog; expires: number } | null = null;

/**
 * Deterministic SVG cover used whenever a media item has no stored thumbnail.
 * Keeping this on the edge means every artwork URL resolves, even when the
 * Telegram thumbnail was never generated or has expired.
 */
function generatedArtwork(file: CatalogFile): Response {
  const audio = file.category === 'audio';
  const title = cleanTitle(file.name) || 'Untitled';
  const subtitle = audio
    ? [file.artist, file.album].filter(Boolean).join(' · ')
    : [file.format, 'Private library'].filter(Boolean).join(' · ');
  const svg = posterSvg({
    seed: file.id,
    title,
    subtitle,
    label: audio ? 'Album' : 'Film',
    category: file.category,
    shape: audio ? 'square' : 'wide',
  });
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function detectMimeType(fileName: string, category: 'video' | 'audio'): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    // Video containers
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
    // Audio containers
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    weba: 'audio/webm',
    wma: 'audio/x-ms-wma',
  };
  return map[ext] ?? (category === 'video' ? 'video/mp4' : 'audio/mpeg');
}

async function verifyAccess(request: Request, env: EdgeEnv, fetcher: Fetcher): Promise<boolean> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return true;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16_384) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(Boolean)) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]!))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]!))) as {
      iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string;
    };
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`
      || !(Array.isArray(claims.aud) ? claims.aud.includes(env.ACCESS_AUD) : claims.aud === env.ACCESS_AUD)
      || !claims.exp || claims.exp <= now || (claims.nbf !== undefined && claims.nbf > now)
      || !claims.email) return false;

    if (!cachedKeys || cachedKeys.team !== env.ACCESS_TEAM || cachedKeys.until <= Date.now()
      || !cachedKeys.keys.some((key) => key.kid === header.kid)) {
      const certs = await fetcher(`${claims.iss}/cdn-cgi/access/certs`, { redirect: 'error' });
      if (!certs.ok) return false;
      const payload = await certs.json() as { keys?: AccessJwk[] };
      if (!Array.isArray(payload.keys)) return false;
      cachedKeys = { team: env.ACCESS_TEAM, keys: payload.keys, until: Date.now() + 5 * 60_000 };
    }
    const jwk = cachedKeys.keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

function originRequest(env: EdgeEnv, path: string, fetcher: Fetcher, range?: string, media = false): Promise<Response> {
  const headers = new Headers({
    'CF-Access-Client-Id': env.ORIGIN_CLIENT_ID ?? '',
    'CF-Access-Client-Secret': env.ORIGIN_CLIENT_SECRET ?? '',
    Accept: media ? '*/*' : 'application/json',
  });
  if (range) headers.set('Range', range);
  return fetcher(new URL(path, env.TELEDRIVE_ORIGIN!), { headers, redirect: 'manual', cache: 'no-store' });
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function getMediaFromOrigin(id: string, env: EdgeEnv, fetcher: Fetcher): Promise<{ file: Record<string, unknown> } | null> {
  const response = await originRequest(env, `/api/files/${id}`, fetcher);
  if (!response.ok) return null;
  const data = await response.json() as { file?: Record<string, unknown> };
  const file = data.file;
  if (!file || file.id !== id || file.status !== 'ready' || file.trashedAt
    || !['video', 'audio'].includes(String(file.category))
    || !String(file.mimeType).startsWith(`${file.category}/`)) return null;
  return { file };
}

function cleanCatalog(file: Record<string, unknown>, category: 'video' | 'audio'): CatalogFile | null {
  if (!ID.test(String(file.id)) || file.category !== category || file.status !== 'ready' || file.trashedAt
    || !String(file.mimeType).startsWith(`${category}/`)) return null;
  const metadata = file.metadata && typeof file.metadata === 'object'
    ? file.metadata as Record<string, unknown> : {};
  return {
    id: String(file.id),
    name: String(file.name ?? 'Untitled'),
    category,
    mimeType: String(file.mimeType || detectMimeType(String(file.name), category)),
    size: Number(file.size) || 0,
    duration: typeof file.duration === 'number' ? file.duration : null,
    hasThumbnail: file.hasThumbnail === true,
    updatedAt: Number(file.updatedAt) || 0,
    artist: typeof metadata.artist === 'string' ? metadata.artist : '',
    album: typeof metadata.album === 'string' ? metadata.album : '',
    description: typeof file.description === 'string' ? file.description : '',
  };
}

async function readCatalogFromOrigin(response: Response): Promise<{ files?: Record<string, unknown>[] }> {
  if (Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES || !response.body)
    throw new Error('catalog too large');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error('catalog too large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text + decoder.decode()) as { files?: Record<string, unknown>[] };
}

function getAllBotTokens(env: EdgeEnv): { token: string; botId: string }[] {
  const result: { token: string; botId: string }[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const clean = raw.replace(/^["']|["']$/g, '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      const botId = clean.includes(':') ? clean.split(':')[0]! : clean;
      result.push({ token: clean, botId });
    }
  };

  if (env.BOT_TOKENS) {
    try {
      const parsed = JSON.parse(env.BOT_TOKENS);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') add(item);
        }
      } else if (typeof parsed === 'object' && parsed !== null) {
        for (const v of Object.values(parsed)) {
          if (typeof v === 'string') add(v);
        }
      }
    } catch {
      for (const part of env.BOT_TOKENS.split(/[\s,;\n\r]+/)) {
        add(part);
      }
    }
  }

  if (env.TELEGRAM_BOT_TOKEN) {
    for (const part of env.TELEGRAM_BOT_TOKEN.split(/[\s,;\n\r]+/)) {
      add(part);
    }
  }

  return result;
}

async function resolveTelegramFile(
  fileId: string,
  preferredBotId: string | undefined,
  env: EdgeEnv,
  fetcher: Fetcher
): Promise<{ path: string; token: string } | null> {
  const cached = filePathCache.get(fileId);
  if (cached && cached.expires > Date.now()) {
    return { path: cached.path, token: cached.token };
  }

  const allBots = getAllBotTokens(env);
  if (allBots.length === 0) return null;

  const orderedBots = allBots.slice().sort((a, b) => {
    if (a.botId === preferredBotId) return -1;
    if (b.botId === preferredBotId) return 1;
    return 0;
  });

  const apiBase = (env.LOCAL_BOT_API_URL || env.TELEGRAM_BOT_API_URL || env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');

  for (const bot of orderedBots) {
    try {
      const res = await fetcher(`${apiBase}/bot${bot.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!res.ok) continue;
      const data = await res.json() as { ok?: boolean; result?: { file_path?: string } };
      if (data.ok && data.result?.file_path) {
        const found = { path: data.result.file_path, token: bot.token };
        filePathCache.set(fileId, { ...found, expires: Date.now() + 3600_000 });
        return found;
      }
    } catch {
      // try next bot token
    }
  }

  return null;
}

async function fetchTelegramChunk(
  fileId: string,
  preferredBotId: string | undefined,
  partStart: number,
  partEnd: number,
  env: EdgeEnv,
  fetcher: Fetcher
): Promise<Response | null> {
  const allBots = getAllBotTokens(env);
  const apiBase = (env.LOCAL_BOT_API_URL || env.TELEGRAM_BOT_API_URL || env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');

  const info = await resolveTelegramFile(fileId, preferredBotId, env, fetcher);
  if (info) {
    const url = `${apiBase}/file/bot${info.token}/${info.path}`;
    try {
      const res = await fetcher(url, {
        headers: {
          Range: `bytes=${partStart}-${partEnd}`,
        },
      });
      if ([200, 206].includes(res.status)) return res;
      if ([401, 404, 429].includes(res.status)) {
        filePathCache.delete(fileId);
      }
    } catch {
      filePathCache.delete(fileId);
    }
  }

  // Fallback & failover across all bots configured in BOT_TOKENS
  filePathCache.delete(fileId);
  const orderedBots = allBots.slice().sort((a, b) => {
    if (a.botId === preferredBotId) return -1;
    if (b.botId === preferredBotId) return 1;
    return 0;
  });

  for (const bot of orderedBots) {
    if (info && bot.token === info.token) continue;
    try {
      const getFileRes = await fetcher(`${apiBase}/bot${bot.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!getFileRes.ok) continue;
      const data = await getFileRes.json() as { ok?: boolean; result?: { file_path?: string } };
      if (!data.ok || !data.result?.file_path) continue;

      const path = data.result.file_path;
      const url = `${apiBase}/file/bot${bot.token}/${path}`;
      const res = await fetcher(url, {
        headers: {
          Range: `bytes=${partStart}-${partEnd}`,
        },
      });
      if ([200, 206].includes(res.status)) {
        filePathCache.set(fileId, { path, token: bot.token, expires: Date.now() + 3600_000 });
        return res;
      }
    } catch {
      // try next bot
    }
  }

  return null;
}

function parseCatalogPayload(payload: unknown): StandaloneCatalog {
  if (!payload || typeof payload !== 'object') return { items: [] };

  if (Array.isArray(payload)) {
    return { items: payload as CatalogFile[] };
  }

  const obj = payload as { items?: CatalogFile[]; series?: SeriesFile[] };
  return {
    items: Array.isArray(obj.items) ? obj.items : [],
    series: Array.isArray(obj.series) ? obj.series : [],
  };
}

function findMediaInCatalog(catalog: StandaloneCatalog, id: string): CatalogFile | null {
  const item = catalog.items.find((x) => x.id === id);
  if (item) return item;
  if (catalog.series) {
    for (const s of catalog.series) {
      for (const season of s.seasons) {
        const ep = season.episodes.find((e) => e.id === id);
        if (ep) return ep;
      }
    }
  }
  return null;
}

async function loadStandaloneCatalog(request: Request, env: EdgeEnv, fetcher: Fetcher): Promise<StandaloneCatalog> {
  if (env.TELEDRIVE_CATALOG) {
    try {
      const parsed = parseCatalogPayload(JSON.parse(env.TELEDRIVE_CATALOG));
      if (parsed.items.length > 0 || (parsed.series && parsed.series.length > 0)) return parsed;
    } catch {}
  }
  if (env.CATALOG_JSON) {
    try {
      const parsed = parseCatalogPayload(JSON.parse(env.CATALOG_JSON));
      if (parsed.items.length > 0 || (parsed.series && parsed.series.length > 0)) return parsed;
    } catch {}
  }
  if (env.TELEDRIVE_KV) {
    try {
      const raw = await env.TELEDRIVE_KV.get('catalog');
      if (raw) {
        const parsed = parseCatalogPayload(JSON.parse(raw));
        if (parsed.items.length > 0 || (parsed.series && parsed.series.length > 0)) return parsed;
      }
    } catch {}
  }

  // In-memory cache for static fetch
  if (cachedStandaloneCatalog && cachedStandaloneCatalog.expires > Date.now()) {
    return cachedStandaloneCatalog.data;
  }

  // Try Cloudflare Pages ASSETS binding
  if (env.ASSETS) {
    try {
      const staticUrl = new URL('/catalog.json', request.url);
      const res = await env.ASSETS.fetch(staticUrl);
      if (res.ok) {
        const parsed = await res.json();
        const data = parseCatalogPayload(parsed);
        if (data.items.length > 0 || (data.series && data.series.length > 0)) {
          cachedStandaloneCatalog = { data, expires: Date.now() + 60_000 };
          return data;
        }
      }
    } catch {}
  }

  // Try static /catalog.json from Pages deployment
  try {
    const staticUrl = new URL('/catalog.json', request.url);
    const res = await fetcher(staticUrl);
    if (res.ok) {
      const parsed = await res.json();
      const data = parseCatalogPayload(parsed);
      if (data.items.length > 0 || (data.series && data.series.length > 0)) {
        cachedStandaloneCatalog = { data, expires: Date.now() + 60_000 };
        return data;
      }
    }
  } catch {}

  return { items: [] };
}

export async function handleApi(request: Request, env: EdgeEnv, fetcher: Fetcher = fetch): Promise<Response> {
  // CORS Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization, cf-access-jwt-assertion, X-Requested-With',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return error(405, 'Read-only gateway');
  }

  const isHead = request.method === 'HEAD';
  const withHead = (res: Response): Response =>
    isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;

  const isOriginMode = Boolean(env.TELEDRIVE_ORIGIN);

  // Validate origin mode configuration
  if (isOriginMode) {
    if (!env.ACCESS_TEAM || !/^[a-z0-9-]+$/.test(env.ACCESS_TEAM) || !env.ACCESS_AUD
      || !env.ORIGIN_CLIENT_ID || !env.ORIGIN_CLIENT_SECRET) {
      return error(503, 'Streaming gateway is not configured');
    }
    let origin: URL;
    try {
      origin = new URL(env.TELEDRIVE_ORIGIN!);
      if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
        || origin.username || origin.password) throw new Error('invalid origin');
    } catch {
      return error(503, 'Streaming gateway origin is invalid');
    }
  } else {
    // Standalone mode: requires at least telegram bot token, catalog, or public mode
    const hasStandaloneCreds = Boolean(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKENS || env.TELEDRIVE_CATALOG || env.CATALOG_JSON || env.ALLOW_PUBLIC);
    if (!hasStandaloneCreds && !env.ACCESS_TEAM) {
      return error(503, 'Streaming gateway is not configured');
    }
  }

  // Access validation (mandatory if ACCESS_TEAM & ACCESS_AUD are configured)
  if (env.ACCESS_TEAM && env.ACCESS_AUD) {
    if (!await verifyAccess(request, env, fetcher)) return error(401, 'Sign in with Cloudflare Access');
  }

  const url = new URL(request.url);

  try {
    // CATALOG ENDPOINT
    if (url.pathname === '/api/catalog') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const type = url.searchParams.get('type') ?? 'all';
      if (query.length > 120 || !['all', 'video', 'audio'].includes(type)) return error(400, 'Invalid catalog filter');

      if (isOriginMode) {
        const categories = (type === 'all' ? ['video', 'audio'] : [type]) as ('video' | 'audio')[];
        const lists = await Promise.all(categories.map(async (category) => {
          const params = new URLSearchParams({ category, q: query });
          const response = await originRequest(env, `/api/search?${params}`, fetcher);
          if (!response.ok) throw new Error('catalog unavailable');
          const data = await readCatalogFromOrigin(response);
          if (!Array.isArray(data.files)) throw new Error('invalid catalog');
          return data.files.map((file) => cleanCatalog(file, category))
            .filter((file): file is CatalogFile => file !== null);
        }));
        return withHead(Response.json({ items: lists.flat() }, {
          headers: {
            'Cache-Control': 'private, no-store',
            'Access-Control-Allow-Origin': '*',
          },
        }));
      }

      // Standalone Cloudflare mode
      const standalone = await loadStandaloneCatalog(request, env, fetcher);
      const filtered = standalone.items.filter((item) => {
        if (!item || !item.id || !ID.test(item.id)) return false;
        if (type !== 'all' && item.category !== type) return false;
        if (query) {
          const text = `${item.name} ${item.artist} ${item.album} ${item.description}`.toLowerCase();
          if (!text.includes(query)) return false;
        }
        return true;
      });
      const filteredSeries = (standalone.series ?? []).filter((s) => {
        if (type === 'audio') return false;
        if (query) {
          const text = `${s.name} ${s.description} ${s.genres?.join(' ')}`.toLowerCase();
          if (!text.includes(query)) return false;
        }
        return true;
      });
      return withHead(Response.json({ items: filtered, series: filteredSeries }, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Access-Control-Allow-Origin': '*',
        },
      }));
    }

    // MEDIA OR ARTWORK ENDPOINT
    const match = /^\/api\/(media|art)\/([^/]+)$/.exec(url.pathname);
    if (!match) return error(404, 'Not found');
    const [, kind, id] = match;
    if (!id || !ID.test(id)) return error(404, 'Not found');

    const range = request.headers.get('Range');
    if (kind === 'media' && range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
      return error(416, 'Unsupported range');
    }

    if (isOriginMode) {
      const record = await getMediaFromOrigin(id, env, fetcher);
      if (!record) return error(404, 'Media not found');
      const artworkFile = kind === 'art'
        ? cleanCatalog(record.file, record.file.category as 'video' | 'audio')
        : null;
      if (kind === 'art' && (!artworkFile || record.file.hasThumbnail !== true)) {
        return artworkFile ? withHead(generatedArtwork(artworkFile)) : error(404, 'Artwork unavailable');
      }

      const response = await originRequest(env,
        kind === 'art' ? `/api/thumbnails/${id}` : `/api/files/${id}/content`,
        fetcher, kind === 'media' ? range ?? undefined : undefined, true);
      if (kind === 'art' && response.status === 404 && artworkFile) {
        return withHead(generatedArtwork(artworkFile));
      }
      if (![200, 206, 416, 404].includes(response.status)) return error(502, 'TeleDrive stream unavailable');

      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Access-Control-Allow-Origin': '*',
      });
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (kind === 'media' && response.ok) headers.set('Content-Type', String(record.file.mimeType));
      return withHead(new Response(isHead ? null : response.body, { status: response.status, headers }));
    }

    // Standalone Direct Telegram Mode
    const catalog = await loadStandaloneCatalog(request, env, fetcher);
    const item = findMediaInCatalog(catalog, id);
    if (!item) return error(404, 'Media not found');

    if (kind === 'art') {
      if (!item.hasThumbnail) return withHead(generatedArtwork(item));
      if (item.thumbnailTelegramFileId) {
        const resolved = await resolveTelegramFile(item.thumbnailTelegramFileId, undefined, env, fetcher);
        if (resolved) {
          const apiBase = (env.TELEGRAM_BOT_API_URL || env.TELEGRAM_API_URL || env.LOCAL_BOT_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
          const artRes = await fetcher(`${apiBase}/file/bot${resolved.token}/${resolved.path}`);
          if (artRes.ok) {
            return withHead(new Response(isHead ? null : artRes.body, {
              status: 200,
              headers: {
                'Content-Type': artRes.headers.get('content-type') || 'image/webp',
                'Cache-Control': 'public, max-age=86400',
                'X-Content-Type-Options': 'nosniff',
                'Access-Control-Allow-Origin': '*',
              },
            }));
          }
        }
      }
      return withHead(generatedArtwork(item));
    }

    // kind === 'media' direct streaming
    const parts = item.parts && item.parts.length > 0 ? item.parts : [];
    if (!parts.length) return error(404, 'Media stream unavailable');

    // Build byte offsets for all parts
    let cumulative = 0;
    const mappedParts = parts.map((p) => {
      const offset = cumulative;
      cumulative += p.size;
      return {
        partIndex: p.partIndex,
        size: p.size,
        telegramFileId: p.telegramFileId,
        botId: p.botId,
        offset,
        end: offset + p.size - 1,
      };
    });
    const totalSize = (item.size && item.size > 0) ? item.size : cumulative;
    const isDownload = url.searchParams.get('download') === '1';

    // Parse Range header if present
    let start = 0;
    let end = totalSize - 1;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${totalSize}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      const [, a, b] = match;
      if (a === '' && b === '') {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${totalSize}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      if (a === '') {
        const suffix = parseInt(b!, 10);
        if (suffix <= 0) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': `bytes */${totalSize}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
        start = Math.max(0, totalSize - suffix);
        end = totalSize - 1;
      } else {
        start = parseInt(a!, 10);
        if (b === '') {
          if (!isDownload) {
            const startPart = mappedParts.find((p) => p.offset <= start && p.end >= start);
            end = startPart ? Math.min(totalSize - 1, startPart.end) : Math.min(totalSize - 1, start + 20 * 1024 * 1024 - 1);
          } else {
            end = totalSize - 1;
          }
        } else {
          end = Math.min(totalSize - 1, parseInt(b!, 10));
          if (!isDownload && end - start + 1 > 25 * 1024 * 1024) {
            end = start + 25 * 1024 * 1024 - 1;
          }
        }
      }
    } else if (!isDownload && mappedParts.length > 0) {
      // Browsers or media players requesting without an explicit Range header
      start = 0;
      end = Math.min(totalSize - 1, mappedParts[0]?.end ?? (20 * 1024 * 1024 - 1));
    }

    if (start >= totalSize || start > end) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Determine overlapping parts
    const overlappingParts = mappedParts.filter((p) => p.end >= start && p.offset <= end);
    if (overlappingParts.length === 0) {
      return error(404, 'No media chunks found for requested range');
    }

    const reqFormat = url.searchParams.get('format');
    let mimeType = item.mimeType || detectMimeType(item.name, item.category);
    if (reqFormat === 'mp4') mimeType = 'video/mp4';
    else if (reqFormat === 'webm') mimeType = 'video/webm';

    // Fast path: if single part request (e.g. seeking or small range query)
    if (overlappingParts.length === 1) {
      const targetPart = overlappingParts[0]!;
      if (!targetPart.telegramFileId) return error(502, 'Telegram file reference missing');
      const partStart = Math.max(0, start - targetPart.offset);
      const partEnd = Math.min(targetPart.size - 1, end - targetPart.offset);
      const chunkLen = partEnd - partStart + 1;

      const tgRes = await fetchTelegramChunk(targetPart.telegramFileId, targetPart.botId, partStart, partEnd, env, fetcher);
      if (!tgRes || !tgRes.body) {
        return error(502, 'Failed to fetch media chunk from Telegram Bot API');
      }

      const headers = new Headers({
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Content-Range': `bytes ${start}-${start + chunkLen - 1}/${totalSize}`,
        'Content-Length': String(chunkLen),
      });
      const etag = tgRes.headers.get('etag');
      if (etag) headers.set('etag', etag);

      if (isDownload) {
        headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(item.name)}"; filename*=UTF-8''${encodeURIComponent(item.name)}`);
      }

      return withHead(new Response(isHead ? null : tgRes.body, { status: 206, headers }));
    }

    // Continuous multi-part streaming pipeline across part boundaries
    const totalChunkLength = end - start + 1;
    let partCursor = 0;

    const multiStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (partCursor >= overlappingParts.length) {
          controller.close();
          return;
        }

        const currentPart = overlappingParts[partCursor]!;
        partCursor += 1;

        if (!currentPart.telegramFileId) {
          controller.error(new Error(`Missing telegramFileId for part ${currentPart.partIndex}`));
          return;
        }

        const partStart = Math.max(0, start - currentPart.offset);
        const partEnd = Math.min(currentPart.size - 1, end - currentPart.offset);

        const tgRes = await fetchTelegramChunk(currentPart.telegramFileId, currentPart.botId, partStart, partEnd, env, fetcher);
        if (!tgRes || !tgRes.body) {
          controller.error(new Error(`Telegram stream error on part ${currentPart.partIndex}`));
          return;
        }

        const reader = tgRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }
      },
    });

    const headers = new Headers({
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(totalChunkLength),
    });

    if (isDownload) {
      headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(item.name)}"; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    }

    return withHead(new Response(isHead ? null : multiStream, { status: 206, headers }));
  } catch {
    return error(502, 'TeleDrive is offline or the origin is unavailable');
  }
}
