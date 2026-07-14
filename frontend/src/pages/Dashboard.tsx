/**
 * TeleDrive — Dashboard Page (Enhanced)
 *
 * Rich premium dashboard with stats cards, storage breakdown bar chart,
 * quick access starred files, and recent uploads.
 */

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileStack,
  FolderOpen,
  HardDrive,
  Star,
  Upload,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  File,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { formatBytes, formatDate, getFileCategory } from '../utils/helpers';
import type { StatsData, TDFile } from '../types';
import FilePreview from '../components/files/FilePreview';

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [starredFiles, setStarredFiles] = useState<TDFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewFile, setPreviewFile] = useState<TDFile | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const [statsRes, searchRes] = await Promise.all([
        api.get('/stats'),
        api.get('/search', { params: { starred: true } }),
      ]);

      if (statsRes.data.success) {
        setStats(statsRes.data.data);
      }
      if (searchRes.data.success) {
        setStarredFiles(searchRes.data.data.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch dashboard stats:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();

    const handleUploadComplete = () => {
      fetchStats();
    };

    window.addEventListener('teledrive:upload-complete', handleUploadComplete);
    return () => {
      window.removeEventListener('teledrive:upload-complete', handleUploadComplete);
    };
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const maxStorage = 15 * 1024 * 1024 * 1024; // 15 GB
  const totalStorage = stats?.totalStorage || 0;
  const storagePercent = Math.min((totalStorage / maxStorage) * 100, 100);

  const statCards = [
    {
      icon: FileStack,
      label: 'Total Files',
      value: stats?.totalFiles?.toLocaleString() || '0',
      color: 'from-primary-500 to-indigo-600',
      bgColor: 'bg-primary-50 dark:bg-primary-900/20',
    },
    {
      icon: FolderOpen,
      label: 'Total Folders',
      value: stats?.totalFolders?.toLocaleString() || '0',
      color: 'from-accent-500 to-cyan-600',
      bgColor: 'bg-cyan-500/10',
    },
    {
      icon: HardDrive,
      label: 'Storage Used',
      value: formatBytes(totalStorage),
      color: 'from-emerald-500 to-teal-600',
      bgColor: 'bg-emerald-550/10 dark:bg-emerald-950/20',
    },
    {
      icon: Star,
      label: 'Starred Files',
      value: starredFiles.length.toString(),
      color: 'from-amber-500 to-orange-650',
      bgColor: 'bg-amber-500/10',
    },
  ];

  // Group by category for visual breakdown
  const categoryBreakdown = {
    image: { size: 0, count: 0, color: 'bg-amber-500' },
    video: { size: 0, count: 0, color: 'bg-red-500' },
    audio: { size: 0, count: 0, color: 'bg-purple-500' },
    document: { size: 0, count: 0, color: 'bg-blue-500' },
    other: { size: 0, count: 0, color: 'bg-slate-400' },
  };

  if (stats?.fileTypeDistribution) {
    stats.fileTypeDistribution.forEach((item) => {
      const cat = getFileCategory('', item.extension) as keyof typeof categoryBreakdown;
      if (categoryBreakdown[cat]) {
        categoryBreakdown[cat].size += item.total_size;
        categoryBreakdown[cat].count += item.count;
      } else {
        categoryBreakdown['other'].size += item.total_size;
        categoryBreakdown['other'].count += item.count;
      }
    });
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">
      {/* Welcome header */}
      <motion.div variants={itemVariants} className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-1">Welcome back to your Telegram-powered cloud storage</p>
        </div>
      </motion.div>

      {/* Stat cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <motion.div key={card.label} variants={itemVariants} className="stat-card">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl ${card.bgColor} flex items-center justify-center`}>
                <card.icon className={`w-5 h-5 bg-gradient-to-r ${card.color} bg-clip-text`} style={{ color: 'var(--color-primary-500)' }} />
              </div>
              <div>
                <p className="text-xs text-slate-400 font-medium">{card.label}</p>
                <p className="text-xl font-bold text-slate-800 dark:text-white">{card.value}</p>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Storage & Quick Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Storage card */}
        <motion.div variants={itemVariants} className="stat-card lg:col-span-2 flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-emerald-500" />
                Cloud Storage Summary
              </h2>
              <span className="text-xs font-medium text-slate-500">{storagePercent.toFixed(1)}% full</span>
            </div>
            <div className="h-4 w-full bg-slate-100 dark:bg-surface-800 rounded-full overflow-hidden flex mb-4">
              {Object.entries(categoryBreakdown).map(([name, data]) => {
                const segmentWidth = totalStorage > 0 ? (data.size / totalStorage) * 100 : 0;
                if (segmentWidth === 0) return null;
                return (
                  <div
                    key={name}
                    className={`h-full ${data.color}`}
                    style={{ width: `${segmentWidth}%` }}
                    title={`${name.toUpperCase()}: ${formatBytes(data.size)}`}
                  />
                );
              })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {Object.entries(categoryBreakdown).map(([name, data]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${data.color} shrink-0`} />
                  <div>
                    <p className="text-[10px] text-slate-400 capitalize font-medium">{name}</p>
                    <p className="text-xs font-bold text-slate-750 dark:text-slate-200">
                      {formatBytes(data.size)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 border-t border-surface-150 dark:border-surface-800 mt-4 flex items-center justify-between text-xs text-slate-400">
            <span>{formatBytes(totalStorage)} of {formatBytes(maxStorage)} total</span>
            <button onClick={() => navigate('/drive')} className="text-primary-500 hover:text-primary-650 flex items-center gap-0.5">
              Browse files <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </motion.div>

        {/* Quick File type stats */}
        <motion.div variants={itemVariants} className="stat-card">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4 text-primary-500" />
            Active Extensions
          </h2>
          <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
            {(stats?.fileTypeDistribution || []).slice(0, 5).map((item) => (
              <div key={item.extension} className="flex justify-between items-center text-xs p-1.5 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800/40">
                <span className="font-mono bg-slate-100 dark:bg-surface-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-350">
                  .{item.extension}
                </span>
                <span className="text-slate-400">{item.count} files</span>
                <span className="font-semibold text-slate-750 dark:text-slate-200">
                  {formatBytes(item.total_size)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Pinned/Starred Quick Access */}
      {starredFiles.length > 0 && (
        <motion.div variants={itemVariants} className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            <Star className="w-4 h-4 text-amber-500 fill-amber-100" />
            Starred & Pinned Files
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {starredFiles.slice(0, 4).map((file) => (
              <div
                key={file.id}
                onClick={() => setPreviewFile(file)}
                className="flex items-center gap-3 p-3 rounded-2xl border border-surface-200 dark:border-surface-700/60 bg-white/70 dark:bg-surface-850/65 cursor-pointer hover:shadow-md transition-all hover:scale-[1.01]"
              >
                <div className="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
                  <FileIcon category={getFileCategory(file.mime_type, file.extension)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-250 truncate">{file.name}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{formatBytes(file.size)}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Recent uploads */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div variants={itemVariants} className="stat-card">
          <div className="flex items-center gap-2 mb-4">
            <Upload className="w-4 h-4 text-primary-500" />
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Recent Uploads
            </h2>
          </div>
          <div className="space-y-2">
            {(stats?.recentUploads || []).slice(0, 5).map((file) => (
              <div
                key={file.id}
                onClick={() => setPreviewFile(file)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800/50 transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-700/50 flex items-center justify-center shrink-0">
                  <FileIcon category={getFileCategory(file.mime_type, file.extension)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 dark:text-slate-200 truncate">{file.name}</p>
                  <p className="text-[11px] text-slate-400">{formatDate(file.created_at)}</p>
                </div>
                <span className="text-xs text-slate-450">{formatBytes(file.size)}</span>
              </div>
            ))}
            {(!stats?.recentUploads || stats.recentUploads.length === 0) && (
              <p className="text-sm text-slate-400 text-center py-4">No recent uploads</p>
            )}
          </div>
        </motion.div>

        {/* Largest files */}
        <motion.div variants={itemVariants} className="stat-card">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive className="w-4 h-4 text-accent-500" />
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Largest Files
            </h2>
          </div>
          <div className="space-y-2">
            {(stats?.largestFiles || []).slice(0, 5).map((file) => (
              <div
                key={file.id}
                onClick={() => setPreviewFile(file)}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800/50 transition-colors cursor-pointer"
              >
                <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-700/50 flex items-center justify-center shrink-0">
                  <FileIcon category={getFileCategory(file.mime_type, file.extension)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 dark:text-slate-200 truncate">{file.name}</p>
                  <p className="text-[11px] text-slate-400">{formatDate(file.created_at)}</p>
                </div>
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {formatBytes(file.size)}
                </span>
              </div>
            ))}
            {(!stats?.largestFiles || stats.largestFiles.length === 0) && (
              <p className="text-sm text-slate-400 text-center py-4">No files yet</p>
            )}
          </div>
        </motion.div>
      </div>

      {/* Preview modal overlay */}
      <AnimatePresence>
        {previewFile && (
          <FilePreview
            file={previewFile}
            files={[previewFile]}
            onClose={() => setPreviewFile(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function FileIcon({ category }: { category: string }) {
  const cls = 'w-4 h-4';
  switch (category) {
    case 'image': return <FileImage className={`${cls} text-amber-500`} />;
    case 'video': return <FileVideo className={`${cls} text-red-500`} />;
    case 'audio': return <FileAudio className={`${cls} text-purple-500`} />;
    case 'pdf': return <FileText className={`${cls} text-red-500`} />;
    case 'code': return <FileCode className={`${cls} text-blue-500`} />;
    case 'text': return <FileText className={`${cls} text-slate-550`} />;
    default: return <File className={`${cls} text-slate-400`} />;
  }
}
