import { useCallback } from 'react';
import api from '../services/api';
import { useUploadStore } from '../stores';
import { generateId } from '../utils/helpers';
import type { UploadTask } from '../types';

class SimpleSemaphore {
  private tasks: (() => void)[] = [];
  private activeCount = 0;
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.activeCount < this.limit) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.tasks.push(resolve);
    });
  }

  release(): void {
    if (this.tasks.length > 0) {
      const next = this.tasks.shift();
      next?.();
    } else {
      this.activeCount--;
    }
  }
}

const MAX_CONCURRENT_CHUNKS = 4;
const globalUploadSemaphore = new SimpleSemaphore(MAX_CONCURRENT_CHUNKS);

/**
 * Dynamically calculate optimal chunk size based on file size.
 * - Targets around 10 chunks for smaller files to optimize parallel uploads.
 * - Caps at 45 MB to prevent Telegram Bot API upload size limits.
 * - Minimum size is 5 MB to prevent excessive API request overhead.
 */
function calculateChunkSize(fileSize: number): number {
  const maxChunkSize = 45 * 1024 * 1024; // 45 MB standard Bot API limit
  const minChunkSize = 20 * 1024 * 1024; // 20 MB min chunk size

  const targetChunks = 10;
  const calculatedSize = Math.ceil(fileSize / targetChunks);

  if (calculatedSize > maxChunkSize) {
    return maxChunkSize;
  }
  if (calculatedSize < minChunkSize) {
    return Math.min(minChunkSize, fileSize);
  }
  return calculatedSize;
}

/**
 * Determine optimal concurrency to avoid Telegram rate limits.
 * - Standard bots are limited to sending message requests in sequence (approx 20 per minute for same chat).
 * - Higher concurrency for fewer chunks, lower concurrency for many chunks.
 */
function calculateConcurrency(): number {
  return MAX_CONCURRENT_CHUNKS;
}

export function useUpload() {
  const { addUpload, updateUpload, removeUpload } = useUploadStore();

  /**
   * Upload a single file, handling chunking automatically.
   */
  const uploadFile = useCallback(async (file: File, folderId: string | null = null) => {
    const taskId = generateId();
    const dynamicChunkSize = calculateChunkSize(file.size);
    const totalChunks = Math.ceil(file.size / dynamicChunkSize);

    // Build chunk info
    const chunkInfos = Array.from({ length: totalChunks }, (_, i) => {
      const start = i * dynamicChunkSize;
      const end = Math.min(start + dynamicChunkSize, file.size);
      return { index: i, size: end - start };
    });

    // Create upload task
    const task: UploadTask = {
      id: taskId,
      file,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      folderId,
      status: 'queued',
      progress: 0,
      speed: 0,
      eta: 0,
      uploadedBytes: 0,
      totalChunks,
      completedChunks: 0,
      sessionId: null,
      fileId: null,
      error: null,
      startedAt: null,
    };

    addUpload(task);

    try {
      // Step 1: Initialize upload on server
      updateUpload(taskId, { status: 'hashing' });

      const initRes = await api.post('/upload/init', {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        folderId: folderId || undefined,
        chunkCount: totalChunks,
        chunks: chunkInfos,
      });

      if (!initRes.data.success) {
        throw new Error(initRes.data.error || 'Failed to initialize upload');
      }

      const { fileId, sessionId } = initRes.data.data;
      updateUpload(taskId, {
        status: 'uploading',
        sessionId,
        fileId,
        startedAt: Date.now(),
      });

      // Step 2: Upload chunks in parallel (up to dynamic concurrency limit)
      const concurrencyLimit = calculateConcurrency();
      const activeUploads = new Set<Promise<void>>();
      const chunkProgressMap = new Map<number, number>();
      let completedChunks = 0;
      const startTime = Date.now();

      for (let i = 0; i < totalChunks; i++) {
        // Limit concurrency
        if (activeUploads.size >= concurrencyLimit) {
          await Promise.race(activeUploads);
        }

        // Check if paused or cancelled
        const currentTask = useUploadStore.getState().uploads.find((u) => u.id === taskId);
        if (!currentTask || currentTask.status === 'cancelled') {
          return;
        }

        if (currentTask.status === 'paused') {
          // Wait for resume
          await new Promise<void>((resolve) => {
            const unsubscribe = useUploadStore.subscribe((state) => {
              const t = state.uploads.find((u) => u.id === taskId);
              if (t && t.status !== 'paused') {
                unsubscribe();
                resolve();
              }
            });
          });
        }

        const start = i * dynamicChunkSize;
        const end = Math.min(start + dynamicChunkSize, file.size);
        const chunkSize = end - start;
        const chunkBlob = file.slice(start, end);
        const currentChunkIndex = i;

        const uploadPromise = (async () => {
          // Upload chunk via FormData
          const formData = new FormData();
          formData.append('fileId', fileId);
          formData.append('sessionId', sessionId);
          formData.append('chunkIndex', String(currentChunkIndex));
          formData.append('chunk', chunkBlob, `chunk_${currentChunkIndex}`);

          await globalUploadSemaphore.acquire();
          try {
            let retries = 0;
            const maxRetries = 3;
            let success = false;

            while (!success && retries <= maxRetries) {
              try {
                await api.post('/upload/chunk', formData, {
                  headers: { 'Content-Type': 'multipart/form-data' },
                  timeout: 300000, // 5 min timeout per chunk
                  onUploadProgress: (progressEvent) => {
                    const loaded = progressEvent.loaded || 0;
                    chunkProgressMap.set(currentChunkIndex, loaded);

                    // Calculate aggregate progress in real-time
                    let totalUploadedBytes = 0;
                    chunkProgressMap.forEach((bytes) => {
                      totalUploadedBytes += bytes;
                    });

                    const safeUploadedBytes = Math.min(totalUploadedBytes, file.size);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? safeUploadedBytes / elapsed : 0;
                    const remaining = speed > 0 ? (file.size - safeUploadedBytes) / speed : 0;

                    updateUpload(taskId, {
                      progress: Math.round((safeUploadedBytes / file.size) * 100),
                      uploadedBytes: safeUploadedBytes,
                      speed,
                      eta: remaining,
                    });
                  }
                });
                success = true;
              } catch (error) {
                retries++;
                if (retries > maxRetries) throw error;
                await new Promise((r) => setTimeout(r, 1000 * retries));
              }
            }
          } finally {
            globalUploadSemaphore.release();
          }

          // Ensure complete byte size for this chunk is registered upon success
          chunkProgressMap.set(currentChunkIndex, chunkSize);
          completedChunks++;

          let totalUploadedBytes = 0;
          chunkProgressMap.forEach((bytes) => {
            totalUploadedBytes += bytes;
          });

          const safeUploadedBytes = Math.min(totalUploadedBytes, file.size);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? safeUploadedBytes / elapsed : 0;
          const remaining = speed > 0 ? (file.size - safeUploadedBytes) / speed : 0;

          updateUpload(taskId, {
            progress: Math.round((safeUploadedBytes / file.size) * 100),
            uploadedBytes: safeUploadedBytes,
            completedChunks,
            speed,
            eta: remaining,
          });
        })();

        activeUploads.add(uploadPromise);
        uploadPromise.finally(() => {
          activeUploads.delete(uploadPromise);
        });
      }

      // Wait for all remaining chunk uploads to finish
      await Promise.all(activeUploads);

      // Step 3: Complete upload
      await api.post('/upload/complete', { sessionId, fileId });

      updateUpload(taskId, {
        status: 'complete',
        progress: 100,
        completedChunks: totalChunks,
        uploadedBytes: file.size,
      });

      // Dispatch global custom event to automatically refresh files and storage stats
      window.dispatchEvent(new CustomEvent('teledrive:upload-complete'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      updateUpload(taskId, {
        status: 'failed',
        error: message,
      });
    }
  }, [addUpload, updateUpload]);

  /**
   * Upload multiple files.
   */
  const uploadFiles = useCallback(async (files: File[], folderId: string | null = null) => {
    for (const file of files) {
      uploadFile(file, folderId);
      // Small stagger delay between starting uploads to avoid locking at the exact same moment
      await new Promise((r) => setTimeout(r, 300));
    }
  }, [uploadFile]);

  /**
   * Pause an upload.
   */
  const pauseUpload = useCallback((taskId: string) => {
    updateUpload(taskId, { status: 'paused' });
  }, [updateUpload]);

  /**
   * Resume an upload.
   */
  const resumeUpload = useCallback((taskId: string) => {
    updateUpload(taskId, { status: 'uploading' });
  }, [updateUpload]);

  /**
   * Cancel an upload.
   */
  const cancelUpload = useCallback(async (taskId: string) => {
    const task = useUploadStore.getState().uploads.find((u) => u.id === taskId);
    if (task?.sessionId) {
      try {
        await api.delete(`/upload/cancel/${task.sessionId}`);
      } catch {
        // Best effort
      }
    }
    removeUpload(taskId);
  }, [removeUpload]);

  return { uploadFile, uploadFiles, pauseUpload, resumeUpload, cancelUpload };
}
