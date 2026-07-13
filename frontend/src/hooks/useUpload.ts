/**
 * TeleDrive Frontend — Upload Hook
 *
 * Browser-side file chunking, progress tracking, and upload management.
 */

import { useCallback } from 'react';
import api from '../services/api';
import { useUploadStore } from '../stores';
import { generateId, CHUNK_SIZE, sha256 } from '../utils/helpers';
import type { UploadTask } from '../types';

export function useUpload() {
  const { addUpload, updateUpload, removeUpload } = useUploadStore();

  /**
   * Upload a single file, handling chunking automatically.
   */
  const uploadFile = useCallback(async (file: File, folderId: string | null = null) => {
    const taskId = generateId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Build chunk info
    const chunkInfos = Array.from({ length: totalChunks }, (_, i) => {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
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

      // Step 2: Upload chunks in parallel (up to 5 concurrent uploads)
      const concurrencyLimit = 5;
      const activeUploads = new Set<Promise<void>>();
      let completedChunks = 0;
      let uploadedBytes = 0;
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

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);
        const currentChunkIndex = i;

        const uploadPromise = (async () => {
          // Compute chunk hash
          const chunkArrayBuffer = await chunkBlob.arrayBuffer();
          const chunkHash = await sha256(chunkArrayBuffer);

          // Upload chunk via FormData
          const formData = new FormData();
          formData.append('fileId', fileId);
          formData.append('sessionId', sessionId);
          formData.append('chunkIndex', String(currentChunkIndex));
          formData.append('chunkHash', chunkHash);
          formData.append('chunk', new Blob([chunkArrayBuffer]), `chunk_${currentChunkIndex}`);

          let retries = 0;
          const maxRetries = 3;
          let success = false;

          while (!success && retries <= maxRetries) {
            try {
              await api.post('/upload/chunk', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 300000, // 5 min timeout per chunk
              });
              success = true;
            } catch (error) {
              retries++;
              if (retries > maxRetries) throw error;
              await new Promise((r) => setTimeout(r, 1000 * retries));
            }
          }

          // Update progress
          completedChunks++;
          uploadedBytes += end - start;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = uploadedBytes / elapsed;
          const remaining = (file.size - uploadedBytes) / speed;

          updateUpload(taskId, {
            progress: Math.round((uploadedBytes / file.size) * 100),
            uploadedBytes,
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
      // Small delay between uploads to avoid overwhelming the API
      await new Promise((r) => setTimeout(r, 200));
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
