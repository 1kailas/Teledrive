/**
 * TeleDrive Frontend — Download Hook
 *
 * Multi-chunk download with browser-side reassembly.
 */

import { useCallback } from 'react';
import api from '../services/api';
import { useDownloadStore } from '../stores';
import { generateId } from '../utils/helpers';
import type { DownloadTask, DownloadInfo } from '../types';

export function useDownload() {
  const { addDownload, updateDownload, removeDownload } = useDownloadStore();

  /**
   * Download a file by its ID.
   */
  const downloadFile = useCallback(async (fileId: string) => {
    const taskId = generateId();

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

      // Download all chunks in parallel (up to 4 concurrent downloads)
      const concurrencyLimit = 4;
      const activeDownloads = new Set<Promise<void>>();
      const chunkBlobs: Blob[] = new Array(info.chunkCount);
      let downloadedBytes = 0;
      let completedChunks = 0;
      const startTime = Date.now();

      for (let i = 0; i < info.chunkCount; i++) {
        // Limit concurrency
        if (activeDownloads.size >= concurrencyLimit) {
          await Promise.race(activeDownloads);
        }

        const currentTask = useDownloadStore.getState().downloads.find((d) => d.id === taskId);
        if (!currentTask || currentTask.status === 'failed') return;

        const currentChunkIndex = i;

        const downloadPromise = (async () => {
          let retries = 0;
          const maxRetries = 3;
          let chunkData: ArrayBuffer | null = null;

          while (!chunkData && retries <= maxRetries) {
            try {
              const res = await api.get(`/download/${fileId}/chunk/${currentChunkIndex}`, {
                responseType: 'arraybuffer',
                timeout: 300000,
              });
              chunkData = res.data;
            } catch (error) {
              retries++;
              if (retries > maxRetries) throw error;
              await new Promise((r) => setTimeout(r, 1000 * retries));
            }
          }

          if (!chunkData) throw new Error(`Failed to download chunk ${currentChunkIndex}`);

          chunkBlobs[currentChunkIndex] = new Blob([chunkData]);
          downloadedBytes += chunkData.byteLength;
          completedChunks++;

          const elapsed = (Date.now() - startTime) / 1000;
          const speed = downloadedBytes / elapsed;
          const remaining = (info.fileSize - downloadedBytes) / speed;

          updateDownload(taskId, {
            progress: Math.round((downloadedBytes / info.fileSize) * 100),
            downloadedBytes,
            completedChunks,
            speed,
            eta: remaining,
          });
        })();

        activeDownloads.add(downloadPromise);
        downloadPromise.finally(() => {
          activeDownloads.delete(downloadPromise);
        });
      }

      // Wait for all chunk downloads to finish
      await Promise.all(activeDownloads);

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
