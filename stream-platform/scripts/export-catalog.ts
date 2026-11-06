import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const streamRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(streamRoot, '..');
const outPath = path.resolve(streamRoot, 'public/catalog.json');
const editionsDir = path.resolve(streamRoot, 'data/stream-editions');

/**
 * The public Bot API only allows downloads of files up to 20 MB. Parts larger
 * than this can still be listed, but the hosted player cannot fetch them.
 */
const PUBLIC_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'mts', 'flv', 'wmv', '3gp', 'ogv',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'weba', 'wma',
];

type Category = 'video' | 'audio';

interface CatalogPart {
  partIndex: number;
  size: number;
  telegramFileId?: string;
  botId?: string;
}

interface CatalogItem {
  id: string;
  name: string;
  category: Category;
  mimeType: string;
  size: number;
  duration: number | null;
  hasThumbnail: boolean;
  updatedAt: number;
  artist: string;
  album: string;
  description: string;
  format?: string;
  parts?: CatalogPart[];
  /** Internal only: used to collapse retry duplicates within one export. */
  contentFingerprint?: string;
  /** Internal only: picks the original upload as the stable catalog entry. */
  createdAt?: number;
}

interface EditionManifest {
  fileId: string;
  name?: string;
  mimeType?: string;
  size?: number;
  duration?: number | null;
  source?: string;
  contentFingerprint?: string;
  uploadedAt?: number;
  parts: CatalogPart[];
}

const durationCache = new Map<string, number | null>();

function warn(message: string): void {
  console.warn(`[catalog] ${message}`);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    warn(`Could not read ${filePath}: ${(error as Error).message}`);
    return null;
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function extensionOf(name: string): string {
  const extension = name.split('.').pop() ?? '';
  return extension && extension !== name ? extension.toUpperCase() : '';
}

function detectMimeType(name: string, category: Category): string {
  const extension = (name.split('.').pop() ?? '').toLowerCase();
  const types: Record<string, string> = {
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
  return types[extension] ?? (category === 'video' ? 'video/mp4' : 'audio/mpeg');
}

function metadataOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizePart(value: unknown): CatalogPart | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const partIndex = asNumber(raw.partIndex ?? raw.part_index ?? raw.idx ?? raw.index);
  const size = asNumber(raw.size);
  if (partIndex === null || partIndex < 0 || !Number.isInteger(partIndex) || size === null || size <= 0) return null;

  const telegramFileId = asString(raw.telegramFileId ?? raw.telegram_file_id ?? raw.tg_file_id).trim();
  const botId = asString(raw.botId ?? raw.bot_id).trim();
  return {
    partIndex,
    size,
    ...(telegramFileId ? { telegramFileId } : {}),
    ...(botId ? { botId } : {}),
  };
}

function normalizeParts(value: unknown): CatalogPart[] {
  if (!Array.isArray(value)) return [];
  const byIndex = new Map<number, CatalogPart>();
  for (const entry of value) {
    const part = normalizePart(entry);
    if (part) byIndex.set(part.partIndex, part);
  }
  return [...byIndex.values()].sort((a, b) => a.partIndex - b.partIndex);
}

function totalSize(parts: CatalogPart[]): number {
  return parts.reduce((sum, part) => sum + part.size, 0);
}

function hasPlayableParts(parts: CatalogPart[]): boolean {
  if (parts.length === 0) return false;
  const indices = new Set(parts.map((part) => part.partIndex));
  if (indices.size !== parts.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (!indices.has(index)) return false;
  }
  return parts.every((part) =>
    Boolean(part.telegramFileId)
    && part.size > 0
    && part.size <= PUBLIC_DOWNLOAD_LIMIT,
  );
}

/**
 * A failed desktop upload can produce several file rows for the same bytes.
 * Collapse those retries by content hash so the public catalog shows one card.
 * The oldest record wins, which keeps shared catalog links stable.
 */
function dedupeSourceItems(items: CatalogItem[]): CatalogItem[] {
  const byHash = new Map<string, CatalogItem>();
  const result: CatalogItem[] = [];

  for (const item of items) {
    if (!item.contentFingerprint) {
      result.push(item);
      continue;
    }

    const existing = byHash.get(item.contentFingerprint);
    if (!existing) {
      byHash.set(item.contentFingerprint, item);
      result.push(item);
      continue;
    }

    const existingCreated = existing.createdAt ?? existing.updatedAt;
    const itemCreated = item.createdAt ?? item.updatedAt;
    if (itemCreated < existingCreated || (itemCreated === existingCreated && item.id < existing.id)) {
      const index = result.indexOf(existing);
      if (index >= 0) result[index] = item;
      byHash.set(item.contentFingerprint, item);
    }
  }

  return result;
}

function normalizeCatalogItem(value: unknown): CatalogItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id).trim();
  const name = asString(raw.name).trim();
  const category = raw.category === 'audio' ? 'audio' : raw.category === 'video' ? 'video' : null;
  if (!UUID.test(id) || !name || !category) return null;

  const parts = normalizeParts(raw.parts);
  const size = asNumber(raw.size) ?? totalSize(parts);
  return {
    id,
    name,
    category,
    mimeType: asString(raw.mimeType, detectMimeType(name, category)) || detectMimeType(name, category),
    size: size > 0 ? size : totalSize(parts),
    duration: asNumber(raw.duration),
    hasThumbnail: raw.hasThumbnail === true || raw.has_thumbnail === true || raw.has_thumbnail === 1,
    updatedAt: asNumber(raw.updatedAt ?? raw.updated_at) ?? 0,
    artist: asString(raw.artist),
    album: asString(raw.album),
    description: asString(raw.description),
    format: asString(raw.format) || extensionOf(name) || undefined,
    ...(parts.length > 0 ? { parts } : {}),
  };
}

function itemFromSourceRecord(
  record: Record<string, unknown>,
  rawParts: unknown,
  rawBlob?: Record<string, unknown> | null,
): CatalogItem | null {
  if (record.trashed_at) return null;
  if (record.status !== undefined && record.status !== 'ready') return null;

  const id = asString(record.id).trim();
  const name = asString(record.name).trim();
  const category = record.category === 'audio' ? 'audio' : record.category === 'video' ? 'video' : null;
  if (!UUID.test(id) || !name || !category) return null;

  const parts = normalizeParts(rawParts);
  if (parts.length === 0) {
    warn(`Skipped "${name}" (${id}) because no uploaded parts were found.`);
    return null;
  }

  const metadata = metadataOf(record.metadata);
  const size = asNumber(record.size) ?? totalSize(parts);
  const updatedAt = asNumber(record.updated_at ?? record.updatedAt) ?? 0;
  const sourceFingerprint = asString(rawBlob?.sha256 ?? rawBlob?.content_hash ?? rawBlob?.contentHash)
    .trim()
    .toLowerCase();
  return {
    id,
    name,
    category,
    mimeType: asString(record.mime_type ?? record.mimeType, detectMimeType(name, category))
      || detectMimeType(name, category),
    size: size > 0 ? size : totalSize(parts),
    duration: asNumber(record.duration),
    hasThumbnail: record.has_thumbnail === true || record.has_thumbnail === 1
      || record.hasThumbnail === true,
    updatedAt,
    artist: asString(metadata.artist),
    album: asString(metadata.album),
    description: asString(record.description),
    format: asString(metadata.format) || extensionOf(name) || undefined,
    parts,
    ...(SHA256.test(sourceFingerprint) ? { contentFingerprint: sourceFingerprint } : {}),
    createdAt: asNumber(record.created_at ?? record.createdAt) ?? updatedAt,
  };
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
      // WSL is optional; fall through to the no-source path.
    }
  }

  return null;
}

function loadJsonSource(filePath: string): CatalogItem[] {
  if (!fs.existsSync(filePath)) return [];
  const data = readJson<{ files?: unknown[]; blobs?: unknown[]; parts?: unknown[] }>(filePath);
  if (!data) return [];

  const blobsById = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(data.blobs) ? data.blobs : []) {
    if (!value || typeof value !== 'object') continue;
    const blob = value as Record<string, unknown>;
    const blobId = asString(blob.id ?? blob.blob_id ?? blob.blobId).trim();
    if (blobId) blobsById.set(blobId, blob);
  }

  const partsByBlob = new Map<string, unknown[]>();
  for (const value of Array.isArray(data.parts) ? data.parts : []) {
    if (!value || typeof value !== 'object') continue;
    const part = value as Record<string, unknown>;
    const blobId = asString(part.blob_id ?? part.blobId).trim();
    if (!blobId) continue;
    const list = partsByBlob.get(blobId);
    if (list) list.push(part);
    else partsByBlob.set(blobId, [part]);
  }

  const items: CatalogItem[] = [];
  for (const value of Array.isArray(data.files) ? data.files : []) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const blobId = asString(record.blob_id ?? record.blobId).trim();
    const item = itemFromSourceRecord(
      record,
      partsByBlob.get(blobId) ?? [],
      blobsById.get(blobId) ?? null,
    );
    if (item) items.push(item);
  }
  return items;
}

function loadSqliteSource(filePath: string): CatalogItem[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const require = createRequire(import.meta.url);
    const Database = require(path.join(repoRoot, 'server/node_modules/better-sqlite3')) as new (
      filename: string,
      options?: { readonly?: boolean },
    ) => {
      prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
      close: () => void;
    };

    const database = new Database(filePath, { readonly: true });
    try {
      const rows = database.prepare(`
        SELECT *
        FROM files
        WHERE category IN ('video', 'audio')
          AND status = 'ready'
          AND trashed_at IS NULL
      `).all();

      const items: CatalogItem[] = [];
      const blobStatement = database.prepare('SELECT content_hash FROM blobs WHERE id = ?');
      for (const value of rows) {
        const record = value as Record<string, unknown>;
        const blobId = asString(record.blob_id).trim();
        const parts = blobId
          ? database.prepare('SELECT * FROM parts WHERE blob_id = ? ORDER BY idx ASC').all(blobId)
          : [];
        const blob = blobId ? (blobStatement.all(blobId)[0] as Record<string, unknown> | undefined) : undefined;
        const item = itemFromSourceRecord(record, parts, blob ?? null);
        if (item) items.push(item);
      }
      return items;
    } finally {
      database.close();
    }
  } catch (error) {
    warn(`SQLite source unavailable (${filePath}): ${(error as Error).message}`);
    return [];
  }
}

function loadEditions(): Map<string, EditionManifest> {
  const editions = new Map<string, EditionManifest>();
  if (!fs.existsSync(editionsDir)) return editions;

  for (const entry of fs.readdirSync(editionsDir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(editionsDir, entry);
    const data = readJson<Record<string, unknown>>(filePath);
    if (!data) continue;

    const fileId = asString(data.fileId ?? data.id).trim();
    const parts = normalizeParts(data.parts);
    if (!UUID.test(fileId) || parts.length === 0) {
      warn(`Skipped edition ${entry}: missing a valid fileId or parts.`);
      continue;
    }

    const name = asString(data.name).trim();
    const mimeType = asString(data.mimeType).trim();
    const contentFingerprint = asString(
      data.contentFingerprint ?? data.content_fingerprint ?? data.contentSha256 ?? data.content_sha256 ?? data.sha256,
    )
      .trim()
      .toLowerCase();
    editions.set(fileId, {
      fileId,
      ...(name ? { name } : {}),
      ...(mimeType ? { mimeType } : {}),
      size: asNumber(data.size) ?? totalSize(parts),
      duration: asNumber(data.duration),
      source: asString(data.source).trim() || undefined,
      ...(SHA256.test(contentFingerprint) ? { contentFingerprint } : {}),
      uploadedAt: asNumber(data.uploadedAt) ?? 0,
      parts,
    });
  }
  return editions;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function mediaSearchDirs(dataDir: string | null): string[] {
  const directories = new Set<string>();
  const configured = process.env.STREAM_MEDIA_DIRS;
  if (configured) {
    for (const entry of configured.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (trimmed) directories.add(trimmed);
    }
  }

  if (dataDir) {
    const userRoot = path.resolve(dataDir, '../../../..');
    for (const folder of [
      'Videos',
      'Videos/extracted_videos',
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
  }
  return [...directories];
}

function findLocalMedia(name: string, directories: string[], hint?: string): string | null {
  if (hint && isFile(hint)) return hint;
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

function probeDuration(filePath: string): number | null {
  if (durationCache.has(filePath)) return durationCache.get(filePath) ?? null;
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
    { encoding: 'utf8', timeout: 20_000 },
  );
  const seconds = result.status === 0 ? Number.parseFloat(result.stdout.trim()) : Number.NaN;
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  durationCache.set(filePath, value);
  return value;
}

function readExistingCatalog(): CatalogItem[] {
  if (!fs.existsSync(outPath)) return [];
  const data = readJson<unknown>(outPath);
  if (!data) return [];
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)
      ? (data as { items: unknown[] }).items
      : [];
  return list
    .map(normalizeCatalogItem)
    .filter((item): item is CatalogItem => item !== null);
}

function main(): void {
  const dataDir = discoverDataDir();
  const jsonPaths: string[] = [];
  const explicitJson = process.env.TELEDRIVE_JSON?.trim();
  if (explicitJson) {
    jsonPaths.push(...explicitJson.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean));
  } else if (dataDir) {
    jsonPaths.push(path.join(dataDir, 'teledrive.json'));
  }

  const sqlitePath = process.env.TELEDRIVE_SQLITE?.trim()
    || path.join(repoRoot, 'data/teledrive.db');

  const availableSources = [
    ...jsonPaths.filter((filePath) => fs.existsSync(filePath)),
    ...(fs.existsSync(sqlitePath) ? [sqlitePath] : []),
  ];

  if (availableSources.length === 0) {
    warn('No TeleDrive data source found; keeping the existing catalog unchanged.');
    return;
  }

  const sourceItems = new Map<string, CatalogItem>();
  const addItems = (items: CatalogItem[]) => {
    for (const item of items) {
      const existing = sourceItems.get(item.id);
      if (!existing || item.updatedAt >= existing.updatedAt) sourceItems.set(item.id, item);
    }
  };

  for (const filePath of jsonPaths) addItems(loadJsonSource(filePath));
  addItems(loadSqliteSource(sqlitePath));

  if (sourceItems.size === 0 && !process.argv.includes('--allow-empty')) {
    warn('The configured TeleDrive sources contain no playable video or audio; keeping the existing catalog unchanged.');
    return;
  }

  const sourceList = dedupeSourceItems([...sourceItems.values()]);
  if (sourceList.length < sourceItems.size) {
    console.log(`[catalog] Collapsed ${sourceItems.size - sourceList.length} duplicate upload(s) with identical content.`);
  }

  const existingItems = readExistingCatalog();
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const editions = loadEditions();
  const editionsByFingerprint = new Map<string, EditionManifest>();
  for (const edition of editions.values()) {
    if (edition.contentFingerprint && !editionsByFingerprint.has(edition.contentFingerprint)) {
      editionsByFingerprint.set(edition.contentFingerprint, edition);
    }
  }
  const searchDirs = mediaSearchDirs(dataDir);
  const merged: CatalogItem[] = [];

  for (const source of sourceList) {
    const existing = existingById.get(source.id);
    const edition = editions.get(source.id)
      ?? (source.contentFingerprint ? editionsByFingerprint.get(source.contentFingerprint) : undefined);
    const sourceParts = source.parts ?? [];
    const existingParts = existing?.parts ?? [];

    let parts: CatalogPart[] = [];
    let partsOrigin: 'edition' | 'source' | 'existing' = 'source';
    if (edition) {
      parts = edition.parts;
      partsOrigin = 'edition';
    } else if (hasPlayableParts(sourceParts)) {
      parts = sourceParts;
    } else if (hasPlayableParts(existingParts)) {
      parts = existingParts;
      partsOrigin = 'existing';
    } else if (sourceParts.length > 0) {
      parts = sourceParts;
    } else {
      parts = existingParts;
      partsOrigin = 'existing';
    }

    const name = edition?.name
      || (partsOrigin === 'existing' ? existing?.name : undefined)
      || source.name;
    const mimeType = edition?.mimeType
      || (partsOrigin === 'existing' ? existing?.mimeType : undefined)
      || source.mimeType
      || detectMimeType(name, source.category);
    const size = parts.length > 0 ? totalSize(parts) : source.size || existing?.size || 0;
    const localMedia = findLocalMedia(name, searchDirs, edition?.source)
      ?? findLocalMedia(source.name, searchDirs);
    const duration = (localMedia ? probeDuration(localMedia) : null)
      ?? edition?.duration
      ?? source.duration
      ?? existing?.duration
      ?? null;

    if (!hasPlayableParts(parts)) {
      warn(`"${name}" uses parts larger than 20 MB or missing Telegram file IDs; hosted playback may need a cloud edition.`);
    }

    merged.push({
      id: source.id,
      name,
      category: source.category,
      mimeType,
      size,
      duration,
      hasThumbnail: source.hasThumbnail || existing?.hasThumbnail === true,
      updatedAt: Math.max(source.updatedAt, existing?.updatedAt ?? 0, edition?.uploadedAt ?? 0),
      artist: source.artist || existing?.artist || '',
      album: source.album || existing?.album || '',
      description: source.description || '',
      format: extensionOf(name) || source.format || existing?.format || undefined,
      ...(parts.length > 0 ? { parts } : {}),
    });
  }

  merged.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));

  const document = { items: merged, series: [] as unknown[] };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`[catalog] Exported ${merged.length} media item(s) from ${sourceList.length} unique source record(s) to ${outPath}`);
}

main();
