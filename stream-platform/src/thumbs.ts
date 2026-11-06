import { useEffect, useSyncExternalStore } from 'react';
import type { MediaItem } from './library';

const DB_NAME = 'folio-art-cache';
const STORE = 'frames';
const DB_VERSION = 1;
const KEY_PREFIX = 'frame:v2:';
const MAX_ACTIVE = 2;
const MAX_CACHE_ENTRIES = 90;
const CAPTURE_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi', 'ts']);
const CAPTURE_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'video/mp2t']);

interface StoredFrame {
  key: string;
  id: string;
  updatedAt: number;
  data: string;
  createdAt: number;
}

interface CaptureJob {
  item: MediaItem;
  resolve: (value: string | null) => void;
}

const memory = new Map<string, string>();
const failed = new Set<string>();
const inFlight = new Map<string, Promise<string | null>>();
const queue: CaptureJob[] = [];
const listeners = new Set<() => void>();

let activeCaptures = 0;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function keyFor(item: MediaItem): string {
  return `${KEY_PREFIX}${item.id}:${Math.max(0, Math.floor(item.updatedAt || 0))}`;
}

function emit() {
  for (const listener of listeners) listener();
}

function remember(key: string, data: string) {
  memory.set(key, data);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function canCapture(item: MediaItem): boolean {
  if (item.category !== 'video') return false;
  const extension = (item.name.split('.').pop() ?? '').toLowerCase();
  return CAPTURE_MIME_TYPES.has(item.mimeType) || CAPTURE_EXTENSIONS.has(extension);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : database.createObjectStore(STORE, { keyPath: 'key' });
      if (!store.indexNames.contains('id')) store.createIndex('id', 'id', { unique: false });
      if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt', { unique: false });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function readStoredFrame(key: string): Promise<string | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => {
        const value = request.result as StoredFrame | undefined;
        resolve(typeof value?.data === 'string' ? value.data : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function prune(database: IDBDatabase) {
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let excess = countRequest.result - MAX_CACHE_ENTRIES;
      if (excess <= 0) return;
      const cursorRequest = store.index('createdAt').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    };
  } catch {
    // Cache pruning is best-effort.
  }
}

async function storeFrame(item: MediaItem, data: string) {
  const database = await openDatabase();
  if (!database) return;
  const key = keyFor(item);
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.put({
      key,
      id: item.id,
      updatedAt: item.updatedAt,
      data,
      createdAt: Date.now(),
    } satisfies StoredFrame);

    const cursorRequest = store.index('id').openCursor(IDBKeyRange.only(item.id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const value = cursor.value as StoredFrame;
      if (value.key !== key) cursor.delete();
      cursor.continue();
    };

    transaction.oncomplete = () => prune(database);
  } catch {
    // Cache writes are best-effort.
  }
}

function waitForEvent(target: HTMLVideoElement, event: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const onSuccess = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onSuccess);
      target.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onSuccess);
      target.removeEventListener('error', onError);
      reject(new Error('The video could not be decoded'));
    };
    timer = window.setTimeout(() => {
      target.removeEventListener(event, onSuccess);
      target.removeEventListener('error', onError);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    target.addEventListener(event, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  const withFrameCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fallback = window.setTimeout(finish, 700);
    if (typeof withFrameCallback.requestVideoFrameCallback === 'function') {
      withFrameCallback.requestVideoFrameCallback(() => {
        window.clearTimeout(fallback);
        finish();
      });
    } else {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        finish();
      }));
    }
  });
}

async function captureFrame(item: MediaItem): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = `/api/media/${item.id}`;

  try {
    await waitForEvent(video, 'loadedmetadata', 12_000);
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : (item.duration ?? 0);
    if (!duration) return null;

    const target = Math.min(
      Math.max(duration * 0.18, Math.min(4, duration * 0.4)),
      Math.max(0, duration - 0.4),
    );
    video.currentTime = target;
    await waitForEvent(video, 'seeked', 9_000);
    await video.play().catch(() => undefined);
    await waitForFrame(video);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, 720 / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function pump() {
  while (activeCaptures < MAX_ACTIVE && queue.length > 0) {
    const job = queue.shift()!;
    activeCaptures += 1;
    void captureFrame(job.item)
      .then((data) => {
        if (data) void storeFrame(job.item, data);
        else failed.add(keyFor(job.item));
        job.resolve(data);
      })
      .catch(() => {
        failed.add(keyFor(job.item));
        job.resolve(null);
      })
      .finally(() => {
        activeCaptures -= 1;
        pump();
      });
  }
}

function queueCapture(item: MediaItem): Promise<string | null> {
  const key = keyFor(item);
  const current = inFlight.get(key);
  if (current) return current;

  const promise = new Promise<string | null>((resolve) => {
    queue.push({ item, resolve });
    pump();
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function hydrateFrame(item: MediaItem): Promise<string | null> {
  const key = keyFor(item);
  const stored = await readStoredFrame(key);
  if (stored) return stored;
  if (!canCapture(item)) return null;
  return queueCapture(item);
}

/**
 * Returns a captured frame for a video when one is available. When enabled,
 * it also lazily reads the persistent cache and queues a frame capture.
 * Frames are keyed by item id + update time so replaced media is refreshed.
 */
export function useCapturedFrame(item: MediaItem | null | undefined, enabled: boolean): string | null {
  const key = item ? keyFor(item) : '';
  const frame = useSyncExternalStore(
    subscribe,
    () => (key ? memory.get(key) ?? null : null),
    () => null,
  );

  useEffect(() => {
    if (!item || !enabled || !key || memory.has(key) || failed.has(key)) return;
    let cancelled = false;
    void hydrateFrame(item).then((data) => {
      if (!cancelled && data) remember(key, data);
    });
    return () => { cancelled = true; };
  }, [key, enabled, item]);

  return frame;
}
