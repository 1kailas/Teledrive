/**
 * TeleDrive — Recent Files Page
 */

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Clock, Loader2, Trash2 } from 'lucide-react';
import api from '../services/api';
import { useUIStore } from '../stores';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import type { TDFile } from '../types';

export default function Recent() {
  const [files, setFiles] = useState<TDFile[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode } = useUIStore();
  const { downloadFile } = useDownload();

  useEffect(() => {
    async function fetch() {
      try {
        const res = await api.get('/recent');
        if (res.data.success) setFiles(res.data.data || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, []);

  const clearHistory = async () => {
    try {
      await api.delete('/recent');
      setFiles([]);
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-48"><Loader2 className="w-8 h-8 text-primary-500 animate-spin" /></div>;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Recent</h1>
          <p className="text-sm text-slate-400 mt-1">Recently accessed files</p>
        </div>
        {files.length > 0 && (
          <button onClick={clearHistory} className="btn-ghost text-xs text-error-500">
            <Trash2 className="w-3.5 h-3.5" />
            Clear history
          </button>
        )}
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-slate-400">
          <Clock className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">No recent files</p>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
          {files.map((f) => (
            <FileCard key={f.id} file={f} viewMode={viewMode} onDoubleClick={() => downloadFile(f.id)} />
          ))}
        </div>
      )}
    </motion.div>
  );
}
