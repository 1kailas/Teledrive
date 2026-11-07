// Download engine: resumable, pause-aware HTTP and native desktop downloads.
//
// In desktop mode: downloads are handled natively by the Rust backend, streaming
// directly into the user's Downloads directory with zero browser popups, zero
// SmartScreen warnings, and continuous real-time progress.
//
// In browser mode: pausing aborts active fetch and retains chunks. Resuming requests
// Range headers to continue smoothly.
import { create } from 'zustand';
import { api } from './api';
import { toast, useUi } from './store';

export type DownloadStatus = 'queued' | 'downloading' | 'finalizing' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface DownloadTask {
  id: string;
  fileId: string;
  name: string;
  size: number;
  downloaded: number;
  speed: number; // smoothed bytes/sec
  eta: number; // seconds
  status: DownloadStatus;
  error?: string;
  startedAt: number;
  destPath?: string;
  isNative?: boolean;
}

interface DownloadStore {
  downloads: DownloadTask[];
  downloadDir: string;
  panelOpen: boolean;
  panelCollapsed: boolean;
  setPanel: (v: { open?: boolean; collapsed?: boolean }) => void;
  setDownloadDir: (dir: string) => void;
  addDownload: (task: DownloadTask) => void;
  updateDownload: (id: string, patch: Partial<DownloadTask>) => void;
  removeDownload: (id: string) => void;
  clearDone: () => void;
}

const buffers = new Map<string, Uint8Array[]>();
const contentTypes = new Map<string, string>();
const receivedBytes = new Map<string, number>();
const controllers = new Map<string, AbortController>();
const running = new Set<string>();

const STREAM_THRESHOLD = 512 * 1024 * 1024;

interface WritableSink {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface SaveHandle {
  createWritable(): Promise<WritableSink>;
}
type SavePicker = (options?: { suggestedName?: string }) => Promise<SaveHandle>;
type PickerResult = { handle: SaveHandle } | { cancelled: true } | { unsupported: true };

const sinks = new Map<string, WritableSink>();
const sinkPromises = new Map<string, Promise<PickerResult>>();

function getSavePicker(): SavePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

function beginSavePicker(id: string, name: string): void {
  const picker = getSavePicker();
  if (!picker) return;
  try {
    const result = picker({ suggestedName: name })
      .then((handle): PickerResult => ({ handle }))
      .catch((err): PickerResult => {
        if ((err as Error).name === 'AbortError') return { cancelled: true };
        return { unsupported: true };
      });
    sinkPromises.set(id, result);
  } catch {
    /* fall back to buffered download */
  }
}

function dropSinks(id: string, abort: boolean): void {
  const sink = sinks.get(id);
  sinks.delete(id);
  sinkPromises.delete(id);
  if (abort && sink) void sink.abort().catch(() => {});
}

function dropBuffers(id: string): void {
  buffers.delete(id);
  contentTypes.delete(id);
  receivedBytes.delete(id);
}

export const useDownloads = create<DownloadStore>((set) => ({
  downloads: [],
  downloadDir: '',
  panelOpen: false,
  panelCollapsed: false,
  setPanel: ({ open, collapsed }) => set((s) => ({
    panelOpen: open ?? s.panelOpen,
    panelCollapsed: collapsed ?? s.panelCollapsed,
  })),
  setDownloadDir: (downloadDir) => set({ downloadDir }),
  addDownload: (task) => set((s) => ({
    downloads: [task, ...s.downloads.filter((d) => d.id !== task.id)],
    panelOpen: true,
    panelCollapsed: false,
  })),
  updateDownload: (id, patch) => set((s) => {
    const cur = s.downloads.find((d) => d.id === id);
    if (!cur) return s;
    let changed = false;
    for (const k in patch) {
      if ((patch as any)[k] !== (cur as any)[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return s;
    return { downloads: s.downloads.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
  }),
  removeDownload: (id) => {
    const task = useDownloads.getState().downloads.find((d) => d.id === id);
    if (task?.isNative) {
      void api.post(`/api/native-downloads/${id}/remove`, {}).catch(() => {});
    }
    dropSinks(id, true);
    dropBuffers(id);
    set((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }));
  },
  clearDone: () => {
    void api.post('/api/native-downloads/clear-done', {}).catch(() => {});
    const done = useDownloads.getState().downloads.filter((d) => d.status === 'done');
    for (const d of done) {
      dropSinks(d.id, false);
      dropBuffers(d.id);
    }
    set((s) => ({ downloads: s.downloads.filter((d) => d.status !== 'done') }));
  },
}));

function patch(id: string, p: Partial<DownloadTask>): void {
  useDownloads.getState().updateDownload(id, p);
}

// ── Native Desktop Downloads API ──────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;

export async function syncNativeDownloads(): Promise<void> {
  try {
    const res = await api.get<{ downloads: any[]; downloadDir: string }>('/api/native-downloads');
    if (!res || !Array.isArray(res.downloads)) return;

    if (!useUi.getState().desktopMode) {
      useUi.getState().setDesktopMode(true);
    }

    if (res.downloadDir && !useDownloads.getState().downloadDir) {
      useDownloads.getState().setDownloadDir(res.downloadDir);
    }

    const store = useDownloads.getState();
    const existing = new Map(store.downloads.map((d) => [d.id, d]));
    const merged: DownloadTask[] = [];
    let hasChanges = false;

    if (res.downloads.length !== store.downloads.filter((d) => d.isNative).length) {
      hasChanges = true;
    }

    for (const d of res.downloads) {
      const prev = existing.get(d.id);
      if (
        !prev ||
        prev.downloaded !== d.downloaded ||
        prev.status !== d.status ||
        prev.speed !== d.speed ||
        prev.eta !== d.eta
      ) {
        hasChanges = true;
      }

      merged.push({
        id: d.id,
        fileId: d.fileId,
        name: d.name,
        size: d.size,
        downloaded: d.downloaded,
        speed: d.speed,
        eta: d.eta,
        status: d.status as DownloadStatus,
        destPath: d.destPath,
        error: d.error,
        startedAt: d.createdAt,
        isNative: true,
      });
      if ((prev?.status === 'downloading' || prev?.status === 'finalizing') && d.status === 'done') {
        toast.success(`Downloaded ${d.name}`);
      }
      existing.delete(d.id);
    }
    for (const remaining of existing.values()) {
      if (!remaining.isNative) merged.push(remaining);
    }

    // Only update Zustand state when there are actual changes to prevent unnecessary render cycles
    if (hasChanges) {
      useDownloads.setState({ downloads: merged });
    }
  } catch {
    // offline or non-desktop environment
  }
}

export function startNativePolling(): void {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    // Poll whenever any native download is active or finalizing so progress
    // and completion events are captured quickly (200 ms resolution).
    const hasNative = useDownloads.getState().downloads.some(
      (d) => d.isNative && (d.status === 'downloading' || d.status === 'finalizing' || d.status === 'paused' || d.status === 'queued'),
    );
    if (hasNative) {
      await syncNativeDownloads();
    }
  }, 200);
}

export async function openDownloadedFile(id: string): Promise<void> {
  try {
    await api.post(`/api/native-downloads/${id}/open`, {});
  } catch (e: any) {
    toast.error(`Cannot open file: ${e.message || e}`);
  }
}

export async function revealDownloadedFile(id: string): Promise<void> {
  try {
    await api.post(`/api/native-downloads/${id}/reveal`, {});
  } catch (e: any) {
    toast.error(`Cannot reveal file: ${e.message || e}`);
  }
}

export async function pickDownloadDir(): Promise<string | null> {
  try {
    const res = await api.post<{ path: string | null }>('/api/native-downloads/pick-folder', {});
    if (res?.path) {
      useDownloads.getState().setDownloadDir(res.path);
      toast.success(`Download folder updated: ${res.path}`);
      return res.path;
    }
  } catch (e: any) {
    toast.error(`Failed to pick folder: ${e.message || e}`);
  }
  return null;
}

export function pauseDownload(id: string): void {
  const task = useDownloads.getState().downloads.find((d) => d.id === id);
  if (!task) return;
  if (task.isNative) {
    void api.post(`/api/native-downloads/${id}/pause`, {});
    patch(id, { status: 'paused', speed: 0, eta: 0 });
    return;
  }
  if (task.status !== 'downloading') return;
  patch(id, { status: 'paused', downloaded: receivedBytes.get(id) ?? task.downloaded, speed: 0, eta: 0 });
  controllers.get(id)?.abort();
  controllers.delete(id);
}

export function cancelDownload(id: string): void {
  const task = useDownloads.getState().downloads.find((d) => d.id === id);
  if (task?.isNative) {
    void api.post(`/api/native-downloads/${id}/cancel`, {});
    patch(id, { status: 'cancelled', speed: 0, eta: 0 });
    return;
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  dropSinks(id, true);
  dropBuffers(id);
  patch(id, { status: 'cancelled', speed: 0, eta: 0 });
}

export function resumeDownload(id: string): void {
  const task = useDownloads.getState().downloads.find((d) => d.id === id);
  if (!task || task.status === 'done') return;
  if (task.isNative) {
    void api.post(`/api/native-downloads/${id}/resume`, {}).then(() => {
      startNativePolling();
    });
    patch(id, { status: 'downloading', error: undefined, speed: 0, eta: 0 });
    return;
  }
  patch(id, { status: 'downloading', error: undefined, speed: 0, eta: 0 });
  if (!running.has(id)) void run(id);
}

export function retryDownload(id: string): void {
  const task = useDownloads.getState().downloads.find((d) => d.id === id);
  if (!task) return;
  if (task.isNative) {
    void api.post(`/api/native-downloads/${id}/resume`, {}).then(() => {
      startNativePolling();
    });
    patch(id, { status: 'downloading', error: undefined, speed: 0, eta: 0 });
    return;
  }
  if (task.downloaded > 0 && (sinks.has(id) || (buffers.get(id)?.length ?? 0) > 0)) {
    resumeDownload(id);
    return;
  }
  dropSinks(id, true);
  dropBuffers(id);
  patch(id, { downloaded: 0, size: task.size, status: 'downloading', error: undefined, speed: 0, eta: 0 });
  if (!running.has(id)) void run(id);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  };
}

function bufferedBytes(chunks: Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

/** Build and save a blob, then release the in-memory chunks. */
function saveBlob(id: string, name: string, chunks: Uint8Array[], size?: number): boolean {
  const buffered = bufferedBytes(chunks);
  if (size && size > 0 && buffered !== size) return false;
  const blob = new Blob(chunks as BlobPart[], { type: contentTypes.get(id) ?? 'application/octet-stream' });
  dropBuffers(id);
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  return true;
}

function handOffToDownloadManager(id: string, task: DownloadTask, size: number): void {
  const a = document.createElement('a');
  a.href = `/api/files/${task.fileId}/content?download=1`;
  a.download = task.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  receivedBytes.set(id, size);
  patch(id, { status: 'done', downloaded: size, size, speed: 0, eta: 0, error: undefined });
  toast.success(`Downloading ${task.name}`);
}

/** True only when every expected byte arrived (or the size is unknown). */
export function isDownloadComplete(received: number, expected: number): boolean {
  const total = expected > 0 ? expected : received;
  return total <= 0 || received >= total;
}

/**
 * Finish a download only when every expected byte has arrived. A truncated
 * response must fail and stay resumable instead of being saved as a corrupt
 * file and reported as complete.
 */
async function finalizeDownload(
  id: string,
  task: DownloadTask,
  expected: number,
  stream: WritableSink | null,
): Promise<boolean> {
  const received = receivedBytes.get(id) ?? 0;
  const total = expected > 0 ? expected : received;
  if (!isDownloadComplete(received, expected)) return false;

  if (stream) {
    sinks.delete(id);
    await stream.close();
  } else {
    const chunks = buffers.get(id) ?? [];
    if (!saveBlob(id, task.name, chunks, total)) return false;
  }
  receivedBytes.set(id, total);
  patch(id, {
    status: 'done', speed: 0, eta: 0, downloaded: total, size: total, error: undefined,
  });
  toast.success(`Downloaded ${task.name}`);
  return true;
}

async function run(id: string): Promise<void> {
  if (running.has(id)) return;
  let task = useDownloads.getState().downloads.find((d) => d.id === id);
  if (!task || task.status === 'done' || task.status === 'cancelled') return;

  running.add(id);
  const controller = new AbortController();
  controllers.set(id, controller);
  let size = task.size;
  let stream = sinks.get(id) ?? null;
  let offset = receivedBytes.get(id) ?? task.downloaded;

  try {
    if (!stream && size >= STREAM_THRESHOLD) {
      const pending = sinkPromises.get(id);
      sinkPromises.delete(id);
      if (pending) {
        const picked = await pending;
        if ('cancelled' in picked) {
          patch(id, { status: 'cancelled', speed: 0, eta: 0 });
          dropBuffers(id);
          toast.info('Download cancelled');
          return;
        }
        if (useDownloads.getState().downloads.find((d) => d.id === id)?.status !== 'downloading') {
          return;
        }
        if ('handle' in picked) {
          try {
            stream = await picked.handle.createWritable();
            if (useDownloads.getState().downloads.find((d) => d.id === id)?.status !== 'downloading') {
              await stream.abort().catch(() => {});
              return;
            }
            sinks.set(id, stream);
            buffers.delete(id);
          } catch {
            stream = null;
          }
        }
        if (!stream) {
          handOffToDownloadManager(id, task, size);
          return;
        }
      } else {
        handOffToDownloadManager(id, task, size);
        return;
      }
    }

    task = useDownloads.getState().downloads.find((d) => d.id === id) ?? task;
    if (task.status !== 'downloading') return;
    if (size <= 0) size = task.size;

    if (offset > 0 && !stream && (buffers.get(id)?.length ?? 0) === 0) {
      offset = 0;
      receivedBytes.set(id, 0);
      patch(id, { downloaded: 0 });
    }

    const held = buffers.get(id) ?? [];
    if (size > 0 && offset >= size && (stream || held.length > 0)) {
      if (await finalizeDownload(id, task, size, stream)) return;
      throw new Error(`Download incomplete (${receivedBytes.get(id) ?? 0}/${size} bytes)`);
    }

    for (;;) {
      const headers: Record<string, string> = {};
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const res = await fetch(`/api/files/${task.fileId}/content?download=1`, {
        signal: controller.signal,
        headers,
        cache: 'no-store',
      });

      if (!res.ok) {
        if (res.status === 416 && offset > 0) {
          const total = Number(res.headers.get('content-range')?.split('/')[1]) || offset;
          size = total;
        } else {
          throw new Error(`Server returned HTTP ${res.status}`);
        }
      } else {
        let append = false;
        if (offset > 0) {
          const range = parseContentRange(res.headers.get('content-range'));
          if (res.status === 206 && range && range.start === offset) {
            append = true;
            if (range.total > 0) size = range.total;
          } else {
            dropBuffers(id);
            offset = 0;
            receivedBytes.set(id, 0);
            patch(id, { downloaded: 0 });
            if (stream) await stream.truncate(0);
          }
        }

        const totalHeader = Number(res.headers.get('content-length')) || 0;
        if (size <= 0) size = totalHeader + offset;
        const mime = res.headers.get('content-type');
        if (mime) contentTypes.set(id, mime);

        if (!append) {
          if (!stream) buffers.set(id, []);
          else await stream.truncate(0);
          size = totalHeader || size;
        }
        const chunks = buffers.get(id) ?? [];
        if (!stream) buffers.set(id, chunks);
        if (!res.body) throw new Error('Response body is empty');

        const reader = res.body.getReader();
        let received = offset;
        let lastEmit = Date.now();
        let lastBytes = received;
        let smoothed = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          if (stream) {
            try {
              await stream.write({ type: 'write', position: received, data: value });
            } catch (writeErr) {
              dropSinks(id, true);
              stream = null;
              throw writeErr;
            }
          } else {
            chunks.push(value);
          }
          received += value.length;
          receivedBytes.set(id, received);

          const now = Date.now();
          const dt = (now - lastEmit) / 1000;
          if (dt >= 0.25) {
            const inst = dt > 0 ? (received - lastBytes) / dt : 0;
            smoothed = smoothed > 0 ? 0.35 * inst + 0.65 * smoothed : inst;
            lastEmit = now;
            lastBytes = received;
            const remaining = Math.max(0, (size || received) - received);
            patch(id, {
              downloaded: received,
              size: size || received,
              speed: Math.round(smoothed),
              eta: smoothed > 1000 ? Math.ceil(remaining / smoothed) : 0,
            });
          }
        }

        offset = received;
        const actualSize = size > 0 ? size : received;
        receivedBytes.set(id, received);
        patch(id, { downloaded: received, size: actualSize });
        if (await finalizeDownload(id, task, actualSize, stream)) return;
        throw new Error(`Download incomplete (${received}/${actualSize} bytes)`);
      }

      const chunks = buffers.get(id) ?? [];
      if (offset > 0 && (stream || chunks.length > 0)) {
        if (await finalizeDownload(id, task, size, stream)) return;
        throw new Error(`Download incomplete (${receivedBytes.get(id) ?? 0}/${size} bytes)`);
      }
      throw new Error(`Server returned HTTP ${res.status}`);
    }
  } catch (err) {
    const current = useDownloads.getState().downloads.find((d) => d.id === id);
    if ((err as Error).name === 'AbortError' || current?.status === 'paused' || current?.status === 'cancelled') {
      return;
    }
    const message = (err as Error).message || 'Download failed';
    patch(id, { status: 'failed', downloaded: receivedBytes.get(id) ?? offset, error: message, speed: 0, eta: 0 });
    toast.error(`Download failed: ${message}`);
  } finally {
    running.delete(id);
    controllers.delete(id);
    const current = useDownloads.getState().downloads.find((d) => d.id === id);
    if (current?.status === 'downloading') void run(id);
  }
}

export function startDownload(file: { id: string; name: string; size?: number }): void {
  // Always attempt native download first via the Rust desktop server.
  // Native downloads write directly to disk with zero popups, zero SmartScreen warnings,
  // and real-time exact progress.
  void (async () => {
    try {
      const res = await api.post<{ task: any }>('/api/native-downloads/start', { fileId: file.id, name: file.name });
      if (res?.task) {
        useUi.getState().setDesktopMode(true);
        useDownloads.getState().addDownload({
          id: res.task.id,
          fileId: res.task.fileId,
          name: res.task.name,
          size: res.task.size,
          downloaded: res.task.downloaded,
          speed: res.task.speed,
          eta: res.task.eta,
          status: res.task.status as DownloadStatus,
          destPath: res.task.destPath,
          error: res.task.error,
          startedAt: res.task.createdAt,
          isNative: true,
        });
        startNativePolling();
        toast.info(`Downloading ${file.name} to Downloads folder`);
        return;
      }
    } catch (err: any) {
      if (useUi.getState().desktopMode) {
        toast.error(`Download failed: ${err?.message || 'Could not start native download'}`);
        return;
      }
    }

    // Browser fallback (pure web environment only)
    const taskId = crypto.randomUUID();
    dropSinks(taskId, true);
    dropBuffers(taskId);
    receivedBytes.set(taskId, 0);
    if ((file.size ?? 0) >= STREAM_THRESHOLD) beginSavePicker(taskId, file.name);
    const initialTask: DownloadTask = {
      id: taskId,
      fileId: file.id,
      name: file.name,
      size: file.size ?? 0,
      downloaded: 0,
      speed: 0,
      eta: 0,
      status: 'downloading',
      startedAt: Date.now(),
    };
    useDownloads.getState().addDownload(initialTask);
    void run(taskId);
  })();
}
