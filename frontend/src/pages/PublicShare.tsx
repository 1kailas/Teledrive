/**
 * TeleDrive — Public Share Download Page
 *
 * Allows public users to download files shared with a token.
 * Supports password protection, displays file metadata, and tracks download progress.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cloud,
  Download,
  Lock,
  Loader2,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  File as FileIcon,
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
} from 'lucide-react';
import api from '../services/api';
import { formatBytes, getFileCategory, getExtensionColor } from '../utils/helpers';

export default function PublicShare() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [fileInfo, setFileInfo] = useState<{
    fileName: string;
    fileSize: number;
    mimeType: string | null;
    extension: string;
    requiresPassword: boolean;
  } | null>(null);

  const [password, setPassword] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  // Fetch shared file metadata on mount
  useEffect(() => {
    const fetchSharedInfo = async () => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/share/public/${token}`);
        if (res.data.success) {
          setFileInfo(res.data.data);
        } else {
          setError(res.data.error || 'Failed to retrieve file details');
        }
      } catch (err: any) {
        setError(err.response?.data?.error || err.message || 'Share link has expired or is invalid.');
      } finally {
        setLoading(false);
      }
    };

    fetchSharedInfo();
  }, [token]);

  const handleDownload = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || downloading) return;

    setDownloading(true);
    setError(null);
    setDownloadProgress(0);

    try {
      const res = await api.post(
        `/share/public/${token}/download`,
        { password },
        {
          responseType: 'blob',
          onDownloadProgress: (progressEvent) => {
            const total = progressEvent.total || fileInfo?.fileSize || 0;
            if (total > 0) {
              setDownloadProgress(Math.round((progressEvent.loaded / total) * 100));
            }
          },
        }
      );

      // Parse headers to get correct filename if present
      const contentType = res.headers['content-type'];
      const disposition = res.headers['content-disposition'];
      const contentTypeStr = typeof contentType === 'string' ? contentType : 'application/octet-stream';
      const dispositionStr = typeof disposition === 'string' ? disposition : '';

      let filename = fileInfo?.fileName || 'download';
      if (dispositionStr && dispositionStr.indexOf('attachment') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(dispositionStr);
        if (matches != null && matches[1]) {
          filename = decodeURIComponent(matches[1].replace(/['"]/g, ''));
        }
      }

      // Trigger browser download
      const blob = new Blob([res.data], { type: contentTypeStr });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(url);

      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 5000);
    } catch (err: any) {
      let errMsg = 'Download failed';
      // Axios response type 'blob' intercepts JSON error, check if payload is blob
      if (err.response && err.response.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const json = JSON.parse(text);
          errMsg = json.error || errMsg;
        } catch {
          // Ignore
        }
      } else if (err.response?.data?.error) {
        errMsg = err.response.data.error;
      }
      setError(errMsg);
    } finally {
      setDownloading(false);
    }
  }, [token, password, fileInfo, downloading]);

  const getCategoryIcon = () => {
    if (!fileInfo) return <FileIcon className="w-10 h-10 text-slate-400" />;
    const category = getFileCategory(fileInfo.mimeType, fileInfo.extension);
    const size = 'w-10 h-10';
    switch (category) {
      case 'image': return <FileImage className={`${size} text-amber-500`} />;
      case 'video': return <FileVideo className={`${size} text-red-500`} />;
      case 'audio': return <FileAudio className={`${size} text-purple-500`} />;
      case 'pdf': return <FileText className={`${size} text-red-500`} />;
      case 'code': return <FileCode className={`${size} text-blue-500`} />;
      case 'text': return <FileText className={`${size} text-slate-500`} />;
      default: return <FileIcon className={`${size} text-slate-400`} />;
    }
  };

  const extColor = fileInfo ? getExtensionColor(fileInfo.extension) : '#64748b';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-surface-50 via-primary-50/30 to-accent-500/5 dark:from-surface-950 dark:via-surface-900 dark:to-primary-900/10 p-4">
      {/* Background ambient glows */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-primary-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-accent-500/10 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md bg-white dark:bg-surface-900 rounded-3xl shadow-xl border border-surface-200/50 dark:border-surface-800/50 overflow-hidden relative z-10"
      >
        <div className="p-8 sm:p-10 flex flex-col items-center">
          {/* Header */}
          <div className="flex flex-col items-center mb-6 text-center w-full">
            <div className="w-16 h-16 bg-gradient-to-br from-primary-500 to-accent-500 rounded-2xl flex items-center justify-center shadow-glow mb-6">
              <Cloud className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              Shared Download
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              TeleDrive Private Cloud Sharing
            </p>
          </div>

          <AnimatePresence mode="wait">
            {loading && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center py-10 gap-3"
              >
                <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
                <p className="text-sm text-slate-500 dark:text-slate-400">Loading file details...</p>
              </motion.div>
            )}

            {error && !loading && (
              <motion.div
                key="error"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="w-full"
              >
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 mb-6">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
                <button
                  onClick={() => navigate('/login')}
                  className="w-full btn-secondary text-xs flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Go to Login
                </button>
              </motion.div>
            )}

            {fileInfo && !loading && !error && (
              <motion.div
                key="content"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="w-full flex flex-col items-center"
              >
                {/* File Preview Card */}
                <div
                  className="w-full p-5 rounded-2xl flex items-center gap-4 bg-surface-50 dark:bg-surface-800/30 border border-surface-100 dark:border-surface-800 mb-6"
                >
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 shadow-sm"
                    style={{ backgroundColor: `${extColor}15` }}
                  >
                    {getCategoryIcon()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate" title={fileInfo.fileName}>
                      {fileInfo.fileName}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400 font-medium">
                        {formatBytes(fileInfo.fileSize)}
                      </span>
                      <span
                        className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                        style={{ color: extColor, backgroundColor: `${extColor}15` }}
                      >
                        {fileInfo.extension || 'FILE'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Password / Download Form */}
                <form onSubmit={handleDownload} className="w-full space-y-4">
                  {fileInfo.requiresPassword && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                        <Lock className="w-3.5 h-3.5 text-amber-500" />
                        Password Protected
                      </label>
                      <input
                        type="password"
                        required
                        placeholder="Enter password to unlock file..."
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-sm text-slate-700 dark:text-slate-250 outline-none focus:border-primary-400 transition-colors"
                      />
                    </div>
                  )}

                  {downloading ? (
                    <div className="w-full space-y-2 py-2">
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                        <span>Downloading file...</span>
                        <span>{downloadProgress}%</span>
                      </div>
                      <div className="progress-bar">
                        <motion.div
                          className="progress-bar-fill"
                          animate={{ width: `${downloadProgress}%` }}
                          transition={{ duration: 0.1 }}
                        />
                      </div>
                    </div>
                  ) : downloadSuccess ? (
                    <motion.div
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-sm font-semibold"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Download Started!
                    </motion.div>
                  ) : (
                    <button
                      type="submit"
                      className="w-full btn-primary py-3 text-sm font-bold flex items-center justify-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Download File
                    </button>
                  )}
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
