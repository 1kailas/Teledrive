export interface EdgeEnv {
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  TELEDRIVE_ORIGIN: string;
  ORIGIN_CLIENT_ID: string;
  ORIGIN_CLIENT_SECRET: string;
}

type Fetcher = typeof fetch;
type CatalogFile = {
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
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
let cachedKeys: { team: string; keys: JsonWebKey[]; until: number } | undefined;

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyAccess(request: Request, env: EdgeEnv, fetcher: Fetcher): Promise<boolean> {
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
      const payload = await certs.json() as { keys?: JsonWebKey[] };
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

function originRequest(env: EdgeEnv, path: string, fetcher: Fetcher, range?: string): Promise<Response> {
  const headers = new Headers({
    'CF-Access-Client-Id': env.ORIGIN_CLIENT_ID,
    'CF-Access-Client-Secret': env.ORIGIN_CLIENT_SECRET,
    Accept: range === undefined ? 'application/json' : '*/*',
  });
  if (range) headers.set('Range', range);
  return fetcher(new URL(path, env.TELEDRIVE_ORIGIN), { headers, redirect: 'manual', cache: 'no-store' });
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function getMedia(id: string, env: EdgeEnv, fetcher: Fetcher): Promise<{ file: Record<string, unknown> } | null> {
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
    id: String(file.id), name: String(file.name ?? 'Untitled'), category,
    mimeType: String(file.mimeType), size: Number(file.size) || 0,
    duration: typeof file.duration === 'number' ? file.duration : null,
    hasThumbnail: file.hasThumbnail === true, updatedAt: Number(file.updatedAt) || 0,
    artist: typeof metadata.artist === 'string' ? metadata.artist : '',
    album: typeof metadata.album === 'string' ? metadata.album : '',
    description: typeof file.description === 'string' ? file.description : '',
  };
}

export async function handleApi(request: Request, env: EdgeEnv, fetcher: Fetcher = fetch): Promise<Response> {
  if (!env.ACCESS_TEAM || !/^[a-z0-9-]+$/.test(env.ACCESS_TEAM) || !env.ACCESS_AUD
    || !env.ORIGIN_CLIENT_ID || !env.ORIGIN_CLIENT_SECRET || !env.TELEDRIVE_ORIGIN) {
    return error(503, 'Streaming gateway is not configured');
  }
  let origin: URL;
  try {
    origin = new URL(env.TELEDRIVE_ORIGIN);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
      || origin.username || origin.password) throw new Error('invalid origin');
  } catch {
    return error(503, 'Streaming gateway origin is invalid');
  }
  if (!await verifyAccess(request, env, fetcher)) return error(401, 'Sign in with Cloudflare Access');
  if (request.method !== 'GET') return error(405, 'Read-only gateway');

  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/catalog') {
      const query = (url.searchParams.get('q') ?? '').trim();
      const type = url.searchParams.get('type') ?? 'all';
      if (query.length > 120 || !['all', 'video', 'audio'].includes(type)) return error(400, 'Invalid catalog filter');
      const categories = (type === 'all' ? ['video', 'audio'] : [type]) as ('video' | 'audio')[];
      const lists = await Promise.all(categories.map(async (category) => {
        const params = new URLSearchParams({ category, q: query });
        const response = await originRequest(env, `/api/search?${params}`, fetcher);
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES)
          throw new Error('catalog unavailable');
        const data = await response.json() as { files?: Record<string, unknown>[] };
        if (!Array.isArray(data.files)) throw new Error('invalid catalog');
        return data.files.slice(0, 150).map((file) => cleanCatalog(file, category))
          .filter((file): file is CatalogFile => file !== null);
      }));
      return Response.json({ items: lists.flat() }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const match = /^\/api\/(media|art)\/([^/]+)$/.exec(url.pathname);
    if (!match || url.search) return error(404, 'Not found');
    const [, kind, id] = match;
    if (!id || !ID.test(id)) return error(404, 'Not found');
    const record = await getMedia(id, env, fetcher);
    if (!record) return error(404, 'Media not found');
    if (kind === 'art' && record.file.hasThumbnail !== true) return error(404, 'Artwork unavailable');
    const range = request.headers.get('Range');
    if (kind === 'media' && range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      return error(416, 'Unsupported range');
    const response = await originRequest(env,
      kind === 'art' ? `/api/thumbnails/${id}` : `/api/files/${id}/content`,
      fetcher, kind === 'media' ? range ?? undefined : undefined);
    if (![200, 206, 416, 404].includes(response.status)) return error(502, 'TeleDrive stream unavailable');
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (kind === 'media' && response.ok) headers.set('Content-Type', String(record.file.mimeType));
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return error(502, 'TeleDrive is offline or the origin is unavailable');
  }
}
