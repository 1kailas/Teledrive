/**
 * TeleDrive — Share Modal Component
 *
 * Modal for creating and managing shareable links for files.
 * Supports password protection, expiry dates, and download limits.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Link2,
  Copy,
  Check,
  Lock,
  Unlock,
  Calendar,
  Hash,
  Trash2,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import api from '../../services/api';
import { useToastStore } from '../../stores';
import type { TDFile } from '../../types';

interface ShareModalProps {
  file: TDFile;
  onClose: () => void;
}

export default function ShareModal({ file, onClose }: ShareModalProps) {
  const [loading, setLoading] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [downloadCount, setDownloadCount] = useState(0);
  const [hasExistingShare, setHasExistingShare] = useState(false);

  const { addToast } = useToastStore();

  // Check for existing share link
  useEffect(() => {
    const checkExisting = async () => {
      try {
        const res = await api.get('/share/links');
        if (res.data.success) {
          const existing = res.data.data.find((s: { file_id: string }) => s.file_id === file.id);
          if (existing) {
            setShareToken(existing.token);
            setHasExistingShare(true);
            setDownloadCount(existing.download_count || 0);
            setUsePassword(!!existing.password_hash);
            if (existing.expires_at) setExpiresAt(existing.expires_at.split('T')[0]);
            if (existing.max_downloads) setMaxDownloads(String(existing.max_downloads));
          }
        }
      } catch {
        // Ignore
      }
    };
    checkExisting();
  }, [file.id]);

  const createShareLink = useCallback(async () => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = {};
      if (usePassword && password) body.password = password;
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      if (maxDownloads) body.maxDownloads = parseInt(maxDownloads, 10);

      const res = await api.post(`/share/${file.id}`, body);
      if (res.data.success) {
        setShareToken(res.data.data.token);
        setHasExistingShare(true);
        addToast('success', 'Share link created', 'Anyone with the link can download this file.');
      }
    } catch (err) {
      addToast('error', 'Failed to create share link');
    } finally {
      setLoading(false);
    }
  }, [file.id, usePassword, password, expiresAt, maxDownloads, addToast]);

  const updateShareSettings = useCallback(async () => {
    try {
      const body: Record<string, unknown> = {};
      if (usePassword && password) {
        body.password = password;
      } else if (!usePassword) {
        body.password = null;
      }
      if (expiresAt) {
        body.expiresAt = new Date(expiresAt).toISOString();
      } else {
        body.expiresAt = null;
      }
      body.maxDownloads = maxDownloads ? parseInt(maxDownloads, 10) : null;

      await api.patch(`/share/${file.id}`, body);
      addToast('success', 'Share settings updated');
    } catch {
      addToast('error', 'Failed to update share settings');
    }
  }, [file.id, usePassword, password, expiresAt, maxDownloads, addToast]);

  const revokeShareLink = useCallback(async () => {
    try {
      await api.delete(`/share/${file.id}`);
      setShareToken(null);
      setHasExistingShare(false);
      addToast('info', 'Share link revoked');
    } catch {
      addToast('error', 'Failed to revoke share link');
    }
  }, [file.id, addToast]);

  const shareUrl = shareToken
    ? `${window.location.origin}/shared/${shareToken}`
    : '';

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      addToast('success', 'Link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [shareUrl, addToast]);

  return (
    <AnimatePresence>
      <div className="modal-overlay" onClick={onClose}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="modal-content max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary-500/10 dark:bg-primary-500/20 flex items-center justify-center border border-primary-500/15">
                <Link2 className="w-5 h-5 text-primary-500" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800 dark:text-white">Share File</h3>
                <p className="text-xs text-slate-400 truncate max-w-[200px]">{file.name}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-surface-800 transition-colors">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* Share link display */}
          {shareToken && (
            <div className="mb-5">
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-surface-900/40 border border-surface-200 dark:border-surface-800 shadow-inner">
                <ExternalLink className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  className="flex-1 bg-transparent text-xs text-slate-650 dark:text-slate-300 outline-none font-mono"
                />
                <button
                  onClick={copyLink}
                  className="shrink-0 p-1.5 rounded-lg bg-primary-550 hover:bg-primary-600 text-white transition-colors cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              {downloadCount > 0 && (
                <p className="text-[11px] text-slate-400 mt-1.5 ml-1">
                  {downloadCount} download{downloadCount !== 1 ? 's' : ''} so far
                </p>
              )}
            </div>
          )}

          {/* Share options */}
          <div className="space-y-4">
            {/* Password protection */}
            <div>
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-2 select-none">
                  {usePassword ? <Lock className="w-4 h-4 text-amber-500" /> : <Unlock className="w-4 h-4 text-slate-450" />}
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Password protect</span>
                </div>
                <button
                  onClick={() => setUsePassword(!usePassword)}
                  className={`w-10 h-5.5 rounded-full transition-colors relative cursor-pointer ${usePassword ? 'bg-primary-500' : 'bg-slate-200 dark:bg-surface-700'}`}
                >
                  <motion.div
                    className="w-4 h-4 rounded-full bg-white shadow-sm absolute top-0.75"
                    animate={{ x: usePassword ? 21 : 3 }}
                    transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                  />
                </button>
              </label>
              {usePassword && (
                <motion.input
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  type="password"
                  placeholder="Enter password..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full mt-2.5 px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-800 bg-slate-50 dark:bg-surface-900/60 text-sm text-slate-750 dark:text-slate-200 outline-none focus:border-primary-500 dark:focus:border-primary-400 focus:bg-white dark:focus:bg-surface-850 transition-all duration-200"
                />
              )}
            </div>

            {/* Expiration */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="w-4 h-4 text-slate-450" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Expiration date</span>
              </div>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className="w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-800 bg-slate-50 dark:bg-surface-900/60 text-sm text-slate-750 dark:text-slate-200 outline-none focus:border-primary-500 dark:focus:border-primary-400 focus:bg-white dark:focus:bg-surface-850 transition-all duration-200"
              />
            </div>

            {/* Download limit */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Hash className="w-4 h-4 text-slate-450" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Max downloads</span>
              </div>
              <input
                type="number"
                placeholder="Unlimited"
                min="1"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-800 bg-slate-50 dark:bg-surface-900/60 text-sm text-slate-750 dark:text-slate-200 outline-none focus:border-primary-500 dark:focus:border-primary-400 focus:bg-white dark:focus:bg-surface-850 transition-all duration-200"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-surface-200 dark:border-surface-800">
            {hasExistingShare ? (
              <>
                <button onClick={revokeShareLink} className="flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-600 transition-colors cursor-pointer select-none">
                  <Trash2 className="w-3.5 h-3.5" />
                  Revoke link
                </button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-secondary">Close</button>
                  <button onClick={updateShareSettings} className="btn-primary">
                    Update Settings
                  </button>
                </div>
              </>
            ) : (
              <>
                <div />
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-secondary">Cancel</button>
                  <button onClick={createShareLink} disabled={loading} className="btn-primary">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                    Create Link
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
