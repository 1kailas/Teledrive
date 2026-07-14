/**
 * TeleDrive — Shared Files Page
 *
 * Lists all files with active share links.
 * Allows managing and revoking shares.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Link2,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  Loader2,
  Calendar,
  Download,
  Shield,
  FileIcon,
} from 'lucide-react';
import api from '../services/api';
import { useToastStore } from '../stores';
import { formatBytes, formatDate } from '../utils/helpers';
import type { ShareLink } from '../types';

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.04 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

export default function Shared() {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { addToast } = useToastStore();

  useEffect(() => {
    const fetchLinks = async () => {
      try {
        const res = await api.get('/share/links');
        if (res.data.success) {
          setLinks(res.data.data || []);
        }
      } catch {
        addToast('error', 'Failed to load shared links');
      } finally {
        setLoading(false);
      }
    };
    fetchLinks();
  }, [addToast]);

  const revokeLink = useCallback(async (fileId: string) => {
    try {
      await api.delete(`/share/${fileId}`);
      setLinks((prev) => prev.filter((l) => l.file_id !== fileId));
      addToast('success', 'Share link revoked');
    } catch {
      addToast('error', 'Failed to revoke link');
    }
  }, [addToast]);

  const copyLink = useCallback(async (token: string, id: string) => {
    const url = `${window.location.origin}/shared/${token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopiedId(id);
    addToast('success', 'Link copied');
    setTimeout(() => setCopiedId(null), 2000);
  }, [addToast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
      </div>
    );
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Shared Files</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage files you've shared with public links
        </p>
      </motion.div>

      {links.length === 0 ? (
        <motion.div variants={itemVariants} className="flex flex-col items-center justify-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-primary-50 dark:bg-primary-900/20 flex items-center justify-center mb-4">
            <Link2 className="w-8 h-8 text-primary-400" />
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">No shared files yet</p>
          <p className="text-xs text-slate-400 mt-1">Right-click on a file and select "Share link" to get started</p>
        </motion.div>
      ) : (
        <motion.div variants={containerVariants} className="space-y-3">
          {links.map((link) => (
            <motion.div
              key={link.id}
              variants={itemVariants}
              className="stat-card flex items-center gap-4"
            >
              {/* File icon */}
              <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-900/20 flex items-center justify-center shrink-0">
                <FileIcon className="w-5 h-5 text-primary-500" />
              </div>

              {/* File info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                  {link.file_name || 'Unknown file'}
                </p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-slate-400">{formatBytes(link.file_size || 0)}</span>
                  {link.password_hash && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-500">
                      <Shield className="w-3 h-3" />
                      Protected
                    </span>
                  )}
                  {link.expires_at && (
                    <span className="flex items-center gap-1 text-[10px] text-slate-400">
                      <Calendar className="w-3 h-3" />
                      Expires {formatDate(link.expires_at)}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-[10px] text-slate-400">
                    <Download className="w-3 h-3" />
                    {link.download_count} downloads
                    {link.max_downloads && ` / ${link.max_downloads} max`}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => copyLink(link.token, link.id)}
                  className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                  title="Copy link"
                >
                  {copiedId === link.id ? (
                    <Check className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <Copy className="w-4 h-4 text-slate-400" />
                  )}
                </button>
                <a
                  href={`${window.location.origin}/shared/${link.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                  title="Open link"
                >
                  <ExternalLink className="w-4 h-4 text-slate-400" />
                </a>
                <button
                  onClick={() => revokeLink(link.file_id)}
                  className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Revoke link"
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                </button>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}
    </motion.div>
  );
}
