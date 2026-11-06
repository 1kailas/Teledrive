export interface EdgeEnv {
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  TELEDRIVE_ORIGIN?: string;
  ORIGIN_CLIENT_ID?: string;
  ORIGIN_CLIENT_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  BOT_TOKENS?: string; // JSON: Record<string, string>
  TELEDRIVE_CATALOG?: string; // JSON: CatalogFile[]
  CATALOG_JSON?: string;
  ALLOW_PUBLIC?: string;
  VIEWER_PASSWORD?: string;
  TELEDRIVE_KV?: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
  };
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
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
let cachedKeys: { team: string; keys: AccessJwk[]; until: number } | undefined;
const filePathCache = new Map<string, { path: string; expires: number }>();

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

function getBotToken(botId: string | undefined, env: EdgeEnv): string | undefined {
  const map = new Map<string, string>();

  // 1. Check if BOT_TOKENS is JSON object
  if (env.BOT_TOKENS) {
    try {
      const json = JSON.parse(env.BOT_TOKENS) as Record<string, string>;
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string' && v.includes(':')) {
          map.set(k, v.trim());
          map.set(v.trim().split(':')[0]!, v.trim());
        }
      }
    } catch {}
  }

  // 2. Parse comma, space, or newline-separated tokens from BOT_TOKENS or TELEGRAM_BOT_TOKEN
  const rawSources = [env.BOT_TOKENS, env.TELEGRAM_BOT_TOKEN].filter(Boolean).join(',');
  const tokens = rawSources.split(/[\s,;\n\r]+/).map((t) => t.trim()).filter((t) => t.includes(':'));
  for (const t of tokens) {
    const id = t.split(':')[0]!;
    if (!map.has(id)) map.set(id, t);
    if (!map.has('default')) map.set('default', t);
  }

  if (botId && map.has(botId)) return map.get(botId);
  return map.get('default') || tokens[0] || env.TELEGRAM_BOT_TOKEN;
}

async function getTelegramFilePath(fileId: string, botToken: string, fetcher: Fetcher): Promise<string | null> {
  const cached = filePathCache.get(fileId);
  if (cached && cached.expires > Date.now()) return cached.path;

  const res = await fetcher(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) return null;
  const data = await res.json() as { ok?: boolean; result?: { file_path?: string } };
  if (!data.ok || !data.result?.file_path) return null;
  filePathCache.set(fileId, { path: data.result.file_path, expires: Date.now() + 3600_000 });
  return data.result.file_path;
}

async function loadStandaloneCatalog(request: Request, env: EdgeEnv, fetcher: Fetcher): Promise<CatalogFile[]> {
  if (env.TELEDRIVE_CATALOG) {
    try {
      const parsed = JSON.parse(env.TELEDRIVE_CATALOG) as { items?: CatalogFile[] } | CatalogFile[];
      return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    } catch {}
  }
  if (env.CATALOG_JSON) {
    try {
      const parsed = JSON.parse(env.CATALOG_JSON) as { items?: CatalogFile[] } | CatalogFile[];
      return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    } catch {}
  }
  if (env.TELEDRIVE_KV) {
    try {
      const raw = await env.TELEDRIVE_KV.get('catalog');
      if (raw) {
        const parsed = JSON.parse(raw) as { items?: CatalogFile[] } | CatalogFile[];
        return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
      }
    } catch {}
  }
  // Try static /catalog.json from Pages deployment
  try {
    const staticUrl = new URL('/catalog.json', request.url);
    const res = await fetcher(staticUrl);
    if (res.ok) {
      const parsed = await res.json() as { items?: CatalogFile[] } | CatalogFile[];
      return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    }
  } catch {}
  return [];
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
      const filtered = standalone.filter((item) => {
        if (!item || !item.id || !ID.test(item.id)) return false;
        if (type !== 'all' && item.category !== type) return false;
        if (query) {
          const text = `${item.name} ${item.artist} ${item.album} ${item.description}`.toLowerCase();
          if (!text.includes(query)) return false;
        }
        return true;
      });
      return withHead(Response.json({ items: filtered }, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Access-Control-Allow-Origin': '*',
        },
      }));
    }

    // MEDIA OR ARTWORK ENDPOINT
    const match = /^\/api\/(media|art)\/([^/]+)$/.exec(url.pathname);
    if (!match || url.search) return error(404, 'Not found');
    const [, kind, id] = match;
    if (!id || !ID.test(id)) return error(404, 'Not found');

    const range = request.headers.get('Range');
    if (kind === 'media' && range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
      return error(416, 'Unsupported range');
    }

    if (isOriginMode) {
      const record = await getMediaFromOrigin(id, env, fetcher);
      if (!record) return error(404, 'Media not found');
      if (kind === 'art' && record.file.hasThumbnail !== true) return error(404, 'Artwork unavailable');

      const response = await originRequest(env,
        kind === 'art' ? `/api/thumbnails/${id}` : `/api/files/${id}/content`,
        fetcher, kind === 'media' ? range ?? undefined : undefined, true);
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
    const item = catalog.find((x) => x.id === id);
    if (!item) return error(404, 'Media not found');

    if (kind === 'art') {
      if (!item.hasThumbnail) return error(404, 'Artwork unavailable');
      if (item.thumbnailTelegramFileId) {
        const botToken = getBotToken(undefined, env);
        if (botToken) {
          const filePath = await getTelegramFilePath(item.thumbnailTelegramFileId, botToken, fetcher);
          if (filePath) {
            const artRes = await fetcher(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
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
      }
      return error(404, 'Artwork unavailable');
    }

    // kind === 'media' direct streaming
    const parts = item.parts && item.parts.length > 0 ? item.parts : [];
    if (!parts.length) return error(404, 'Media stream unavailable');

    const firstPart = parts[0]!;
    const botToken = getBotToken(firstPart.botId, env);
    if (!botToken || !firstPart.telegramFileId) return error(502, 'Streaming bot token not configured');

    const filePath = await getTelegramFilePath(firstPart.telegramFileId, botToken, fetcher);
    if (!filePath) return error(502, 'Failed to resolve Telegram file path');

    const streamHeaders: Record<string, string> = {};
    if (range) streamHeaders.Range = range;

    const tgStreamRes = await fetcher(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
      headers: streamHeaders,
    });

    if (![200, 206, 416].includes(tgStreamRes.status)) {
      return error(502, 'Telegram stream unavailable');
    }

    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Access-Control-Allow-Origin': '*',
      'Content-Type': item.mimeType || detectMimeType(item.name, item.category),
    });

    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag']) {
      const val = tgStreamRes.headers.get(name);
      if (val) headers.set(name, val);
    }

    return withHead(new Response(isHead ? null : tgStreamRes.body, { status: tgStreamRes.status, headers }));
  } catch {
    return error(502, 'TeleDrive is offline or the origin is unavailable');
  }
}
