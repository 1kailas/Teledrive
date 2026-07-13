/**
 * TeleDrive — Upload Panel
 *
 * Sliding panel that shows upload/download queue with progress.
 */

import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Upload,
  Download,
  Pause,
  Play,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { useUploadStore, useDownloadStore, useUIStore } from '../../stores';
import { useUpload } from '../../hooks/useUpload';
import { formatBytes, formatSpeed, formatDuration } from '../../utils/helpers';

export default function UploadPanel() {
  const { uploadPanelOpen, setUploadPanelOpen } = useUIStore();
  const uploads = useUploadStore((s) => s.uploads);
  const downloads = useDownloadStore((s) => s.downloads);
  const clearCompletedUploads = useUploadStore((s) => s.clearCompleted);
  const clearCompletedDownloads = useDownloadStore((s) => s.clearCompleted);
  const { pauseUpload, resumeUpload, cancelUpload } = useUpload();

  const allTasks = [
    ...uploads.map((u) => ({ ...u, taskType: 'upload' as const })),
    ...downloads.map((d) => ({ ...d, taskType: 'download' as const })),
  ].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      uploading: 0, downloading: 0, queued: 1, hashing: 1,
      paused: 2, assembling: 2, failed: 3, complete: 4, cancelled: 5,
    };
    return (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5);
  });

  const hasCompleted = allTasks.some((t) => t.status === 'complete');

  return (
    <AnimatePresence>
      {uploadPanelOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
            onClick={() => setUploadPanelOpen(false)}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed right-0 top-0 h-full w-full max-w-md z-50 glass flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200 dark:border-surface-700">
              <h2 className="text-base font-semibold text-slate-800 dark:text-white">
                Transfers
              </h2>
              <div className="flex items-center gap-2">
                {hasCompleted && (
                  <button
                    onClick={() => {
                      clearCompletedUploads();
                      clearCompletedDownloads();
                    }}
                    className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                  >
                    Clear completed
                  </button>
                )}
                <button
                  onClick={() => setUploadPanelOpen(false)}
                  className="btn-ghost p-1.5"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Task list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {allTasks.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-slate-400">
                  <Upload className="w-10 h-10 mb-3 opacity-30" />
                  <p className="text-sm">No active transfers</p>
                </div>
              )}

              <AnimatePresence>
                {allTasks.map((task) => (
                  <motion.div
                    key={task.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 50 }}
                    className="rounded-xl p-3.5 bg-white/60 dark:bg-surface-800/60 border border-surface-200/50 dark:border-surface-700/50"
                  >
                    <div className="flex items-start gap-3">
                      {/* Icon */}
                      <div className={`mt-0.5 ${
                        task.status === 'complete' ? 'text-success-500' :
                        task.status === 'failed' ? 'text-error-500' :
                        'text-primary-500'
                      }`}>
                        {task.status === 'complete' ? <CheckCircle2 className="w-5 h-5" /> :
                         task.status === 'failed' ? <AlertCircle className="w-5 h-5" /> :
                         task.status === 'hashing' || task.status === 'assembling' ? <Loader2 className="w-5 h-5 animate-spin" /> :
                         task.taskType === 'upload' ? <Upload className="w-5 h-5" /> :
                         <Download className="w-5 h-5" />}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                          {task.fileName}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-slate-400">
                            {formatBytes(task.fileSize)}
                          </span>
                          {(task.status === 'uploading' || task.status === 'downloading') && task.speed > 0 && (
                            <>
                              <span className="text-xs text-slate-300">•</span>
                              <span className="text-xs text-primary-500 font-medium">
                                {formatSpeed(task.speed)}
                              </span>
                              <span className="text-xs text-slate-300">•</span>
                              <span className="text-xs text-slate-400">
                                {formatDuration(task.eta)}
                              </span>
                            </>
                          )}
                          {task.status === 'hashing' && (
                            <span className="text-xs text-warning-500">Computing hash...</span>
                          )}
                          {task.status === 'assembling' && (
                            <span className="text-xs text-warning-500">Assembling file...</span>
                          )}
                          {task.status === 'failed' && (
                            <span className="text-xs text-error-500">{task.error}</span>
                          )}
                        </div>

                        {/* Progress bar */}
                        {task.status !== 'complete' && task.status !== 'failed' && (
                          <div className="progress-bar mt-2">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${task.progress}%` }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1">
                        {task.taskType === 'upload' && (task.status === 'uploading' || task.status === 'paused') && (
                          <button
                            onClick={() =>
                              task.status === 'paused'
                                ? resumeUpload(task.id)
                                : pauseUpload(task.id)
                            }
                            className="btn-ghost p-1.5"
                          >
                            {task.status === 'paused' ? (
                              <Play className="w-3.5 h-3.5" />
                            ) : (
                              <Pause className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {task.status !== 'complete' && (
                          <button
                            onClick={() => cancelUpload(task.id)}
                            className="btn-ghost p-1.5 text-error-400 hover:text-error-500"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
