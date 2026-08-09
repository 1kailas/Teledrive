/**
 * TeleDrive Frontend — Download Hook
 *
 * Multi-chunk download with browser-side reassembly.
 */

import { useCallback } from 'react';
import api from '../services/api';
import { useDownloadStore, useUIStore } from '../stores';
import { generateId } from '../utils/helpers';
import type { DownloadTask, DownloadInfo } from '../types';

export function useDownload() {
  const { addDownload, updateDownload, removeDownload } = useDownloadStore();

  /**
   * Download a file by its ID.
   */
  const downloadFile = useCallback(async (fileId: string) => {
    const taskId = generateId();
    
    // Auto-open transfers panel for visual loading progress feedback
    useUIStore.getState().setUploadPanelOpen(true);

    try {
      // Get download info
      const infoRes = await api.get(`/download/${fileId}/info`);
      if (!infoRes.data.success) {
        throw new Error(infoRes.data.error || 'Failed to get download info');
      }

      const info: DownloadInfo = infoRes.data.data;

      const task: DownloadTask = {
        id: taskId,
        fileId: info.fileId,
        fileName: info.fileName,
        fileSize: info.fileSize,
        mimeType: info.mimeType || 'application/octet-stream',
        status: 'downloading',
        progress: 0,
        speed: 0,
        eta: 0,
        downloadedBytes: 0,
        totalChunks: info.chunkCount,
        completedChunks: 0,
        error: null,
      };

      addDownload(task);

      // Download all chunks using a stable worker pool queue
      const botCount = useUIStore.getState().botCount || 1;
      const concurrencyLimit = Math.min(8, Math.max(3, botCount * 2));
      const chunkBlobs: Blob[] = new Array(info.chunkCount);
      const chunkProgressMap = new Map<number, number>();
      let completedChunks = 0;
      const startTime = Date.now();

      const chunkQueue = Array.from({ length: info.chunkCount }, (_, idx) => idx);

      const worker = async () => {
        while (chunkQueue.length > 0) {
          const currentTask = useDownloadStore.getState().downloads.find((d) => d.id === taskId);
          if (!currentTask || currentTask.status === 'failed') {
            return;
          }

          const currentChunkIndex = chunkQueue.shift();
          if (currentChunkIndex === undefined) {
            break;
          }

          let retries = 0;
          const maxRetries = 3;
          let chunkData: ArrayBuffer | null = null;

          while (!chunkData && retries <= maxRetries) {
            // Check cancellation before trying/retrying
            const taskCheck = useDownloadStore.getState().downloads.find((d) => d.id === taskId);
            if (!taskCheck || taskCheck.status === 'failed') {
              return;
            }

            try {
              const res = await api.get(`/download/${fileId}/chunk/${currentChunkIndex}`, {
                responseType: 'arraybuffer',
                timeout: 300000,
                onDownloadProgress: (progressEvent) => {
                  const loaded = progressEvent.loaded || 0;
                  const prevLoaded = chunkProgressMap.get(currentChunkIndex) || 0;
                  if (loaded > prevLoaded) {
                    chunkProgressMap.set(currentChunkIndex, loaded);
                  }

                  // Calculate aggregate progress in real-time
                  let totalDownloadedBytes = 0;
                  chunkProgressMap.forEach((bytes) => {
                    totalDownloadedBytes += bytes;
                  });

                  const safeDownloadedBytes = Math.min(totalDownloadedBytes, info.fileSize);
                  const elapsed = (Date.now() - startTime) / 1000;
                  const speed = elapsed > 0 ? safeDownloadedBytes / elapsed : 0;
                  const remaining = speed > 0 ? (info.fileSize - safeDownloadedBytes) / speed : 0;

                  const computedProgress = Math.round((safeDownloadedBytes / info.fileSize) * 100);
                  const currentProgress = useDownloadStore.getState().downloads.find((d) => d.id === taskId)?.progress || 0;

                  updateDownload(taskId, {
                    progress: Math.max(currentProgress, computedProgress),
                    downloadedBytes: safeDownloadedBytes,
                    speed,
                    eta: remaining,
                  });
                }
              });
              chunkData = res.data;
            } catch (error: any) {
              retries++;
              if (retries > maxRetries) {
                let errMsg = `Failed to download chunk ${currentChunkIndex}`;
                if (error.response?.data instanceof ArrayBuffer) {
                  try {
                    const decoded = new TextDecoder().decode(error.response.data);
                    const json = JSON.parse(decoded);
                    errMsg = json.error || errMsg;
                  } catch {
                    // Ignore
                  }
                } else if (error.response?.data?.error) {
                  errMsg = error.response.data.error;
                }
                throw new Error(errMsg);
              }
              await new Promise((r) => setTimeout(r, 1000 * retries));
            }
          }

          if (!chunkData) throw new Error(`Failed to download chunk ${currentChunkIndex}`);

          chunkBlobs[currentChunkIndex] = new Blob([chunkData]);
          
          // Ensure finished chunk size is registered
          chunkProgressMap.set(currentChunkIndex, chunkData.byteLength);
          completedChunks++;

          let totalDownloadedBytes = 0;
          chunkProgressMap.forEach((bytes) => {
            totalDownloadedBytes += bytes;
          });

          const safeDownloadedBytes = Math.min(totalDownloadedBytes, info.fileSize);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? safeDownloadedBytes / elapsed : 0;
          const remaining = speed > 0 ? (info.fileSize - safeDownloadedBytes) / speed : 0;

          const computedProgress = Math.round((safeDownloadedBytes / info.fileSize) * 100);
          const currentProgress = useDownloadStore.getState().downloads.find((d) => d.id === taskId)?.progress || 0;

          updateDownload(taskId, {
            progress: Math.max(currentProgress, computedProgress),
            downloadedBytes: safeDownloadedBytes,
            completedChunks,
            speed,
            eta: remaining,
          });
        }
      };

      const workers = Array.from({ length: concurrencyLimit }, () => worker());
      await Promise.all(workers);

      // Assemble chunks
      updateDownload(taskId, { status: 'assembling' });
      const fullBlob = new Blob(chunkBlobs, { type: info.mimeType || 'application/octet-stream' });

      // Trigger browser download
      const url = URL.createObjectURL(fullBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = info.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      updateDownload(taskId, {
        status: 'complete',
        progress: 100,
        completedChunks: info.chunkCount,
        downloadedBytes: info.fileSize,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed';
      updateDownload(taskId, {
        status: 'failed',
        error: message,
      });
    }
  }, [addDownload, updateDownload]);

  /**
   * Cancel a download.
   */
  const cancelDownload = useCallback((taskId: string) => {
    removeDownload(taskId);
  }, [removeDownload]);

  return { downloadFile, cancelDownload };
}
