import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { isDownloadComplete } from '../src/download';

describe('download completion guard', () => {
  it('accepts a complete response', () => {
    expect(isDownloadComplete(1024, 1024)).toBe(true);
    expect(isDownloadComplete(2048, 1024)).toBe(true);
  });

  it('rejects a truncated response so it stays resumable', () => {
    expect(isDownloadComplete(1023, 1024)).toBe(false);
    expect(isDownloadComplete(0, 1024)).toBe(false);
  });

  it('accepts an unknown length only when bytes arrived', () => {
    expect(isDownloadComplete(0, 0)).toBe(true);
    expect(isDownloadComplete(512, 0)).toBe(true);
  });
});

describe('SSE file readiness', () => {
  let useUploads: typeof import('../src/upload')['useUploads'];
  let onFileReady: typeof import('../src/upload')['onFileReady'];

  beforeAll(async () => {
    vi.stubGlobal('window', { addEventListener: () => {}, innerWidth: 1280 });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    const mod = await import('../src/upload');
    useUploads = mod.useUploads;
    onFileReady = mod.onFileReady;
  });

  beforeEach(() => {
    useUploads.setState({ tasks: [], panelOpen: false, panelCollapsed: false });
  });

  const addTask = (name = 'notes.bin') => {
    useUploads.getState().addTask({
      key: 'k1', name, size: 10, status: 'processing', uploaded: 10, speed: 0, eta: 0,
      fileId: 'f1', partsStored: 1, partsTotal: 1, slicesDone: 1, slicesTotal: 1,
    });
  };

  it('keeps processing until the file is actually ready', () => {
    addTask();
    onFileReady('f1', 'uploading');
    expect(useUploads.getState().tasks[0]!.status).toBe('processing');
    onFileReady('f1', 'ready');
    expect(useUploads.getState().tasks[0]!.status).toBe('done');
  });

  it('marks a failed file as failed instead of leaving it processing', () => {
    addTask();
    onFileReady('f1', 'failed');
    const task = useUploads.getState().tasks[0]!;
    expect(task.status).toBe('failed');
    expect(task.error).toBeTruthy();
  });

  it('ignores files that are not this upload', () => {
    addTask();
    onFileReady('other', 'ready');
    expect(useUploads.getState().tasks[0]!.status).toBe('processing');
  });
});
