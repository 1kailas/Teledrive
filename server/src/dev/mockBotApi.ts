import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A standalone mock of a self-hosted telegram-bot-api server in --local mode.
 * Serves /bot<token>/<method>; sendDocument accepts file:// paths and copies
 * them into <dir>/<botId>/documents/ so getFile can return a real local path.
 */

export interface MockFault {
  method: string;
  status: number;
  times?: number; // fail the next N calls
  every?: number; // fail every Nth call
  retryAfter?: number;
  description?: string;
  /** only apply to this bot (counts are then per method+bot) */
  botId?: string;
}

export interface MockBotApiOptions {
  port?: number;
  dir: string;
  faults?: MockFault[];
  host?: string;
}

interface StoredFile {
  fileId: string;
  fileUniqueId: string;
  botId: string;
  localPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

interface MockMessage {
  message_id: number;
  chat_id: number;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name: string;
    mime_type: string;
    file_size: number;
  };
}

export interface MockBotApi {
  port: number;
  dir: string;
  close: () => Promise<void>;
  calls: Map<string, number>;
}

function ok(res: http.ServerResponse, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result }));
}

function fail(res: http.ServerResponse, code: number, description: string, retryAfter?: number): void {
  res.writeHead(code >= 400 ? code : 400, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: false,
      error_code: code,
      description,
      ...(retryAfter != null ? { parameters: { retry_after: retryAfter } } : {}),
    }),
  );
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

interface ParsedRequest {
  fields: Record<string, string>;
  files: Record<string, { fileName: string; data: Buffer }>;
}

async function parseBody(req: http.IncomingMessage): Promise<ParsedRequest> {
  const ct = req.headers['content-type'] ?? '';
  const raw = await readBody(req);
  if (ct.includes('application/json')) {
    const j = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {};
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
    return { fields, files: {} };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw.toString())) fields[k] = v;
    return { fields, files: {} };
  }
  if (ct.includes('multipart/form-data')) {
    const boundary = ct.split('boundary=')[1]?.split(';')[0]?.trim();
    if (!boundary) return { fields: {}, files: {} };
    const fields: Record<string, string> = {};
    const files: Record<string, { fileName: string; data: Buffer }> = {};
    const sep = Buffer.from(`--${boundary}`);
    let rest = raw;
    const parts: Buffer[] = [];
    let idx = rest.indexOf(sep);
    while (idx !== -1) {
      const next = rest.indexOf(sep, idx + sep.length);
      if (next === -1) break;
      parts.push(rest.subarray(idx + sep.length, next));
      idx = next;
    }
    for (const part of parts) {
      const headEnd = part.indexOf('\r\n\r\n');
      if (headEnd === -1) continue;
      const head = part.subarray(0, headEnd).toString();
      let data = part.subarray(headEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
        data = data.subarray(0, data.length - 2);
      }
      const name = /name="([^"]+)"/.exec(head)?.[1];
      if (!name) continue;
      const fname = /filename="([^"]*)"/.exec(head)?.[1];
      if (fname != null) files[name] = { fileName: fname || 'blob', data };
      else fields[name] = data.toString();
    }
    return { fields, files };
  }
  return { fields: {}, files: {} };
}

export function startMockBotApi(opts: MockBotApiOptions): Promise<MockBotApi> {
  const dir = path.resolve(opts.dir);
  fs.mkdirSync(dir, { recursive: true });
  const files = new Map<string, StoredFile>();
  const messages = new Map<number, MockMessage>();
  const calls = new Map<string, number>();
  let messageCounter = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '');
      if (!m) return fail(res, 404, 'Not Found');
      const token = m[1]!;
      const method = m[2]!;
      const botId = token.split(':')[0]!;
      calls.set(method, (calls.get(method) ?? 0) + 1);
      const callNo = calls.get(method)!;

      const botKey = `${method}:${botId}`;
      calls.set(botKey, (calls.get(botKey) ?? 0) + 1);
      for (const f of opts.faults ?? []) {
        if (f.method !== method) continue;
        if (f.botId && f.botId !== botId) continue;
        const n = f.botId ? calls.get(botKey)! : callNo;
        const due = (f.times != null && n <= f.times) || (f.every != null && n % f.every === 0);
        if (due) {
          return fail(res, f.status, f.description ?? (f.status === 429 ? 'Too Many Requests' : 'Internal Server Error'), f.retryAfter);
        }
      }

      const { fields, files: uploads } = await parseBody(req);
      const chatId = Number(fields['chat_id'] ?? 0);

      const storeFile = (localPath: string, fileName: string, mimeType: string): StoredFile => {
        const fileId = `f${botId}_${crypto.randomBytes(12).toString('hex')}`;
        const rec: StoredFile = {
          fileId,
          fileUniqueId: `u${crypto.randomBytes(8).toString('hex')}`,
          botId,
          localPath,
          fileName,
          mimeType,
          fileSize: fs.statSync(localPath).size,
        };
        files.set(fileId, rec);
        return rec;
      };

      switch (method) {
        case 'getMe':
          return ok(res, {
            id: Number(botId),
            is_bot: true,
            first_name: `Mock ${botId}`,
            username: `mock${botId}_bot`,
          });
        case 'getChat':
          return ok(res, { id: chatId || Number(fields['chat_id']), title: 'TeleDrive Mock', type: 'supergroup' });
        case 'getUpdates':
          // synthetic update so `channel:find` has a channel to report
          return ok(res, [
            {
              update_id: 1,
              channel_post: {
                message_id: 1,
                chat: { id: chatId ?? -1001234567890, title: 'TeleDrive Mock', type: 'channel' },
                date: Math.floor(Date.now() / 1000),
                text: 'mock channel post',
              },
            },
          ]);
        case 'getChatMember':
          return ok(res, {
            status: 'administrator',
            can_post_messages: true,
            can_delete_messages: true,
            can_pin_messages: true,
          });
        case 'sendDocument': {
          let rec: StoredFile;
          const docField = fields['document'];
          if (typeof docField === 'string' && docField.startsWith('file://')) {
            const src = docField.slice('file://'.length);
            const destDir = path.join(dir, botId, 'documents');
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, `${crypto.randomUUID()}_${path.basename(src)}`);
            fs.copyFileSync(src, dest);
            rec = storeFile(dest, path.basename(src), 'application/octet-stream');
          } else if (uploads['document']) {
            const up = uploads['document'];
            const destDir = path.join(dir, botId, 'documents');
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, `${crypto.randomUUID()}_${up.fileName}`);
            fs.writeFileSync(dest, up.data);
            rec = storeFile(dest, up.fileName, 'application/octet-stream');
          } else {
            return fail(res, 400, 'Bad Request: no document');
          }
          const msg: MockMessage = {
            message_id: ++messageCounter,
            chat_id: chatId,
            document: {
              file_id: rec.fileId,
              file_unique_id: rec.fileUniqueId,
              file_name: rec.fileName,
              mime_type: rec.mimeType,
              file_size: rec.fileSize,
            },
          };
          messages.set(msg.message_id, msg);
          return ok(res, msg);
        }
        case 'getFile': {
          const fid = fields['file_id'] ?? '';
          const rec = files.get(fid);
          if (!rec || rec.botId !== botId) {
            return fail(res, 400, 'Bad Request: wrong file_id');
          }
          return ok(res, {
            file_id: rec.fileId,
            file_unique_id: rec.fileUniqueId,
            file_size: rec.fileSize,
            file_path: rec.localPath,
          });
        }
        case 'forwardMessage': {
          const src = messages.get(Number(fields['message_id']));
          if (!src) return fail(res, 400, 'Bad Request: message not found');
          const msg: MockMessage = { message_id: ++messageCounter, chat_id: chatId };
          if (src.document) {
            const orig = files.get(src.document.file_id)!;
            // a forwarded document belongs to the *requesting* bot
            const rec: StoredFile = {
              fileId: `f${botId}_${crypto.randomBytes(12).toString('hex')}`,
              fileUniqueId: src.document.file_unique_id,
              botId,
              localPath: orig.localPath,
              fileName: orig.fileName,
              mimeType: orig.mimeType,
              fileSize: orig.fileSize,
            };
            files.set(rec.fileId, rec);
            msg.document = { ...src.document, file_id: rec.fileId };
          }
          messages.set(msg.message_id, msg);
          return ok(res, msg);
        }
        case 'deleteMessage': {
          const id = Number(fields['message_id']);
          if (!messages.delete(id)) return fail(res, 400, 'Bad Request: message to delete not found');
          return ok(res, true);
        }
        case 'deleteMessages': {
          const ids = JSON.parse(fields['message_ids'] ?? '[]') as number[];
          for (const id of ids) messages.delete(id);
          return ok(res, true);
        }
        case 'pinChatMessage':
          return ok(res, true);
        case 'logOut':
          return ok(res, true);
        default:
          return fail(res, 404, `Not Found: method ${method} not implemented by mock`);
      }
    } catch (e) {
      return fail(res, 500, `mock error: ${(e as Error).message}`);
    }
  });

  const port = opts.port ?? 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        dir,
        calls,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// standalone: npm run mock:telegram
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env['MOCK_PORT'] ?? 8082);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const dir = path.resolve(repoRoot, process.env['MOCK_DIR'] ?? './data/mock-bot-api');
  const faults: MockFault[] = [];
  if (process.env['MOCK_FAIL_SENDDOCUMENT_429_EVERY']) {
    faults.push({
      method: 'sendDocument',
      status: 429,
      every: Number(process.env['MOCK_FAIL_SENDDOCUMENT_429_EVERY']),
      retryAfter: 1,
    });
  }
  startMockBotApi({ port, dir, faults }).then((m) => {
    console.log(`mock telegram bot api listening on http://127.0.0.1:${m.port} (dir: ${m.dir})`);
  });
}
