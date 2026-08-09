import { useCallback } from 'react';
import api from '../services/api';
import { useUploadStore, useUIStore } from '../stores';
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

  updateLimit(limit: number): void {
    this.limit = limit;
    while (this.activeCount < this.limit && this.tasks.length > 0) {
      this.activeCount++;
      const next = this.tasks.shift();
      next?.();
    }
  }
}

const globalUploadSemaphore = new SimpleSemaphore(4);

/**
 * Dynamically calculate optimal chunk size based on file size.
 * - Targets around 10 chunks for smaller files to optimize parallel uploads.
 * - Caps at 45 MB to prevent Telegram Bot API upload size limits.
 * - Minimum size is 5 MB to prevent excessive API request overhead.
 */
function calculateChunkSize(fileSize: number): number {
  // Cap at 19.5 MB to strictly stay within Telegram Bot API's 20 MB download limit
  const maxChunkSize = 19.5 * 1024 * 1024;
  // Minimum chunk size of 5 MB to keep the number of requests reasonable
  const minChunkSize = 5 * 1024 * 1024;

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
  const botCount = useUIStore.getState().botCount || 1;
  return Math.min(8, Math.max(3, botCount * 2));
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

      // Step 2: Upload chunks in parallel (using a concurrency-limited worker pool)
      const concurrencyLimit = calculateConcurrency();
      globalUploadSemaphore.updateLimit(concurrencyLimit);
      const chunkProgressMap = new Map<number, number>();
      let completedChunks = 0;
      const startTime = Date.now();

      // Create a queue of chunk indices to be processed
      const chunkQueue = Array.from({ length: totalChunks }, (_, idx) => idx);

      const worker = async () => {
        while (chunkQueue.length > 0) {
          // Check if paused or cancelled
          let currentTask = useUploadStore.getState().uploads.find((u) => u.id === taskId);
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

          // Double check if cancelled after resuming
          currentTask = useUploadStore.getState().uploads.find((u) => u.id === taskId);
          if (!currentTask || currentTask.status === 'cancelled') {
            return;
          }

          const currentChunkIndex = chunkQueue.shift();
          if (currentChunkIndex === undefined) {
            break;
          }

          const start = currentChunkIndex * dynamicChunkSize;
          const end = Math.min(start + dynamicChunkSize, file.size);
          const chunkSize = end - start;
          const chunkBlob = file.slice(start, end);

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
              // Check if cancelled before trying/retrying
              const taskCheck = useUploadStore.getState().uploads.find((u) => u.id === taskId);
              if (!taskCheck || taskCheck.status === 'cancelled') {
                return;
              }

              try {
                await api.post('/upload/chunk', formData, {
                  headers: { 'Content-Type': 'multipart/form-data' },
                  timeout: 300000, // 5 min timeout per chunk
                  onUploadProgress: (progressEvent) => {
                    const loaded = progressEvent.loaded || 0;
                    // Cap the reported progress for this chunk at its known raw file size to exclude multipart boundary overhead
                    const cappedLoaded = Math.min(loaded, chunkSize);
                    
                    // Enforce monotonic progress (only write if the new progress is greater than what was recorded previously)
                    const prevLoaded = chunkProgressMap.get(currentChunkIndex) || 0;
                    if (cappedLoaded > prevLoaded) {
                      chunkProgressMap.set(currentChunkIndex, cappedLoaded);
                    }

                    // Calculate aggregate progress in real-time
                    let totalUploadedBytes = 0;
                    chunkProgressMap.forEach((bytes) => {
                      totalUploadedBytes += bytes;
                    });

                    const safeUploadedBytes = Math.min(totalUploadedBytes, file.size);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? safeUploadedBytes / elapsed : 0;
                    const remaining = speed > 0 ? (file.size - safeUploadedBytes) / speed : 0;

                    const computedProgress = Math.round((safeUploadedBytes / file.size) * 100);
                    // Fetch the current task progress to enforce forward-only progress updates
                    const currentProgress = useUploadStore.getState().uploads.find((u) => u.id === taskId)?.progress || 0;

                    updateUpload(taskId, {
                      progress: Math.max(currentProgress, computedProgress),
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

          const computedProgress = Math.round((safeUploadedBytes / file.size) * 100);
          const currentProgress = useUploadStore.getState().uploads.find((u) => u.id === taskId)?.progress || 0;

          updateUpload(taskId, {
            progress: Math.max(currentProgress, computedProgress),
            uploadedBytes: safeUploadedBytes,
            completedChunks,
            speed,
            eta: remaining,
          });
        }
      };

      // Run concurrencyLimit workers in parallel
      const workers = Array.from({ length: concurrencyLimit }, () => worker());
      await Promise.all(workers);

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
