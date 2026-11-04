import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const APP_VERSION = '3.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// server/src (or server/dist after build) -> repo root
export const REPO_ROOT = path.resolve(HERE, '..', '..');

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

const rawSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DATA_DIR: z.string().default('./data'),
  TRUST_PROXY: z.string().default('false'),
  STATIC_DIR: z.string().default('./web/dist'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_PASSWORD_HASH: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  TELEGRAM_API_ID: z.string().default(''),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_BOT_API_URL: z.string().default('http://127.0.0.1:8081'),
  TELEGRAM_BOT_API_DIR: z.string().default('/var/lib/telegram-bot-api'),
  TELEGRAM_BOT_API_PATH_MAP: z.string().default(''),
  TELEGRAM_BOT_TOKENS: z.string().default(''),
  TELEGRAM_CHANNEL_ID: z.string().default(''),
  PART_SIZE_MB: z.coerce.number().positive().default(512),
  UPLOAD_SLICE_SIZE_MB: z.coerce.number().positive().default(32),
  CLIENT_UPLOAD_CONCURRENCY: z.coerce.number().int().positive().default(4),
  TELEGRAM_UPLOAD_CONCURRENCY: z.coerce.number().int().min(0).default(0),
  BOT_MAX_CONCURRENT_UPLOADS: z.coerce.number().int().positive().default(2),
  DOWNLOAD_PARALLEL_PARTS: z.coerce.number().int().min(1).max(16).default(3),
  MAX_FILE_SIZE_GB: z.coerce.number().min(0).default(0),
  MIN_FREE_DISK_MB: z.coerce.number().min(0).default(2048),
  CACHE_MAX_GB: z.coerce.number().min(0).default(20),
  PREFETCH_NEXT_PART: z.string().default('true'),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().positive().default(48),
  TRASH_RETENTION_DAYS: z.coerce.number().min(0).default(30),
  THUMBNAIL_SIZE: z.coerce.number().int().positive().default(480),
  FFMPEG_PATH: z.string().default(''),
  FFPROBE_PATH: z.string().default(''),
  BACKUP_ENABLED: z.string().default('true'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  BACKUP_KEEP: z.coerce.number().int().min(0).default(7),
  LOG_LEVEL: z.string().default('info'),
});

export interface AppConfig {
  nodeEnv: 'production' | 'development' | 'test';
  host: string;
  port: number;
  publicUrl: string;
  secureCookies: boolean;
  dataDir: string;
  trustProxy: boolean;
  staticDir: string;
  adminUsername: string;
  adminPassword: string;
  adminPasswordHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  telegramApiId: string;
  telegramApiHash: string;
  telegramBotApiUrl: string;
  telegramBotApiDir: string;
  telegramBotApiPathMap: string;
  botTokens: string[];
  channelId: string;
  partSize: number;
  /** Upper bound for PART_SIZE_MB for the configured Bot API server. */
  partSizeMaxMb: number;
  isLocalBotApi: boolean;
  sliceSize: number;
  clientUploadConcurrency: number;
  /** 0 = auto (healthy bots × botMaxConcurrentUploads) */
  telegramUploadConcurrency: number;
  botMaxConcurrentUploads: number;
  /** parts fetched concurrently (across bots) while streaming/downloading */
  downloadParallelParts: number;
  maxFileSize: number; // bytes; 0 = unlimited
  minFreeDisk: number;
  cacheMaxBytes: number;
  prefetchNextPart: boolean;
  uploadSessionTtlMs: number;
  trashRetentionDays: number;
  thumbnailSize: number;
  ffmpegPath: string;
  ffprobePath: string;
  backupEnabled: boolean;
  backupIntervalMs: number;
  backupKeep: number;
  logLevel: string;
  version: string;
  /** non-fatal config notes, logged at startup */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super('Invalid configuration:\n' + issues.map((i) => `  - ${i}`).join('\n'));
    this.name = 'ConfigError';
  }
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const MIN_PART_SIZE_MB = 5;
export const MAX_LOCAL_PART_SIZE_MB = 2000;
/** Safe ceiling for the public Telegram Bot API (hard limit is 50 MB). */
export const MAX_CLOUD_PART_SIZE_MB = 45;

function parseBool(v: string): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

/** A self-hosted/local Bot API can accept documents up to 2 GB. */
export function isLocalBotApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname !== 'api.telegram.org';
  } catch {
    return false;
  }
}

export function maxPartSizeMbFor(url: string): number {
  return isLocalBotApiUrl(url) ? MAX_LOCAL_PART_SIZE_MB : MAX_CLOUD_PART_SIZE_MB;
}

export function clampPartSizeMb(value: number, url: string): number {
  const max = maxPartSizeMbFor(url);
  const n = Number.isFinite(value) ? Math.round(value) : max;
  return Math.min(max, Math.max(MIN_PART_SIZE_MB, n));
}

function resolveDir(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export function maskToken(token: string): string {
  const id = token.split(':')[0] ?? '';
  return `${id}:***`;
}

export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  const issues: string[] = [];

  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
    throw new ConfigError(issues);
  }
  const raw = parsed.data;

  const warnings: string[] = [];
  const tokens: string[] = [];
  const seenBots = new Set<string>();
  for (const t of raw.TELEGRAM_BOT_TOKENS.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const id = t.split(':')[0] ?? t;
    if (seenBots.has(id)) {
      warnings.push(`TELEGRAM_BOT_TOKENS: duplicate bot ${maskToken(t)} ignored`);
      continue;
    }
    seenBots.add(id);
    tokens.push(t);
  }
  if (tokens.length === 0) {
    issues.push('TELEGRAM_BOT_TOKENS: at least one bot token is required');
  }
  for (const t of tokens) {
    if (!TOKEN_RE.test(t)) {
      issues.push(`TELEGRAM_BOT_TOKENS: invalid token format (${maskToken(t)})`);
    }
  }
  if (!raw.TELEGRAM_CHANNEL_ID.startsWith('-100')) {
    issues.push('TELEGRAM_CHANNEL_ID: must start with -100 (private channel id)');
  }
  if (!raw.ADMIN_PASSWORD && !raw.ADMIN_PASSWORD_HASH) {
    issues.push('ADMIN_PASSWORD or ADMIN_PASSWORD_HASH is required');
  }
  if (raw.ADMIN_PASSWORD && raw.ADMIN_PASSWORD.length < 5) {
    issues.push('ADMIN_PASSWORD: must be at least 5 characters');
  }
  if (raw.SESSION_SECRET.length < 32) {
    issues.push('SESSION_SECRET: must be at least 32 characters');
  }
  if (raw.PART_SIZE_MB > MAX_LOCAL_PART_SIZE_MB) {
    issues.push(`PART_SIZE_MB: must be <= ${MAX_LOCAL_PART_SIZE_MB} (Telegram document size limit)`);
  }
  if (raw.UPLOAD_SLICE_SIZE_MB > raw.PART_SIZE_MB) {
    issues.push('UPLOAD_SLICE_SIZE_MB: must be <= PART_SIZE_MB');
  }
  let publicUrl = raw.PUBLIC_URL.replace(/\/+$/, '');
  try {
    new URL(publicUrl);
  } catch {
    issues.push('PUBLIC_URL: not a valid URL');
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const isLocalBotApi = isLocalBotApiUrl(raw.TELEGRAM_BOT_API_URL);
  const partSizeMaxMb = maxPartSizeMbFor(raw.TELEGRAM_BOT_API_URL);
  let partSizeMb = raw.PART_SIZE_MB;
  if (partSizeMb > partSizeMaxMb) {
    warnings.push(
      `PART_SIZE_MB=${partSizeMb} exceeds the safe limit for ${isLocalBotApi ? 'a local' : 'the public'} Bot API; using ${partSizeMaxMb} MB`,
    );
    partSizeMb = partSizeMaxMb;
  }

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir: resolveDir(raw.DATA_DIR),
    trustProxy: parseBool(raw.TRUST_PROXY),
    staticDir: resolveDir(raw.STATIC_DIR),
    adminUsername: raw.ADMIN_USERNAME,
    adminPassword: raw.ADMIN_PASSWORD,
    adminPasswordHash: raw.ADMIN_PASSWORD_HASH,
    sessionSecret: raw.SESSION_SECRET,
    sessionTtlMs: raw.SESSION_TTL_DAYS * 24 * 3600 * 1000,
    telegramApiId: raw.TELEGRAM_API_ID,
    telegramApiHash: raw.TELEGRAM_API_HASH,
    telegramBotApiUrl: raw.TELEGRAM_BOT_API_URL.replace(/\/+$/, ''),
    telegramBotApiDir: resolveDir(raw.TELEGRAM_BOT_API_DIR),
    telegramBotApiPathMap: raw.TELEGRAM_BOT_API_PATH_MAP,
    botTokens: tokens,
    channelId: raw.TELEGRAM_CHANNEL_ID,
    partSize: Math.floor(partSizeMb * MIB),
    partSizeMaxMb,
    isLocalBotApi,
    sliceSize: Math.floor(raw.UPLOAD_SLICE_SIZE_MB * MIB),
    clientUploadConcurrency: raw.CLIENT_UPLOAD_CONCURRENCY,
    telegramUploadConcurrency: raw.TELEGRAM_UPLOAD_CONCURRENCY,
    botMaxConcurrentUploads: raw.BOT_MAX_CONCURRENT_UPLOADS,
    downloadParallelParts: raw.DOWNLOAD_PARALLEL_PARTS,
    maxFileSize: Math.floor(raw.MAX_FILE_SIZE_GB * GIB),
    minFreeDisk: Math.floor(raw.MIN_FREE_DISK_MB * MIB),
    cacheMaxBytes: Math.floor(raw.CACHE_MAX_GB * GIB),
    prefetchNextPart: parseBool(raw.PREFETCH_NEXT_PART),
    uploadSessionTtlMs: raw.UPLOAD_SESSION_TTL_HOURS * 3600 * 1000,
    trashRetentionDays: raw.TRASH_RETENTION_DAYS,
    thumbnailSize: raw.THUMBNAIL_SIZE,
    ffmpegPath: raw.FFMPEG_PATH,
    ffprobePath: raw.FFPROBE_PATH,
    backupEnabled: parseBool(raw.BACKUP_ENABLED),
    backupIntervalMs: raw.BACKUP_INTERVAL_HOURS * 3600 * 1000,
    backupKeep: raw.BACKUP_KEEP,
    logLevel: raw.LOG_LEVEL,
    version: APP_VERSION,
    warnings,
  };
}
