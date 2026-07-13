/**
 * TeleDrive — Favorites Page
 */

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Star, Loader2 } from 'lucide-react';
import api from '../services/api';
import { useUIStore } from '../stores';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import type { TDFile } from '../types';

export default function Favorites() {
  const [files, setFiles] = useState<TDFile[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode } = useUIStore();
  const { downloadFile } = useDownload();

  const fetchFavorites = async () => {
    try {
      const res = await api.get('/favorites');
      if (res.data.success) {
        setFiles(res.data.data.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch favorites:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchFavorites(); }, []);

  const handleUnfavorite = async (file: TDFile) => {
    try {
      await api.patch(`/files/${file.id}`, { isFavorite: false });
      fetchFavorites();
    } catch (err) {
      console.error('Failed to unfavorite:', err);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-48"><Loader2 className="w-8 h-8 text-primary-500 animate-spin" /></div>;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Favorites</h1>
        <p className="text-sm text-slate-400 mt-1">Your starred files</p>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-slate-400">
          <Star className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">No favorites yet</p>
          <p className="text-xs text-slate-300 mt-1">Star files to find them quickly</p>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
          {files.map((f) => (
            <FileCard
              key={f.id}
              file={f}
              viewMode={viewMode}
              onFavorite={handleUnfavorite}
              onDoubleClick={() => downloadFile(f.id)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}
