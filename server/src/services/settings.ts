import type { AppConfig } from '../config.js';
import { clampPartSizeMb, maxPartSizeMbFor, MIN_PART_SIZE_MB } from '../config.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/repos/misc.js';

export const MAX_CLIENT_UPLOAD_CONCURRENCY = 32;
export const MAX_TELEGRAM_UPLOAD_CONCURRENCY = 64;
export const MAX_BOT_CONCURRENT_UPLOADS = 8;

/** Keys that tune the upload pipeline at runtime. */
export const UPLOAD_SETTING_KEYS = [
  'partSizeMb',
  'uploadConcurrency',
  'telegramUploadConcurrency',
  'botMaxConcurrentUploads',
] as const;

export type UploadSettingKey = (typeof UPLOAD_SETTING_KEYS)[number];

function storedNumber(db: Db, key: string): number | null {
  const raw = getSetting(db, key);
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const n = typeof parsed === 'number' ? parsed : Number(parsed);
    return Number.isFinite(n) ? n : null;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
}

function intInRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Apply values saved from the Settings screen to the live config. */
export function applyPersistedSettings(config: AppConfig, db: Db): void {
  const partSizeMb = storedNumber(db, 'partSizeMb');
  if (partSizeMb !== null) config.partSize = clampPartSizeMb(partSizeMb, config.telegramBotApiUrl) * 1024 * 1024;

  const client = storedNumber(db, 'uploadConcurrency');
  if (client !== null) {
    config.clientUploadConcurrency = intInRange(client, 1, MAX_CLIENT_UPLOAD_CONCURRENCY);
  }

  const telegram = storedNumber(db, 'telegramUploadConcurrency');
  if (telegram !== null) {
    config.telegramUploadConcurrency = intInRange(telegram, 0, MAX_TELEGRAM_UPLOAD_CONCURRENCY);
  }

  const perBot = storedNumber(db, 'botMaxConcurrentUploads');
  if (perBot !== null) {
    config.botMaxConcurrentUploads = intInRange(perBot, 1, MAX_BOT_CONCURRENT_UPLOADS);
  }
}

export interface UploadSettingsSnapshot {
  partSizeMb: number;
  effectivePartSizeMb: number;
  minAllowedMb: number;
  maxAllowedMb: number;
  isLocalBotApi: boolean;
  sliceSizeMb: number;
  uploadConcurrency: number;
  telegramUploadConcurrency: number;
  botMaxConcurrentUploads: number;
}

export function uploadSettingsSnapshot(config: AppConfig): UploadSettingsSnapshot {
  const maxAllowedMb = maxPartSizeMbFor(config.telegramBotApiUrl);
  const partSizeMb = Math.round(config.partSize / 1024 / 1024);
  return {
    partSizeMb,
    effectivePartSizeMb: Math.min(Math.max(partSizeMb, MIN_PART_SIZE_MB), maxAllowedMb),
    minAllowedMb: MIN_PART_SIZE_MB,
    maxAllowedMb,
    isLocalBotApi: config.isLocalBotApi,
    sliceSizeMb: Math.round((config.sliceSize / 1024 / 1024) * 10) / 10,
    uploadConcurrency: config.clientUploadConcurrency,
    telegramUploadConcurrency: config.telegramUploadConcurrency,
    botMaxConcurrentUploads: config.botMaxConcurrentUploads,
  };
}

function readNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate + persist upload tuning values, then apply them immediately.
 * Invalid values are rejected; out-of-range values are clamped so the UI can
 * always show the value that is actually in effect.
 */
export function updateUploadSettings(
  config: AppConfig,
  db: Db,
  patch: Record<string, unknown>,
): UploadSettingsSnapshot {
  const next: Partial<Record<UploadSettingKey, number>> = {};

  for (const key of UPLOAD_SETTING_KEYS) {
    if (!(key in patch)) continue;
    const raw = readNumeric(patch[key]);
    if (raw === null) throw new Error(`${key} must be a finite number`);
    switch (key) {
      case 'partSizeMb':
        next.partSizeMb = clampPartSizeMb(raw, config.telegramBotApiUrl);
        break;
      case 'uploadConcurrency':
        next.uploadConcurrency = intInRange(raw, 1, MAX_CLIENT_UPLOAD_CONCURRENCY);
        break;
      case 'telegramUploadConcurrency':
        next.telegramUploadConcurrency = intInRange(raw, 0, MAX_TELEGRAM_UPLOAD_CONCURRENCY);
        break;
      case 'botMaxConcurrentUploads':
        next.botMaxConcurrentUploads = intInRange(raw, 1, MAX_BOT_CONCURRENT_UPLOADS);
        break;
    }
  }

  if (next.partSizeMb !== undefined) {
    config.partSize = next.partSizeMb * 1024 * 1024;
    setSetting(db, 'partSizeMb', JSON.stringify(next.partSizeMb));
  }
  if (next.uploadConcurrency !== undefined) {
    config.clientUploadConcurrency = next.uploadConcurrency;
    setSetting(db, 'uploadConcurrency', JSON.stringify(next.uploadConcurrency));
  }
  if (next.telegramUploadConcurrency !== undefined) {
    config.telegramUploadConcurrency = next.telegramUploadConcurrency;
    setSetting(db, 'telegramUploadConcurrency', JSON.stringify(next.telegramUploadConcurrency));
  }
  if (next.botMaxConcurrentUploads !== undefined) {
    config.botMaxConcurrentUploads = next.botMaxConcurrentUploads;
    setSetting(db, 'botMaxConcurrentUploads', JSON.stringify(next.botMaxConcurrentUploads));
  }

  return uploadSettingsSnapshot(config);
}
