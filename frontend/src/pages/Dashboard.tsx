/**
 * TeleDrive — Dashboard Page
 *
 * Overview with stats cards, charts, and recent files.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FileStack,
  FolderOpen,
  HardDrive,
  TrendingUp,
  Upload,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  File,
} from 'lucide-react';
import api from '../services/api';
import { formatBytes, formatDate, getFileCategory } from '../utils/helpers';
import type { StatsData, TDFile } from '../types';

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

export default function Dashboard() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await api.get('/stats');
        if (res.data.success) {
          setStats(res.data.data);
        }
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const statCards = [
    {
      icon: FileStack,
      label: 'Total Files',
      value: stats?.totalFiles?.toLocaleString() || '0',
      color: 'from-primary-500 to-primary-600',
      bgColor: 'bg-primary-50 dark:bg-primary-900/20',
    },
    {
      icon: FolderOpen,
      label: 'Total Folders',
      value: stats?.totalFolders?.toLocaleString() || '0',
      color: 'from-accent-500 to-accent-600',
      bgColor: 'bg-accent-500/10',
    },
    {
      icon: HardDrive,
      label: 'Storage Used',
      value: formatBytes(stats?.totalStorage || 0),
      color: 'from-success-500 to-emerald-600',
      bgColor: 'bg-success-500/10',
    },
    {
      icon: TrendingUp,
      label: 'File Types',
      value: stats?.fileTypeDistribution?.length?.toString() || '0',
      color: 'from-warning-500 to-orange-600',
      bgColor: 'bg-warning-500/10',
    },
  ];

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">
      {/* Page title */}
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Welcome back to your personal cloud</p>
      </motion.div>

      {/* Stat cards */}
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

      {/* File type distribution */}
      {stats?.fileTypeDistribution && stats.fileTypeDistribution.length > 0 && (
        <motion.div variants={itemVariants} className="stat-card">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">
            File Type Distribution
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {stats.fileTypeDistribution.slice(0, 10).map((item) => (
              <div
                key={item.extension}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-surface-50 dark:bg-surface-800/50"
              >
                <span className="text-xs font-bold uppercase text-primary-500 w-10">
                  .{item.extension}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {item.count} files
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {formatBytes(item.total_size)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Recent uploads + largest files */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent uploads */}
        <motion.div variants={itemVariants} className="stat-card">
          <div className="flex items-center gap-2 mb-4">
            <Upload className="w-4 h-4 text-primary-500" />
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Recent Uploads
            </h2>
          </div>
          <div className="space-y-2">
            {(stats?.recentUploads || []).slice(0, 5).map((file) => (
              <FileRow key={file.id} file={file} />
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
              <FileRow key={file.id} file={file} showSize />
            ))}
            {(!stats?.largestFiles || stats.largestFiles.length === 0) && (
              <p className="text-sm text-slate-400 text-center py-4">No files yet</p>
            )}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function FileRow({ file, showSize }: { file: TDFile; showSize?: boolean }) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800/50 transition-colors">
      <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-700/50 flex items-center justify-center shrink-0">
        <FileIcon category={getFileCategory(file.mime_type, file.extension)} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 dark:text-slate-200 truncate">{file.name}</p>
        <p className="text-[11px] text-slate-400">
          {showSize ? formatBytes(file.size) : formatDate(file.created_at)}
        </p>
      </div>
      {showSize && (
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
          {formatBytes(file.size)}
        </span>
      )}
    </div>
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
    case 'text': return <FileText className={`${cls} text-slate-500`} />;
    default: return <File className={`${cls} text-slate-400`} />;
  }
}
