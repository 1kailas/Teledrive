import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, webcrypto, type KeyObject } from 'node:crypto';
import test, { before } from 'node:test';
import { handleApi, type EdgeEnv } from '../src/edge';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const env: EdgeEnv = {
  ACCESS_TEAM: 'folio-test',
  ACCESS_AUD: 'stream-audience',
  TELEDRIVE_ORIGIN: 'https://origin.example/',
  ORIGIN_CLIENT_ID: 'origin-id',
  ORIGIN_CLIENT_SECRET: 'origin-secret',
};
const id = '72c787ae-30d2-4d51-a1a5-66a0f524c207';
let privateKey: KeyObject;
let publicKey: JsonWebKey;
let jwt: string;

const base64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');

async function signedToken(overrides: Record<string, unknown> = {}) {
  const header = base64(JSON.stringify({ alg: 'RS256', kid: 'testing-key' }));
  const claims = base64(JSON.stringify({
    iss: 'https://folio-test.cloudflareaccess.com',
    aud: ['stream-audience'],
    email: 'viewer@example.com',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${base64(signature)}`;
}

before(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'testing-key' } as JsonWebKey;
  jwt = await signedToken();
});

function request(path: string, options: RequestInit = {}) {
  return new Request(`https://stream.example${path}`, {
    ...options, headers: { 'cf-access-jwt-assertion': jwt, ...options.headers },
  });
}

function mockOrigin(paths: string[], override?: (path: string) => Response) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'folio-test.cloudflareaccess.com') {
      return Response.json({ keys: [publicKey] });
    }
    assert.equal(url.hostname, 'origin.example');
    assert.equal(new Headers(init?.headers).get('CF-Access-Client-Secret'), 'origin-secret');
    paths.push(url.pathname);
    if (override) return override(url.pathname);
    if (url.pathname.startsWith('/api/search')) {
      return Response.json({ files: [
        { id, name: 'Tonight.mp4', category: 'video', mimeType: 'video/mp4', status: 'ready',
          hasThumbnail: true, size: 123, duration: 120, updatedAt: 1234 },
        { id: 'not-media', name: 'secrets', category: 'video', mimeType: 'text/html', status: 'ready' },
      ] });
    }
    if (url.pathname === `/api/files/${id}`) {
      return Response.json({ file: { id, category: 'video', mimeType: 'video/mp4',
        status: 'ready', hasThumbnail: true } });
    }
    if (url.pathname === `/api/files/${id}/content`) {
      assert.equal(new Headers(init?.headers).get('Range'), 'bytes=10-19');
      return new Response('0123456789', {
        status: 206,
        headers: { 'Content-Range': 'bytes 10-19/123', 'Accept-Ranges': 'bytes',
          'Content-Length': '10', 'Content-Type': 'video/mp4' },
      });
    }
    if (url.pathname === `/api/thumbnails/${id}`) return new Response('art', { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

test('rejects unsigned, expired, wrong-audience and unconfigured requests before reaching origin', async () => {
  const paths: string[] = [];
  const origin = mockOrigin(paths);
  assert.equal((await handleApi(new Request('https://stream.example/api/catalog'), env, origin)).status, 401);
  assert.equal((await handleApi(request('/api/catalog', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }), env, origin)).status, 401);
  assert.equal((await handleApi(request('/api/catalog', {
    headers: { 'cf-access-jwt-assertion': await signedToken({ exp: 1000 }) },
  }), env, origin)).status, 401);
  assert.equal((await handleApi(request('/api/catalog', {
    headers: { 'cf-access-jwt-assertion': await signedToken({ aud: ['other'] }) },
  }), env, origin)).status, 401);
  assert.equal((await handleApi(request('/api/catalog'), { ...env, ORIGIN_CLIENT_SECRET: '' }, origin)).status, 503);
  assert.deepEqual(paths, []);
});

test('catalog only includes ready media and never returns origin credentials', async () => {
  const paths: string[] = [];
  const response = await handleApi(request('/api/catalog?type=video&q=Tonight'), env, mockOrigin(paths));
  assert.equal(response.status, 200);
  const body = await response.json() as { items: { id: string; name: string }[] };
  assert.deepEqual(body.items.map((item) => item.name), ['Tonight.mp4']);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(JSON.stringify(body).includes(env.ORIGIN_CLIENT_SECRET!), false);
  assert.deepEqual(paths, ['/api/search']);
});

test('media streams Range and Content-Range without buffering or opening arbitrary routes', async () => {
  const paths: string[] = [];
  const origin = mockOrigin(paths);
  const response = await handleApi(request(`/api/media/${id}`, { headers: {
    'cf-access-jwt-assertion': jwt, Range: 'bytes=10-19',
  } }), env, origin);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 10-19/123');
  assert.equal(await response.text(), '0123456789');
  assert.deepEqual(paths, [`/api/files/${id}`, `/api/files/${id}/content`]);
  assert.equal((await handleApi(request('/api/files/mutations'), env, origin)).status, 404);
  assert.equal((await handleApi(request(`/api/media/${id}`, { method: 'POST' }), env, origin)).status, 405);
  assert.equal((await handleApi(request(`/api/media/${id}`, { headers: {
    'cf-access-jwt-assertion': jwt, Range: 'bytes=1-2,4-5',
  } }), env, origin)).status, 416);
});

test('rejects non-media, trashed files and unprotected origin configurations', async () => {
  const paths: string[] = [];
  const origin = mockOrigin(paths, () => Response.json({
    file: { id, category: 'video', mimeType: 'text/html', status: 'ready' },
  }));
  assert.equal((await handleApi(request(`/api/media/${id}`), env, origin)).status, 404);
  assert.deepEqual(paths, [`/api/files/${id}`]);
  assert.equal((await handleApi(request('/api/catalog'), { ...env, TELEDRIVE_ORIGIN: 'http://127.0.0.1:48291' }, origin)).status, 503);
});

test('origin login redirects and oversized catalogs do not leak to the viewer', async () => {
  const paths: string[] = [];
  const redirect = mockOrigin(paths, () => new Response(null, {
    status: 302, headers: { Location: 'https://origin.example/cdn-cgi/access/login' },
  }));
  const denied = await handleApi(request('/api/catalog'), env, redirect);
  assert.equal(denied.status, 502);
  assert.equal(denied.headers.get('Location'), null);
  assert.equal((await denied.text()).includes(env.ORIGIN_CLIENT_SECRET!), false);

  const large = mockOrigin(paths, () => new Response('x', {
    status: 200, headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) },
  }));
  assert.equal((await handleApi(request('/api/catalog'), env, large)).status, 502);
});

test('standalone direct Telegram mode streams media Range without origin or tunnel', async () => {
  const standaloneEnv: EdgeEnv = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEDRIVE_CATALOG: JSON.stringify({
      items: [
        {
          id,
          name: 'Interstellar.mkv',
          category: 'video',
          mimeType: 'video/x-matroska',
          size: 5000000,
          duration: 7200,
          hasThumbnail: false,
          updatedAt: 12345,
          parts: [{ partIndex: 0, size: 5000000, telegramFileId: 'tg-file-123', botId: 'bot-1' }],
        },
      ],
    }),
    ALLOW_PUBLIC: 'true',
  };

  const mockTgFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes('/getFile')) {
      return Response.json({ ok: true, result: { file_path: 'videos/movie.mkv' } });
    }
    if (url.pathname.includes('/videos/movie.mkv')) {
      const rangeHeader = new Headers(init?.headers).get('Range');
      assert.equal(rangeHeader, 'bytes=500-999');
      return new Response('chunk-data', {
        status: 206,
        headers: {
          'Content-Range': 'bytes 500-999/5000000',
          'Content-Length': '500',
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const catalogRes = await handleApi(new Request('https://stream.example/api/catalog'), standaloneEnv, mockTgFetch);
  assert.equal(catalogRes.status, 200);
  const catalogBody = await catalogRes.json() as { items: { name: string; mimeType: string }[] };
  assert.equal(catalogBody.items[0]?.name, 'Interstellar.mkv');
  assert.equal(catalogBody.items[0]?.mimeType, 'video/x-matroska');

  const mediaRes = await handleApi(
    new Request(`https://stream.example/api/media/${id}`, { headers: { Range: 'bytes=500-999' } }),
    standaloneEnv,
    mockTgFetch,
  );
  assert.equal(mediaRes.status, 206);
  assert.equal(mediaRes.headers.get('Content-Range'), 'bytes 500-999/5000000');
  assert.equal(mediaRes.headers.get('Content-Type'), 'video/x-matroska');
  assert.equal(await mediaRes.text(), 'chunk-data');
});

test('an empty environment catalog falls back to the deployed catalog', async () => {
  const standaloneEnv: EdgeEnv = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEDRIVE_CATALOG: JSON.stringify({ items: [] }),
    ALLOW_PUBLIC: 'true',
  };
  const staticCatalog = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/catalog.json') {
      return Response.json({
        items: [{
          id,
          name: 'The Quiet Signal.2024.1080p.mp4',
          category: 'video',
          mimeType: 'video/mp4',
          size: 5000000,
          duration: 7200,
          hasThumbnail: false,
          updatedAt: 12345,
          parts: [],
        }],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const response = await handleApi(new Request('https://stream.example/api/catalog'), standaloneEnv, staticCatalog);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: { name: string }[] };
  assert.deepEqual(body.items.map((item) => item.name), ['The Quiet Signal.2024.1080p.mp4']);
});

test('artwork endpoint generates an SVG cover when a thumbnail is missing', async () => {
  const artEnv: EdgeEnv = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEDRIVE_CATALOG: JSON.stringify({
      items: [
        {
          id,
          name: 'The Quiet Signal.2024.1080p.mp4',
          category: 'video',
          mimeType: 'video/mp4',
          size: 5000000,
          duration: 7200,
          hasThumbnail: false,
          updatedAt: 12345,
          parts: [],
        },
      ],
    }),
    ALLOW_PUBLIC: 'true',
  };
  const noNetwork = (async () => new Response(null, { status: 404 })) as typeof fetch;

  const artRes = await handleApi(new Request(`https://stream.example/api/art/${id}`), artEnv, noNetwork);
  assert.equal(artRes.status, 200);
  assert.equal(artRes.headers.get('Content-Type'), 'image/svg+xml; charset=utf-8');
  const svg = await artRes.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /The Quiet Signal/);
  assert.doesNotMatch(svg, /1080p/);

  const headRes = await handleApi(
    new Request(`https://stream.example/api/art/${id}`, { method: 'HEAD' }),
    artEnv,
    noNetwork,
  );
  assert.equal(headRes.status, 200);
  assert.equal(await headRes.text(), '');
});

test('standalone mode routes multi-part media across multiple Telegram bots based on byte offsets', async () => {
  const multiPartEnv: EdgeEnv = {
    BOT_TOKENS: '1111:TOKEN1,2222:TOKEN2,3333:TOKEN3',
    TELEDRIVE_CATALOG: JSON.stringify({
      items: [
        {
          id,
          name: 'BigMovie.mkv',
          category: 'video',
          mimeType: 'video/x-matroska',
          size: 6000000,
          duration: 7200,
          hasThumbnail: false,
          updatedAt: 12345,
          parts: [
            { partIndex: 0, size: 2000000, telegramFileId: 'part-0-file', botId: '1111' },
            { partIndex: 1, size: 2000000, telegramFileId: 'part-1-file', botId: '2222' },
            { partIndex: 2, size: 2000000, telegramFileId: 'part-2-file', botId: '3333' },
          ],
        },
      ],
    }),
    ALLOW_PUBLIC: 'true',
  };

  const requestedBots: string[] = [];
  const requestedFiles: string[] = [];
  const requestedRanges: string[] = [];

  const mockTgFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const tokenMatch = /bot([^/]+)/.exec(url.pathname);
    if (tokenMatch) requestedBots.push(tokenMatch[1]!);

    if (url.pathname.includes('/getFile')) {
      const fileId = url.searchParams.get('file_id');
      requestedFiles.push(fileId!);
      return Response.json({ ok: true, result: { file_path: `stream/${fileId}.bin` } });
    }

    if (url.pathname.includes('/stream/')) {
      const rangeHeader = new Headers(init?.headers).get('Range');
      requestedRanges.push(rangeHeader!);
      return new Response('slice-payload', {
        status: 206,
        headers: {
          'Content-Length': '1000',
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  // Request byte range in Part 1 (offset 2,000,000 to 3,999,999) -> belongs to Bot 2222
  const part1Res = await handleApi(
    new Request(`https://stream.example/api/media/${id}`, { headers: { Range: 'bytes=2500000-2500999' } }),
    multiPartEnv,
    mockTgFetch,
  );
  assert.equal(part1Res.status, 206);
  assert.equal(part1Res.headers.get('Content-Range'), 'bytes 2500000-2500999/6000000');
  assert.equal(part1Res.headers.get('Content-Length'), '1000');
  assert.equal(requestedFiles.includes('part-1-file'), true);
  assert.equal(requestedBots.includes('2222:TOKEN2'), true);
  assert.equal(requestedRanges[0], 'bytes=500000-500999');

  // Request byte range in Part 2 (offset 4,000,000 to 5,999,999) -> belongs to Bot 3333
  const part2Res = await handleApi(
    new Request(`https://stream.example/api/media/${id}?download=1`, { headers: { Range: 'bytes=4000100-4000200' } }),
    multiPartEnv,
    mockTgFetch,
  );
  assert.equal(part2Res.status, 206);
  assert.equal(part2Res.headers.get('Content-Range'), 'bytes 4000100-4000200/6000000');
  assert.equal(part2Res.headers.get('Content-Disposition')?.includes('BigMovie.mkv'), true);
  assert.equal(requestedFiles.includes('part-2-file'), true);
  assert.equal(requestedBots.includes('3333:TOKEN3'), true);
});

test('series and season episodes can be streamed directly by media ID', async () => {
  const epId = 'e1111111-2222-3333-4444-555555555555';
  const seriesEnv: EdgeEnv = {
    TELEGRAM_BOT_TOKEN: '1234:TOKEN',
    TELEDRIVE_CATALOG: JSON.stringify({
      items: [],
      series: [
        {
          id: 's1111111-2222-3333-4444-555555555555',
          name: 'Arcane',
          folderName: 'Arcane',
          description: 'Steampunk animation series',
          seasonsCount: 1,
          episodesCount: 1,
          seasons: [
            {
              seasonNumber: 1,
              name: 'Season 1',
              episodes: [
                {
                  id: epId,
                  episodeNumber: 1,
                  seasonNumber: 1,
                  seriesId: 's1111111-2222-3333-4444-555555555555',
                  seriesName: 'Arcane',
                  episodeTitle: 'Welcome to the Playground',
                  name: 'Arcane.S01E01.mp4',
                  mimeType: 'video/mp4',
                  size: 5000000,
                  duration: 2400,
                  hasThumbnail: false,
                  parts: [{ partIndex: 0, size: 5000000, telegramFileId: 'arcane-ep1-file', botId: '1234' }],
                },
              ],
            },
          ],
        },
      ],
    }),
    ALLOW_PUBLIC: 'true',
  };

  const mockTgFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes('/getFile')) {
      return Response.json({ ok: true, result: { file_path: 'series/ep1.mp4' } });
    }
    if (url.pathname.includes('/series/ep1.mp4')) {
      return new Response('arcane-slice', { status: 206, headers: { 'Content-Length': '12' } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const catalogRes = await handleApi(new Request('https://stream.example/api/catalog'), seriesEnv, mockTgFetch);
  assert.equal(catalogRes.status, 200);
  const catData = await catalogRes.json() as { items: unknown[]; series: { name: string }[] };
  assert.equal(catData.series.length, 1);
  assert.equal(catData.series[0]!.name, 'Arcane');

  const streamRes = await handleApi(new Request(`https://stream.example/api/media/${epId}`, {
    headers: { Range: 'bytes=0-11' },
  }), seriesEnv, mockTgFetch);
  assert.equal(streamRes.status, 206);
  assert.equal(await streamRes.text(), 'arcane-slice');
});
