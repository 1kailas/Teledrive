/**
 * TeleDrive — Search Page
 */

import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Search as SearchIcon, Filter, Loader2, X } from 'lucide-react';
import api from '../services/api';
import { useUIStore } from '../stores';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import FolderCard from '../components/files/FolderCard';
import type { TDFile, TDFolder } from '../types';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';

  const [query, setQuery] = useState(q);
  const [files, setFiles] = useState<TDFile[]>([]);
  const [folders, setFolders] = useState<TDFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [extFilter, setExtFilter] = useState('');

  const { viewMode } = useUIStore();
  const { downloadFile } = useDownload();

  useEffect(() => {
    if (q) {
      search(q);
    }
  }, [q]);

  const search = async (searchQuery: string) => {
    setLoading(true);
    try {
      const params: Record<string, string> = { q: searchQuery };
      if (extFilter) params.ext = extFilter;

      const res = await api.get('/search', { params });
      if (res.data.success) {
        setFiles(res.data.data.files || []);
        setFolders(res.data.data.folders || []);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      setSearchParams({ q: query.trim() });
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Search</h1>
        <p className="text-sm text-slate-400 mt-1">Find files and folders</p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="search-bar flex-1">
          <SearchIcon className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            placeholder="Search by name, extension..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent outline-none text-sm text-slate-700 dark:text-slate-200"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(''); setFiles([]); setFolders([]); }}>
              <X className="w-4 h-4 text-slate-400" />
            </button>
          )}
        </div>
        <button type="submit" className="btn-primary">Search</button>
        <button type="button" onClick={() => setShowFilters(!showFilters)} className="btn-secondary">
          <Filter className="w-4 h-4" />
        </button>
      </form>

      {/* Filters */}
      {showFilters && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Extension:</label>
            <input
              type="text"
              placeholder="e.g. pdf"
              value={extFilter}
              onChange={(e) => setExtFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none w-20"
            />
          </div>
        </motion.div>
      )}

      {/* Results */}
      {loading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
        </div>
      )}

      {!loading && q && files.length === 0 && folders.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 text-slate-400">
          <SearchIcon className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">No results for "{q}"</p>
        </div>
      )}

      {folders.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Folders</h3>
          <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
            {folders.map((f) => <FolderCard key={f.id} folder={f} viewMode={viewMode} />)}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
            Files ({files.length})
          </h3>
          <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
            {files.map((f) => (
              <FileCard key={f.id} file={f} viewMode={viewMode} onDoubleClick={() => downloadFile(f.id)} />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
