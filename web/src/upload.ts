// Upload engine: resumable slice uploads over XHR with progress events.
// Scheduling is split in two:
//   - a file limiter bounds how many files upload at once,
//   - a shared slice limiter bounds concurrent HTTP slice PUTs.
// Both limits come from /api/config and can be changed at runtime. A paused
// upload releases its file and slice slots so it never blocks other transfers.
import { create } from 'zustand';
import { api, type UploadDTO, type Config, ApiError } from './api';
import { toast, useUi, useDialog, type FileDTO } from './store';
import { queryClient } from './query';
import { requestVideoThumbnail } from './videoThumb';

export type UploadStatus =
  | 'queued' | 'creating' | 'uploading' | 'paused' | 'processing'
  | 'done' | 'failed' | 'cancelled' | 'server-failed';

export interface UploadTask {
  key: string;
  clientKey?: string;
  name: string;
  size: number;
  status: UploadStatus;
  uploaded: number; // confirmed + in-flight bytes
  speed: number; // smoothed bytes/s over ~5s window
  eta: number; // seconds
  error?: string;
  file?: File;
  uploadId?: string;
  fileId?: string;
  partsStored: number;
  partsTotal: number;
  slicesDone: number;
  slicesTotal: number;
  relativePath?: string;
  folderId?: string | null;
  noLocalFile?: boolean; // server-side upload awaiting a re-selected File
  native?: boolean; // Rust desktop feeds this upload from disk — no browser slicing
}

interface UploadStore {
  tasks: UploadTask[];
  panelOpen: boolean;
  panelCollapsed: boolean;
  setPanel: (v: { open?: boolean; collapsed?: boolean }) => void;
  update: (key: string, p: Partial<UploadTask>) => void;
  remove: (key: string) => void;
  addTask: (t: UploadTask) => void;
}
export const useUploads = create<UploadStore>()((set) => ({
  tasks: [], panelOpen: false, panelCollapsed: false,
  setPanel: ({ open, collapsed }) => set((s) => ({ panelOpen: open ?? s.panelOpen, panelCollapsed: collapsed ?? s.panelCollapsed })),
  update: (key, p) => set((s) => {
    const cur = s.tasks.find((t) => t.key === key);
    if (!cur) return s;
    let changed = false;
    for (const k in p) {
      if ((p as any)[k] !== (cur as any)[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return s;
    return { tasks: s.tasks.map((t) => (t.key === key ? { ...t, ...p } : t)) };
  }),
  remove: (key) => set((s) => ({ tasks: s.tasks.filter((t) => t.key !== key) })),
  addTask: (t) => set((s) => ({ tasks: [...s.tasks.filter((x) => x.key !== t.key), t], panelOpen: true, panelCollapsed: false })),
}));

let config: Config | null = null;

function applyConfig(cfg: Config): Config {
  const n = Number.isFinite(cfg.uploadConcurrency) ? Math.round(cfg.uploadConcurrency) : 4;
  const limit = Math.min(32, Math.max(1, n));
  resizeLimiter(sliceLimiter, limit);
  resizeLimiter(fileLimiter, limit);
  return cfg;
}

export async function getConfig(): Promise<Config> {
  if (!config) config = applyConfig(await api.get<Config>('/api/config'));
  return config;
}
export function resetConfigCache() { config = null; }
/** Re-read /api/config (after changing upload tuning) and resize live limits. */
export async function refreshUploadConfig(): Promise<Config> {
  config = applyConfig(await api.get<Config>('/api/config'));
  return config;
}

// ---------- generic limiter (resizable, pause-safe) ----------
interface Limiter {
  active: number;
  limit: number;
  waiters: (() => void)[];
}
function makeLimiter(limit: number): Limiter {
  return { active: 0, limit: Math.max(1, limit), waiters: [] };
}
function drainLimiter(l: Limiter): void {
  while (l.active < l.limit && l.waiters.length > 0) {
    const waiter = l.waiters.shift()!;
    l.active++;
    waiter();
  }
}
function resizeLimiter(l: Limiter, limit: number): void {
  l.limit = Math.max(1, Math.floor(limit));
  drainLimiter(l);
}
function acquire(l: Limiter): Promise<void> {
  if (l.active < l.limit) {
    l.active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => l.waiters.push(resolve));
}
function release(l: Limiter): void {
  l.active = Math.max(0, l.active - 1);
  drainLimiter(l);
}

const sliceLimiter = makeLimiter(6);
const fileLimiter = makeLimiter(6);

interface Runner {
  aborted: boolean;
  paused: boolean;
  xhrs: Set<XMLHttpRequest>;
  resumeWaiters: (() => void)[];
  uploadId?: string;
  fileId?: string;
}
const runners = new Map<string, Runner>();

class PauseSignal extends Error {
  constructor() { super('paused'); this.name = 'PauseSignal'; }
}

function isAbortError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === 'aborted' || (e as { pauseAbort?: boolean })?.pauseAbort === true || e instanceof PauseSignal;
}

function waitIfPaused(runner: Runner): Promise<void> {
  if (!runner.paused || runner.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => runner.resumeWaiters.push(resolve));
}

function wakePaused(runner: Runner): void {
  if (runner.paused) return;
  const waiters = runner.resumeWaiters;
  runner.resumeWaiters = [];
  for (const w of waiters) w();
}

// ---------- progress accounting ----------
interface Progress {
  confirmed: number; // bytes of slices already received (incl. pre-existing)
  received: Set<string>; // `part:slice` keys known to be on the server
  inflight: Map<string, number>; // sliceKey -> loaded bytes
  samples: { t: number; bytes: number }[];
  lastEmit: number;
  smoothedSpeed: number;
}
const progressMap = new Map<string, Progress>();

function progressTotal(p: Progress): number {
  let n = p.confirmed;
  for (const v of p.inflight.values()) n += v;
  return n;
}

function emitProgress(key: string, task: UploadTask | undefined, force = false) {
  const p = progressMap.get(key);
  if (!p || !task) return;
  const now = Date.now();
  const total = progressTotal(p);
  p.samples.push({ t: now, bytes: total });
  const cutoff = now - 3500;
  while (p.samples.length > 2 && p.samples[0]!.t < cutoff) p.samples.shift();
  if (!force && now - p.lastEmit < 200) return;
  p.lastEmit = now;
  const first = p.samples[0]!;
  const dt = (now - first.t) / 1000;
  const rawSpeed = dt > 0.2 ? Math.max(0, (total - first.bytes) / dt) : 0;
  if (rawSpeed > 0) {
    p.smoothedSpeed = p.smoothedSpeed > 0 ? (0.35 * rawSpeed + 0.65 * p.smoothedSpeed) : rawSpeed;
  } else if (p.smoothedSpeed > 0) {
    p.smoothedSpeed = Math.max(0, p.smoothedSpeed * 0.92);
  }
  const uploaded = Math.min(task.size, Math.max(task.uploaded ?? 0, total));
  const remaining = Math.max(0, task.size - uploaded);
  const eta = p.smoothedSpeed > 1000 ? Math.ceil(remaining / p.smoothedSpeed) : 0;

  useUploads.getState().update(key, {
    uploaded,
    speed: Math.round(p.smoothedSpeed),
    eta,
  });
}

export function clientKey(f: { name: string; size: number; lastModified?: number }) {
  return `${f.name}|${f.size}|${f.lastModified ?? ''}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- slice send ----------
async function sendSlice(
  runner: Runner,
  url: string,
  blob: Blob,
  sliceKey: string,
  prog: Progress,
  onProgress?: () => void,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    if (runner.aborted) throw new Error('aborted');
    if (runner.paused) throw new PauseSignal();
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        runner.xhrs.add(xhr);
        prog.inflight.set(sliceKey, 0);
        xhr.open('PUT', url);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('x-requested-with', 'teledrive');
        xhr.upload.onprogress = (e) => {
          prog.inflight.set(sliceKey, e.loaded);
          onProgress?.();
        };
        xhr.onload = () => {
          runner.xhrs.delete(xhr);
          if (xhr.status >= 200 && xhr.status < 300) {
            prog.inflight.delete(sliceKey);
            if (!prog.received.has(sliceKey)) {
              prog.received.add(sliceKey);
              prog.confirmed += blob.size;
            }
            resolve();
            return;
          }
          let message = `HTTP ${xhr.status}`;
          try {
            const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
            if (body?.error?.message) message = body.error.message;
          } catch { /* non-JSON error body */ }
          reject(Object.assign(new Error(message), { status: xhr.status }));
        };
        xhr.onerror = () => { runner.xhrs.delete(xhr); reject(Object.assign(new Error('network error'), { status: 0 })); };
        xhr.onabort = () => { runner.xhrs.delete(xhr); reject(Object.assign(new Error('aborted'), { pauseAbort: true })); };
        xhr.send(blob);
      });
      prog.inflight.delete(sliceKey);
      return;
    } catch (e) {
      const err = e as Error & { status?: number; pauseAbort?: boolean };
      prog.inflight.delete(sliceKey);
      // An XHR killed by pause()/cancel() is not a failure. Keep the runner
      // alive on pause so resumeUpload() can wake the waiting pass; only
      // cancel aborts it for good.
      if (runner.aborted) throw new Error('aborted');
      if (runner.paused || err.pauseAbort) throw new PauseSignal();
      if (err.status === 507) {
        toast.info('Server disk full — waiting 30s');
        await sleep(30_000);
        continue;
      }
      if (err.status === 503) { await sleep(15_000); continue; }
      // Permanent request errors cannot be fixed by resending the same body.
      if (err.status === 400 || err.status === 401 || err.status === 403
        || err.status === 404 || err.status === 410 || err.status === 413 || err.status === 416) {
        throw err;
      }
      if (++attempt >= 6) throw err;
      await sleep(Math.min(1000 * 2 ** attempt, 15_000));
    }
  }
}

// ---------- public API ----------
export function startUpload(
  file: File,
  opts: { folderId?: string | null; relativePath?: string; uploadId?: string; fileId?: string; key?: string; onConflict?: 'rename' | 'replace' | 'error' } = {},
): string {
  const key = opts.key ?? `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
  // A resumed session reuses the interrupted task key so the panel replaces
  // the old paused row instead of showing two entries for the same upload.
  const runner: Runner = {
    aborted: false,
    paused: false,
    xhrs: new Set(),
    resumeWaiters: [],
    uploadId: opts.uploadId,
  };
  runners.set(key, runner);
  const task: UploadTask = {
    key, clientKey: clientKey(file), name: file.name, size: file.size, status: 'queued', uploaded: 0,
    speed: 0, eta: 0, file, fileId: opts.fileId, uploadId: opts.uploadId,
    partsStored: 0, partsTotal: 0, slicesDone: 0, slicesTotal: 0,
    relativePath: opts.relativePath, folderId: opts.folderId ?? null,
  };
  useUploads.getState().addTask(task);
  void runUpload(key, file, opts).catch((e) => {
    const msg = (e as Error).message;
    const cur = useUploads.getState().tasks.find((t) => t.key === key);
    if (msg !== 'aborted' && cur && cur.status !== 'cancelled') {
      useUploads.getState().update(key, { status: 'failed', error: msg });
      toast.error(`Upload failed: ${file.name} — ${msg}`);
    }
  }).finally(() => {
    if (!runners.has(key)) return;
    const r = runners.get(key)!;
    // A paused runner is kept alive so a later resume can continue it.
    if (!r.paused) {
      runners.delete(key);
      progressMap.delete(key);
    }
  });
  return key;
}

/**
 * Uploads a list of files, detecting any same-name conflicts with existing files in the destination.
 * If conflicts exist, prompts the user with a File Explorer-like conflict dialog (Replace, Rename, Skip).
 */
export async function startUploadsWithConflictCheck(
  files: File[],
  opts: { folderId?: string | null; relativePath?: string; existingFiles?: FileDTO[] } = {},
): Promise<void> {
  const folderId = opts.folderId ?? null;
  const existingFiles = opts.existingFiles ?? [];
  const existingMap = new Map<string, FileDTO>();
  for (const f of existingFiles) {
    if (f.status !== 'trashed') existingMap.set(f.name.toLowerCase(), f);
  }

  const nonConflicting: File[] = [];
  const conflicting: { file: File; existing: FileDTO }[] = [];

  for (const f of files) {
    const rival = existingMap.get(f.name.toLowerCase());
    if (rival) {
      conflicting.push({ file: f, existing: rival });
    } else {
      nonConflicting.push(f);
    }
  }

  // Upload non-conflicting files immediately
  for (const f of nonConflicting) {
    startUpload(f, { folderId, relativePath: opts.relativePath, onConflict: 'rename' });
  }

  if (conflicting.length === 0) return;

  // Interactively resolve conflicting files
  let applyToAll = false;
  let rememberedAction: 'replace' | 'rename' | 'skip' | null = null;

  for (const [i, item] of conflicting.entries()) {
    const { file, existing } = item;

    if (applyToAll && rememberedAction) {
      if (rememberedAction !== 'skip') {
        startUpload(file, { folderId, relativePath: opts.relativePath, onConflict: rememberedAction });
      }
      continue;
    }

    const resolution = await new Promise<{ action: 'replace' | 'rename' | 'skip' | 'cancel'; applyToAll: boolean }>((resolve) => {
      useDialog.getState().open({
        kind: 'conflict',
        fileName: file.name,
        sourceSize: file.size,
        sourceTime: file.lastModified,
        targetSize: existing.size,
        targetTime: existing.createdAt,
        conflictIndex: i + 1,
        totalConflicts: conflicting.length,
        onResolve: (action, all) => resolve({ action, applyToAll: all }),
        onCancel: () => resolve({ action: 'cancel', applyToAll: false }),
      });
    });

    if (resolution.action === 'cancel') {
      break;
    }

    if (resolution.applyToAll) {
      applyToAll = true;
      rememberedAction = resolution.action;
    }

    if (resolution.action !== 'skip') {
      startUpload(file, { folderId, relativePath: opts.relativePath, onConflict: resolution.action });
    }
  }
}

interface PartPlan {
  idx: number;
  offset: number;
  size: number;
  sliceCount: number;
  receivedSlices: number[];
  status: string;
}

function buildJobs(parts: PartPlan[], sliceSize: number): { part: PartPlan; slice: number; start: number; len: number }[] {
  const jobs: { part: PartPlan; slice: number; start: number; len: number }[] = [];
  for (const part of parts) {
    if (part.status === 'stored') continue;
    const got = new Set(part.receivedSlices ?? []);
    const count = part.sliceCount || Math.max(1, Math.ceil(part.size / sliceSize));
    for (let s = 0; s < count; s++) {
      if (got.has(s)) continue;
      const start = (part.offset || 0) + s * sliceSize;
      const len = Math.min(sliceSize, (part.offset || 0) + (part.size || 0) - start);
      if (len > 0) jobs.push({ part, slice: s, start, len });
    }
  }
  return jobs;
}

function confirmedBytes(parts: PartPlan[], sliceSize: number): number {
  let n = 0;
  for (const part of parts) {
    for (const s of part.receivedSlices ?? []) {
      const start = (part.offset || 0) + s * sliceSize;
      n += Math.max(0, Math.min(sliceSize, (part.offset || 0) + (part.size || 0) - start));
    }
  }
  return n;
}

function primeProgress(key: string, parts: PartPlan[], sliceSize: number): Progress {
  const preReceived = confirmedBytes(parts, sliceSize);
  let p = progressMap.get(key);
  if (!p) {
    p = { confirmed: preReceived, received: new Set(), inflight: new Map(), samples: [], lastEmit: 0, smoothedSpeed: 0 };
    progressMap.set(key, p);
  } else {
    // Keep speed smoothing across pause/resume, but trust the server for
    // which bytes are actually durable.
    p.confirmed = Math.max(p.confirmed, preReceived);
    p.inflight.clear();
  }
  p.received.clear();
  for (const part of parts) for (const s of part.receivedSlices ?? []) p.received.add(`${part.idx}:${s}`);
  return p;
}

type PassResult = 'done' | 'paused';

async function sendSlicePass(
  key: string,
  runner: Runner,
  upload: UploadDTO,
  file: File,
  parts: PartPlan[],
): Promise<PassResult> {
  const sliceSz = upload.sliceSize || (upload.partSize > 0 ? upload.partSize : 45 * 1024 * 1024);
  const prog = primeProgress(key, parts, sliceSz);
  const jobs = buildJobs(parts, sliceSz);
  const pendingJobs = [...jobs];
  let pausedPass = false;
  let doneCount = parts.reduce((a, p) => a + (p.receivedSlices?.length || 0), 0);

  const worker = async (): Promise<void> => {
    while (pendingJobs.length > 0) {
      if (runner.aborted) throw new Error('aborted');
      if (runner.paused) { pausedPass = true; return; }
      const job = pendingJobs.shift();
      if (!job) break;
      await acquire(sliceLimiter);
      try {
        if (runner.aborted) {
          pendingJobs.unshift(job);
          throw new Error('aborted');
        }
        if (runner.paused) {
          pendingJobs.unshift(job);
          pausedPass = true;
          return;
        }
        const blob = file.slice(job.start, job.start + job.len);
        const sliceKey = `${job.part.idx}:${job.slice}`;
        await sendSlice(
          runner,
          `/api/uploads/${upload.id}/parts/${job.part.idx}/slices/${job.slice}`,
          blob,
          sliceKey,
          prog,
          () => emitProgress(key, useUploads.getState().tasks.find((t) => t.key === key)),
        );
        doneCount++;
        if (!prog.received.has(sliceKey)) {
          prog.received.add(sliceKey);
          prog.confirmed += job.len;
        }
        useUploads.getState().update(key, { slicesDone: doneCount });
        emitProgress(key, useUploads.getState().tasks.find((t) => t.key === key), true);
      } catch (e) {
        if (e instanceof PauseSignal) {
          pendingJobs.unshift(job);
          pausedPass = true;
          return;
        }
        if (!runner.aborted && !runner.paused) {
          pendingJobs.unshift(job);
        }
        throw e;
      } finally {
        release(sliceLimiter);
      }
    }
  };

  const nWorkers = Math.max(1, Math.min(jobs.length, sliceLimiter.limit));
  const results = await Promise.allSettled(Array.from({ length: nWorkers }, () => worker()));

  if (runner.aborted) throw new Error('aborted');
  const failed = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof PauseSignal),
  );
  if (failed) {
    const err = failed.reason as Error;
    if (isAbortError(err)) throw new Error('aborted');
    // Stop sibling workers before surfacing the real failure.
    runner.aborted = true;
    for (const x of runner.xhrs) x.abort();
    throw err;
  }
  if (pausedPass || runner.paused) return 'paused';
  return 'done';
}

async function runUpload(
  key: string,
  file: File,
  opts: { folderId?: string | null; relativePath?: string; uploadId?: string; fileId?: string; onConflict?: 'rename' | 'replace' | 'error' },
): Promise<void> {
  const runner = runners.get(key);
  if (!runner) return;
  let uploadId = opts.uploadId;
  let fileId = opts.fileId;

  for (;;) {
    await acquire(fileLimiter);
    let pass: PassResult = 'done';
    try {
      if (runner.aborted) return;
      if (!uploadId) {
        useUploads.getState().update(key, { status: 'creating' });
        await getConfig(); // also applies the latest concurrency limits
        if (runner.aborted) return;
        const upload = await api.post<UploadDTO>('/api/uploads', {
          name: file.name, size: file.size, mimeType: file.type || undefined,
          folderId: opts.folderId ?? null, lastModified: file.lastModified,
          relativePath: opts.relativePath,
          onConflict: opts.onConflict ?? useUi.getState().uploadConflict,
          clientKey: clientKey(file),
        });
        uploadId = upload.id;
        fileId = upload.fileId;
        runner.uploadId = uploadId;
        runner.fileId = fileId;
        useUploads.getState().update(key, { uploadId, fileId });
        if (upload.status === 'complete') {
          useUploads.getState().update(key, { status: 'done', uploaded: file.size, speed: 0, eta: 0 });
          toast.success(`Upload complete: ${file.name}`);
          void queryClient.invalidateQueries();
          return;
        }
        useUploads.getState().update(key, { status: 'uploading' });
      }

      if (runner.aborted) return;
      useUploads.getState().update(key, { status: 'uploading' });
      // Re-fetch on every pass: after a pause the server knows which slices
      // arrived before the abort, so we only send what is still missing.
      const upload = await api.get<UploadDTO>(`/api/uploads/${uploadId}`);
      fileId = upload.fileId;
      const parts = (Array.isArray(upload.parts) ? upload.parts : []) as PartPlan[];
      const sliceSz = upload.sliceSize || (upload.partSize > 0 ? upload.partSize : 45 * 1024 * 1024);
      const slicesTotal = parts.reduce((a, p) => a + (p.sliceCount || 1), 0);
      const slicesDone = parts.reduce((a, p) => a + (p.receivedSlices?.length || 0), 0);
      const partsStored = parts.filter((p) => p.status === 'stored').length;
      const prog = primeProgress(key, parts, sliceSz);
      useUploads.getState().update(key, {
        uploadId, fileId,
        partsTotal: parts.length, partsStored,
        slicesTotal, slicesDone,
        uploaded: Math.max(confirmedBytes(parts, sliceSz), prog.confirmed),
      });

      pass = await sendSlicePass(key, runner, upload, file, parts);
    } finally {
      release(fileLimiter);
    }

    if (runner.aborted) return;
    if (pass === 'paused') {
      // No file or slice slot is held while waiting for the user.
      await waitIfPaused(runner);
      if (runner.aborted) return;
      continue;
    }
    break;
  }

  if (!uploadId) return;
  useUploads.getState().update(key, { status: 'processing', uploaded: file.size, eta: 0, speed: 0 });

  // Complete, repairing any slices the server says are missing (e.g. a slice
  // response was lost but the request actually failed after a retry).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const comp = await api.post<{ file?: { status: string }; ready: boolean }>(`/api/uploads/${uploadId}/complete`);
      if (comp?.ready || comp?.file?.status === 'ready') {
        useUploads.getState().update(key, { status: 'done', error: undefined });
        toast.success(`Upload complete: ${file.name}`);
        void queryClient.invalidateQueries();
        return;
      }
      break;
    } catch (e) {
      const err = e as ApiError;
      const details = err.details as {
        missing?: { partIdx: number; missing: number[] }[];
        missingParts?: number[];
      } | undefined;
      if (err.status === 409 && details?.missing?.length) {
        const fresh = await api.get<UploadDTO>(`/api/uploads/${uploadId}`).catch(() => null);
        if (fresh) {
          useUploads.getState().update(key, { status: 'uploading' });
          await acquire(fileLimiter);
          let pass: PassResult = 'done';
          try {
            pass = await sendSlicePass(key, runner, fresh, file, fresh.parts as PartPlan[]);
          } finally {
            release(fileLimiter);
          }
          if (runner.aborted) return;
          if (pass === 'paused') {
            await waitIfPaused(runner);
          }
          useUploads.getState().update(key, { status: 'processing' });
          continue;
        }
      }
      // Another request may still be finalizing, or a part send failed
      // transiently. Retry /complete: the server re-drives pending parts.
      if ((err.status === 409 || err.status === 502 || err.status === 503) && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      // Let polling surface the final server-side status instead of hanging.
      break;
    }
  }

  if (!fileId) return;
  pollUntilReady(key, fileId);
}

function pollUntilReady(key: string, fileId: string) {
  const poll = async () => {
    let delay = 400;
    for (;;) {
      const t = useUploads.getState().tasks.find((x) => x.key === key);
      if (!t || ['done', 'cancelled', 'server-failed', 'failed'].includes(t.status)) return;
      try {
        const { file } = await api.get<{ file: { status: string } }>(`/api/files/${fileId}`);
        if (file.status === 'ready') {
          useUploads.getState().update(key, { status: 'done' });
          void queryClient.invalidateQueries();
          return;
        }
        if (file.status === 'failed') {
          useUploads.getState().update(key, { status: 'server-failed', error: 'Telegram upload failed' });
          return;
        }
      } catch {
        // A session can fail before its file record exists (the native server
        // only creates the file after Telegram succeeds). Check the upload so
        // a permanent part failure is surfaced instead of polling forever.
        if (t.uploadId) {
          try {
            const upload = await api.get<{ status: string }>(`/api/uploads/${t.uploadId}`);
            if (upload.status === 'failed') {
              useUploads.getState().update(key, {
                status: 'server-failed',
                error: 'Telegram upload failed',
              });
              return;
            }
          } catch { /* session may already be gone */ }
        }
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 4000);
    }
  };
  void poll();
}

export function onPartEvent(uploadId: string, _idx: number, status: string) {
  if (status !== 'stored') return;
  const st = useUploads.getState();
  const t = st.tasks.find((x) => x.uploadId === uploadId);
  if (!t) return;
  st.update(t.key, { partsStored: Math.min((t.partsStored || 0) + 1, t.partsTotal || 1) });
}

export function onFileReady(fileId: string, status: string = 'ready') {
  const st = useUploads.getState();
  for (const t of st.tasks) {
    if (t.fileId === fileId && t.status === 'processing') {
      if (status === 'failed') {
        st.update(t.key, {
          status: 'failed',
          error: 'Telegram could not store this file. Retry the upload.',
          speed: 0,
          eta: 0,
        });
        toast.error(`Upload failed: ${t.name}`);
        continue;
      }
      if (status !== 'ready') continue;
      st.update(t.key, { status: 'done' });
      // A finished video may still lack a server-side thumbnail — the
      // desktop shell can capture a frame straight from the stream.
      if (/\.(mp4|mkv|webm|mov|avi|m4v|wmv|flv)$/i.test(t.name)) {
        void api.get<{ file?: { hasThumbnail?: boolean } }>(`/api/files/${fileId}`)
          .then((f) => { if (!f?.file?.hasThumbnail) requestVideoThumbnail(fileId); })
          .catch(() => {});
      }
    }
  }
}

export function pauseUpload(key: string) {
  const r = runners.get(key);
  if (!r) return;
  r.paused = true;
  for (const x of r.xhrs) x.abort();
  useUploads.getState().update(key, { status: 'paused', speed: 0, eta: 0 });
}

export function resumeUpload(key: string) {
  const r = runners.get(key);
  if (!r) return;
  r.paused = false;
  wakePaused(r);
  useUploads.getState().update(key, { status: 'uploading' });
}

export async function cancelUpload(key: string) {
  const r = runners.get(key);
  const t = useUploads.getState().tasks.find((x) => x.key === key);
  if (r) {
    r.aborted = true;
    r.paused = false;
    wakePaused(r);
    for (const x of r.xhrs) x.abort();
  }
  if (t?.uploadId) await api.del(`/api/uploads/${t.uploadId}`).catch(() => {});
  useUploads.getState().update(key, { status: 'cancelled' });
  setTimeout(() => useUploads.getState().remove(key), 400);
}

export async function retryServerUpload(key: string) {
  const t = useUploads.getState().tasks.find((x) => x.key === key);
  if (!t?.uploadId) return;
  try {
    await api.post(`/api/uploads/${t.uploadId}/retry`);
    useUploads.getState().update(key, { status: 'processing', error: undefined });
    if (t.fileId) pollUntilReady(key, t.fileId);
  } catch (e) {
    toast.error(`Retry failed: ${(e as ApiError).message}`);
  }
}

export function discardUpload(key: string) {
  const t = useUploads.getState().tasks.find((x) => x.key === key);
  if (t?.uploadId) void api.del(`/api/uploads/${t.uploadId}`).catch(() => {});
  useUploads.getState().remove(key);
}

/** File picker for resuming a server-side active/failed upload. */
export function resumeServerUpload(entry: { id: string; fileId: string; name: string; size: number; clientKey: string }, file: File) {
  const expected = `${file.name}|${file.size}|${file.lastModified}`;
  if (expected !== entry.clientKey) {
    toast.error('Selected file does not match the interrupted upload');
    return;
  }
  startUpload(file, {
    uploadId: entry.id,
    fileId: entry.fileId,
    // Reuse the synthetic server task key so the paused row is replaced.
    key: `server-${entry.id}`,
  });
}

/**
 * Server-side uploads seen on load. Active ones need the user to re-select the
 * file; processing ones are already fully on the server and just finishing in
 * Telegram; failed ones can be retried.
 */
export function noteInterruptedUploads(list: {
  id: string; fileId: string; name: string; size: number; status: string; clientKey?: string;
  native?: boolean;
  progress?: { partsReceived: number; partsTotal: number; slicesReceived: number; slicesTotal: number };
}[]) {
  const st = useUploads.getState();
  for (const u of list) {
    if (st.tasks.some((t) => t.uploadId === u.id)) continue;
    const progress = u.progress ?? { partsReceived: 0, partsTotal: 0, slicesReceived: 0, slicesTotal: 0 };
    const frac = progress.slicesTotal ? progress.slicesReceived / progress.slicesTotal : 0;
    const status: UploadStatus = u.status === 'failed' ? 'server-failed' : u.status === 'processing' ? 'processing' : 'paused';
    st.addTask({
      key: `server-${u.id}`, clientKey: u.clientKey, name: u.name, size: u.size, status,
      uploaded: status === 'paused' ? Math.round(u.size * frac) : u.size,
      speed: 0, eta: 0, uploadId: u.id, fileId: u.fileId,
      partsStored: 0, partsTotal: progress.partsTotal,
      slicesDone: progress.slicesReceived, slicesTotal: progress.slicesTotal,
      noLocalFile: status === 'paused' && !u.native,
      native: u.native === true,
    });
    if (status === 'processing') pollUntilReady(`server-${u.id}`, u.fileId);
  }
}

// ---------- native (desktop) uploads ----------

interface NativeUploadsResponse {
  uploads: { uploadId: string; name: string; size: number; file?: unknown; complete?: boolean }[];
  skipped: { path: string; reason: string }[];
}

export const isDesktopNativeUploads = () =>
  (window as { desktopApi?: { nativeUploads?: boolean } }).desktopApi?.nativeUploads === true;

/** The folder new native uploads land in — Drive keeps this in sync with the
 *  URL so OS-level drops land in the folder on screen. */
let nativeDropFolder: string | null = null;
export function setNativeDropFolder(id: string | null) { nativeDropFolder = id; }

function noteNativeUploads(res: NativeUploadsResponse): void {
  const st = useUploads.getState();
  for (const u of res.uploads) {
    if (u.complete) {
      queryClient.invalidateQueries({ queryKey: ['drive'] });
      continue;
    }
    st.addTask({
      key: `native-${u.uploadId}`, name: u.name, size: u.size, status: 'processing',
      uploaded: 0, speed: 0, eta: 0, uploadId: u.uploadId,
      partsStored: 0, partsTotal: 0, slicesDone: 0, slicesTotal: 0,
      native: true,
    });
    pollUntilReady(`native-${u.uploadId}`, u.uploadId);
  }
  for (const s of res.skipped) {
    toast.error(`${s.path.split(/[\\/]/).pop()}: ${s.reason}`);
  }
  if (res.uploads.length) {
    queryClient.invalidateQueries({ queryKey: ['uploads-interrupted'] });
  }
}

/** OS file-picker path for desktop builds — the Rust layer picks real paths
 *  and the server feeds bytes itself, no browser File objects involved. */
export async function pickNativeFiles(folderId: string | null): Promise<void> {
  const conflict = useUi.getState().uploadConflict;
  const res = await api.post<NativeUploadsResponse | { cancelled: true }>(
    '/api/native-uploads/pick', { folderId, conflict },
  );
  if ('cancelled' in res) return;
  noteNativeUploads(res);
}

// OS-level file drops are consumed natively (no HTML5 drop fires) — the Rust
// shell forwards them as this CustomEvent.
window.addEventListener('teledrive:native-drop', (e) => {
  const paths = (e as CustomEvent<{ paths: string[] }>).detail?.paths;
  if (!Array.isArray(paths) || !paths.length) return;
  const conflict = useUi.getState().uploadConflict;
  void api.post<NativeUploadsResponse>('/api/native-uploads', {
    paths, folderId: nativeDropFolder, conflict,
  }).then(noteNativeUploads).catch((err) => toast.error((err as ApiError).message));
});

// warn on tab close only while bytes are still leaving the machine
window.addEventListener('beforeunload', (e) => {
  if (useUploads.getState().tasks.some((t) => ['queued', 'creating', 'uploading'].includes(t.status))) {
    e.preventDefault();
    e.returnValue = '';
  }
});
