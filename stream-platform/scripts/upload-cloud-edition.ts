import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const streamRoot = path.resolve(__dirname, '..');
const editionsDir = path.resolve(streamRoot, 'data/stream-editions');
const progressDir = path.resolve(streamRoot, 'data/cloud-edition-uploads');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

/**
 * The public Bot API refuses to serve documents larger than 20 MiB. Keep a
 * small safety margin so every part can always be downloaded by Cloudflare.
 */
const DEFAULT_PART_SIZE = 19.5 * 1024 * 1024; // 20,447,232 bytes
const MAX_ATTEMPTS = 6;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'mts', 'flv', 'wmv', '3gp', 'ogv',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'weba', 'wma',
];

interface DesktopBot {
  id: string;
  token: string;
}

interface DesktopBlob {
  id: string;
  size?: number;
  sha256?: string;
}

interface DesktopPart {
  blob_id?: string;
  part_index?: number;
  size?: number;
  telegram_channel_id?: string | number;
  telegram_file_id?: string;
  sha256?: string;
  bot_id?: string;
}

interface DesktopFile {
  id: string;
  blob_id?: string;
  name: string;
  extension?: string;
  mime_type?: string;
  category?: string;
  size?: number;
  duration?: number | null;
  status?: string;
  trashed_at?: number | null;
}

interface DesktopData {
  files?: DesktopFile[];
  blobs?: DesktopBlob[];
  parts?: DesktopPart[];
  bots?: DesktopBot[];
}

interface UploadedPart {
  partIndex: number;
  size: number;
  telegramFileId: string;
  botId: string;
}

interface ProgressFile {
  fileId: string;
  contentFingerprint: string;
  size: number;
  partSize: number;
  parts: UploadedPart[];
}

interface Manifest {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  duration: number | null;
  source: string;
  contentFingerprint: string;
  uploadedAt: number;
  parts: UploadedPart[];
}

interface PartPlan {
  partIndex: number;
  offset: number;
  size: number;
}

function fail(message: string): never {
  console.error(`[cloud-edition] ${message}`);
  process.exit(1);
}

function warn(message: string): void {
  console.warn(`[cloud-edition] ${message}`);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function existingDirectory(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function discoverDataDir(): string | null {
  const configured = process.env.TELEDRIVE_DATA_DIR?.trim();
  if (configured) {
    const directory = existingDirectory(configured);
    if (directory) return directory;
    warn(`TELEDRIVE_DATA_DIR does not exist: ${configured}`);
  }

  const appData = process.env.APPDATA?.trim();
  if (appData) {
    const directory = existingDirectory(path.join(appData, 'TeleDrive', 'data'));
    if (directory) return directory;
  }

  const usersDirectory = '/mnt/c/Users';
  if (fs.existsSync(usersDirectory)) {
    try {
      for (const user of fs.readdirSync(usersDirectory)) {
        const directory = existingDirectory(
          path.join(usersDirectory, user, 'AppData', 'Roaming', 'TeleDrive', 'data'),
        );
        if (directory) return directory;
      }
    } catch {
      // WSL is optional; fall through to the missing-data error.
    }
  }

  return null;
}

function resolveDesktopJson(): string {
  const configured = process.env.TELEDRIVE_JSON?.trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    fail(`TELEDRIVE_JSON does not exist: ${configured}`);
  }

  const dataDir = discoverDataDir();
  if (!dataDir) {
    fail('No TeleDrive data directory found. Set TELEDRIVE_DATA_DIR or TELEDRIVE_JSON.');
  }
  const candidate = path.join(dataDir, 'teledrive.json');
  if (!fs.existsSync(candidate)) fail(`teledrive.json not found at ${candidate}`);
  return candidate;
}

function mediaSearchDirs(dataDir: string): string[] {
  const directories = new Set<string>();
  const configured = process.env.STREAM_MEDIA_DIRS;
  if (configured) {
    for (const entry of configured.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (trimmed) directories.add(trimmed);
    }
  }

  const userRoot = path.resolve(dataDir, '../../../..');
  for (const folder of [
    'Videos',
    'Videos/Screen Recordings',
    'Videos/Captures',
    'Screen Recordings',
    'Recordings',
    'Downloads',
    'Desktop',
    'Music',
  ]) {
    directories.add(path.join(userRoot, folder));
  }
  return [...directories];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findLocalMedia(name: string, directories: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const candidates = new Set<string>([trimmed]);
  const stem = trimmed.replace(/\.[^.]+$/, '');
  for (const extension of MEDIA_EXTENSIONS) candidates.add(`${stem}.${extension}`);

  for (const directory of directories) {
    if (!existingDirectory(directory)) continue;
    let entries: string[] | null = null;
    for (const candidate of candidates) {
      const direct = path.join(directory, candidate);
      if (isFile(direct)) return direct;
      if (!entries) {
        try {
          entries = fs.readdirSync(directory);
        } catch {
          entries = [];
        }
      }
      const match = entries.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
      if (match) return path.join(directory, match);
    }
  }
  return null;
}

function partPlan(size: number, partSize: number): PartPlan[] {
  const parts: PartPlan[] = [];
  for (let offset = 0, index = 0; offset < size; offset += partSize, index += 1) {
    parts.push({ partIndex: index, offset, size: Math.min(partSize, size - offset) });
  }
  return parts;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sha256Range(filePath: string, start: number, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath, { start, end: start + length - 1 });
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The desktop app fingerprints a blob as SHA-256(size_le_u64 || part_sha256
 * hex strings). Reproduce it so the catalog can match every retry of the same
 * upload to one cloud edition. This also verifies each source slice against
 * the hashes recorded when the file was uploaded.
 */
async function computeContentFingerprint(
  filePath: string,
  size: number,
  parts: DesktopPart[],
): Promise<string | null> {
  if (parts.length === 0) return null;

  const ordered = [...parts].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0));
  let total = 0;
  for (const part of ordered) {
    if (
      !Number.isInteger(part.part_index)
      || !Number.isInteger(part.size)
      || (part.size ?? 0) <= 0
    ) {
      return null;
    }
    total += part.size!;
  }
  if (total !== size) return null;

  const fingerprint = createHash('sha256');
  const sizeBytes = Buffer.alloc(8);
  sizeBytes.writeBigUInt64LE(BigInt(size));
  fingerprint.update(sizeBytes);

  let offset = 0;
  for (const part of ordered) {
    const actual = await sha256Range(filePath, offset, part.size!);
    const recorded = (part.sha256 ?? '').trim().toLowerCase();
    if (SHA256.test(recorded) && actual !== recorded) {
      throw new FatalUploadError(`Part ${part.part_index} SHA-256 does not match the desktop record.`);
    }
    fingerprint.update(actual);
    offset += part.size!;
  }

  return fingerprint.digest('hex');
}

function probeDuration(filePath: string): number | null {
  // ffprobe is optional: a missing duration must not block publishing.
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
    { encoding: 'utf8', timeout: 20_000 },
  );
  const seconds = result.status === 0 ? Number.parseFloat(result.stdout.trim()) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

function loadBots(data: DesktopData): DesktopBot[] {
  return (data.bots ?? []).filter(
    (bot): bot is DesktopBot => Boolean(bot && typeof bot.id === 'string' && typeof bot.token === 'string' && bot.token),
  );
}

function loadUploadedParts(fileId: string, contentFingerprint: string, size: number, partSize: number): UploadedPart[] {
  const progressPath = path.join(progressDir, `${fileId}.json`);
  if (!fs.existsSync(progressPath)) return [];

  const progress = readJson<ProgressFile>(progressPath);
  if (!progress) {
    warn(`Ignoring unreadable upload progress at ${progressPath}.`);
    return [];
  }
  if (progress.fileId !== fileId || progress.contentFingerprint !== contentFingerprint || progress.size !== size || progress.partSize !== partSize) {
    warn('Ignoring upload progress: it belongs to a different source or part layout.');
    return [];
  }

  const plans = new Map(partPlan(size, partSize).map((plan) => [plan.partIndex, plan]));
  const valid: UploadedPart[] = [];
  for (const part of progress.parts ?? []) {
    const plan = plans.get(part.partIndex);
    if (
      plan
      && part.size === plan.size
      && typeof part.telegramFileId === 'string'
      && part.telegramFileId
      && typeof part.botId === 'string'
      && part.botId
    ) {
      valid.push({
        partIndex: part.partIndex,
        size: part.size,
        telegramFileId: part.telegramFileId,
        botId: part.botId,
      });
    }
  }
  return valid;
}

function saveUploadedParts(fileId: string, contentFingerprint: string, size: number, partSize: number, parts: UploadedPart[]): void {
  const progress: ProgressFile = {
    fileId,
    contentFingerprint,
    size,
    partSize,
    parts: [...parts].sort((a, b) => a.partIndex - b.partIndex),
  };
  writeJsonAtomic(path.join(progressDir, `${fileId}.json`), progress);
}

function isCompleteManifest(manifest: Manifest | null, fileId: string, size: number, contentFingerprint: string): boolean {
  if (!manifest || manifest.fileId !== fileId || manifest.size !== size) return false;
  if ((manifest.contentFingerprint ?? '').toLowerCase() !== contentFingerprint) return false;
  const parts = [...manifest.parts].sort((a, b) => a.partIndex - b.partIndex);
  if (parts.length === 0) return false;
  return parts.every((part, index) =>
    part.partIndex === index
    && part.size > 0
    && part.size <= 20 * 1024 * 1024
    && Boolean(part.telegramFileId)
    && Boolean(part.botId),
  );
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class FatalUploadError extends Error {}

async function uploadPart(
  plan: PartPlan,
  buffer: Buffer,
  bots: DesktopBot[],
  channelId: string,
  fileName: string,
): Promise<UploadedPart> {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const bot = bots[(plan.partIndex + attempt - 1) % bots.length]!;
    const formData = new FormData();
    formData.append('chat_id', channelId);
    formData.append('document', new Blob([new Uint8Array(buffer)]), fileName);

    try {
      const response = await fetch(`https://api.telegram.org/bot${bot.token}/sendDocument`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const payload = await response.json() as {
        ok?: boolean;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
        result?: { document?: { file_id?: string } };
      };

      if (payload.ok && payload.result?.document?.file_id) {
        return {
          partIndex: plan.partIndex,
          size: plan.size,
          telegramFileId: payload.result.document.file_id,
          botId: bot.id,
        };
      }

      lastError = payload.description || `HTTP ${response.status}`;
      if (payload.error_code === 429) {
        const waitSeconds = Math.min(60, (payload.parameters?.retry_after ?? 3) + 1);
        warn(`Part ${plan.partIndex}: rate limited, waiting ${waitSeconds}s.`);
        await sleep(waitSeconds * 1000);
      } else if (payload.error_code && payload.error_code >= 400 && payload.error_code < 500) {
        // Invalid file ids, bad channel ids, and similar client errors will not
        // recover by retrying the same request.
        throw new FatalUploadError(`Part ${plan.partIndex}: ${lastError}`);
      }
    } catch (error) {
      if (error instanceof FatalUploadError) throw error;
      lastError = (error as Error).message;
    }

    if (attempt < MAX_ATTEMPTS) {
      warn(`Part ${plan.partIndex}: ${lastError}; retrying (${attempt + 1}/${MAX_ATTEMPTS}).`);
      await sleep(Math.min(30_000, 1500 * attempt));
    }
  }

  throw new Error(`Part ${plan.partIndex} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'file-id': { type: 'string' },
      source: { type: 'string' },
      name: { type: 'string' },
      channel: { type: 'string' },
      'part-size-mb': { type: 'string' },
      'skip-hash-check': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: npm run upload-cloud-edition --prefix stream-platform -- --file-id <uuid> [options]

Creates a public-Bot-API edition of a desktop upload by splitting the source
into <= 20 MiB parts and writing data/stream-editions/<fileId>.json.

Options:
  --file-id <uuid>       TeleDrive desktop file id (required)
  --source <path>        Source media path (auto-discovered when omitted)
  --name <name>          Catalog name override
  --channel <id>         Telegram channel id (defaults to the desktop part)
  --part-size-mb <n>     Part size in MiB (default 19.5)
  --skip-hash-check      Allow a source whose SHA-256 differs from the desktop record
  --dry-run              Print the upload plan without contacting Telegram
  --force                Replace an existing manifest and re-upload
  -h, --help             Show this help`);
    return;
  }

  const fileId = values['file-id']?.trim();
  if (!fileId || !UUID.test(fileId)) {
    fail('A valid --file-id <uuid> is required. Run with --help for usage.');
  }

  const partSize = values['part-size-mb']
    ? Math.floor(Number(values['part-size-mb']) * 1024 * 1024)
    : DEFAULT_PART_SIZE;
  if (!Number.isFinite(partSize) || partSize <= 0 || partSize > 20 * 1024 * 1024) {
    fail('--part-size-mb must be a positive number no larger than 20.');
  }

  const desktopJson = resolveDesktopJson();
  const desktop = readJson<DesktopData>(desktopJson);
  if (!desktop) fail(`Could not read ${desktopJson}`);
  if (!Array.isArray(desktop.files)) fail(`No files array in ${desktopJson}`);

  const record = desktop.files.find((file) => file && file.id === fileId);
  if (!record) fail(`No desktop file found with id ${fileId}`);
  if (record.trashed_at) fail(`"${record.name}" is in the trash.`);
  if (record.status && record.status !== 'ready') fail(`"${record.name}" is not ready (${record.status}).`);
  if (record.category !== 'video' && record.category !== 'audio') {
    fail(`"${record.name}" is not video or audio.`);
  }

  const blob = (desktop.blobs ?? []).find((entry) => entry && entry.id === record.blob_id);
  const recordedHash = (blob?.sha256 ?? '').trim().toLowerCase();
  if (recordedHash && !SHA256.test(recordedHash)) {
    warn(`Ignoring malformed desktop SHA-256 for "${record.name}".`);
  }
  const expectedHash = recordedHash && SHA256.test(recordedHash) ? recordedHash : null;

  const dataDir = path.dirname(desktopJson);
  const sourcePath = values.source?.trim()
    || findLocalMedia(record.name, mediaSearchDirs(dataDir));
  if (!sourcePath) {
    fail(`Source file for "${record.name}" was not found. Pass --source <path>.`);
  }
  if (!isFile(sourcePath)) fail(`Source is not a file: ${sourcePath}`);

  const actualSize = fs.statSync(sourcePath).size;
  const expectedSize = typeof record.size === 'number' && record.size > 0 ? record.size : blob?.size;
  if (typeof expectedSize === 'number' && expectedSize > 0 && actualSize !== expectedSize) {
    fail(`Source size ${actualSize} does not match the desktop record (${expectedSize}).`);
  }

  console.log(`[cloud-edition] Source: ${sourcePath}`);
  console.log(`[cloud-edition] Size: ${actualSize} bytes, ${partPlan(actualSize, partSize).length} part(s) at ${partSize} bytes.`);

  const desktopParts = (desktop.parts ?? []).filter(
    (part) => part && part.blob_id === record.blob_id,
  );
  const computedFingerprint = await computeContentFingerprint(sourcePath, actualSize, desktopParts);
  let contentFingerprint: string;
  if (expectedHash && computedFingerprint && computedFingerprint !== expectedHash) {
    if (!values['skip-hash-check']) {
      fail('Source content does not match the desktop record. Use --skip-hash-check to override.');
    }
    warn('Source content does not match the desktop record; using the verified source fingerprint.');
    contentFingerprint = computedFingerprint;
  } else {
    if (expectedHash && !computedFingerprint) {
      warn('Desktop parts do not contain enough hashes to verify the source; relying on the recorded fingerprint.');
    }
    contentFingerprint = expectedHash ?? computedFingerprint ?? await sha256File(sourcePath);
  }

  const channelId = values.channel?.trim()
    || process.env.TELEDRIVE_CHANNEL_ID?.trim()
    || (desktop.parts ?? [])
      .filter((part) => part && part.blob_id === record.blob_id && part.telegram_channel_id !== undefined)
      .map((part) => String(part.telegram_channel_id))
      .find((value) => value.length > 0);
  if (!channelId) fail('No Telegram channel id found. Pass --channel <id>.');

  const bots = loadBots(desktop);
  if (bots.length === 0) fail(`No usable bot tokens in ${desktopJson}.`);

  const manifestPath = path.join(editionsDir, `${fileId}.json`);
  const existingManifest = readJson<Manifest>(manifestPath);
  if (!values.force && isCompleteManifest(existingManifest, fileId, actualSize, contentFingerprint)) {
    console.log(`[cloud-edition] ${manifestPath} is already complete; nothing to do.`);
    return;
  }

  const plans = partPlan(actualSize, partSize);
  const uploadedParts = values.force
    ? []
    : loadUploadedParts(fileId, contentFingerprint, actualSize, partSize);
  const uploadedByIndex = new Map(uploadedParts.map((part) => [part.partIndex, part]));
  const remaining = plans.filter((plan) => !uploadedByIndex.has(plan.partIndex));
  console.log(`[cloud-edition] Channel ${channelId}; bots ${bots.map((bot) => bot.id).join(', ')}.`);
  console.log(`[cloud-edition] Parts already uploaded: ${uploadedParts.length}; remaining: ${remaining.length}.`);

  if (values['dry-run']) {
    for (const plan of plans) {
      console.log(`  part ${plan.partIndex}: bytes ${plan.offset}..${plan.offset + plan.size - 1} (${plan.size})`);
    }
    return;
  }

  if (remaining.length > 0) {
    const handle = fs.openSync(sourcePath, 'r');
    let completed = uploadedParts.length;
    let failure: Error | null = null;
    const queue = [...remaining];
    const workerCount = Math.min(bots.length, queue.length);

    const worker = async () => {
      for (;;) {
        if (failure) return;
        const plan = queue.shift();
        if (!plan) return;
        try {
          const buffer = Buffer.alloc(plan.size);
          const read = fs.readSync(handle, buffer, 0, plan.size, plan.offset);
          if (read !== plan.size) {
            throw new Error(`Short read for part ${plan.partIndex}: ${read}/${plan.size}`);
          }

          const extension = path.extname(record.name) || '.bin';
          const uploaded = await uploadPart(
            plan,
            buffer,
            bots,
            channelId,
            `teledrive_${fileId.slice(0, 8)}_${plan.partIndex}${extension}`,
          );
          uploadedByIndex.set(uploaded.partIndex, uploaded);
          completed += 1;
          saveUploadedParts(
            fileId,
            contentFingerprint,
            actualSize,
            partSize,
            [...uploadedByIndex.values()],
          );
          console.log(`[cloud-edition] Uploaded part ${uploaded.partIndex} via bot ${uploaded.botId} (${completed}/${plans.length}).`);
        } catch (error) {
          failure = error as Error;
          return;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      fs.closeSync(handle);
    }
    if (failure) throw failure;
  }

  const parts = plans.map((plan) => uploadedByIndex.get(plan.partIndex));
  if (parts.some((part) => !part)) fail('Upload finished without all parts. Progress was preserved; rerun to resume.');

  const manifest: Manifest = {
    fileId,
    name: values.name?.trim() || record.name,
    mimeType: record.mime_type || (record.category === 'video' ? 'video/mp4' : 'audio/mpeg'),
    size: actualSize,
    duration: record.duration && record.duration > 0 ? Math.round(record.duration) : probeDuration(sourcePath),
    source: sourcePath,
    contentFingerprint,
    uploadedAt: Date.now(),
    parts: (parts as UploadedPart[]).sort((a, b) => a.partIndex - b.partIndex),
  };
  writeJsonAtomic(manifestPath, manifest);

  try {
    fs.rmSync(path.join(progressDir, `${fileId}.json`));
  } catch {
    // Progress cleanup is best effort.
  }

  console.log(`[cloud-edition] Wrote ${manifestPath}.`);
  console.log('[cloud-edition] Run `npm run export-catalog --prefix stream-platform` to publish it.');
}

void main().catch((error) => fail((error as Error).message));
